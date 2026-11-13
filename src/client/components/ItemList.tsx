/** Fixed-height virtualized item list with group headers and read-on-scroll. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../react.js'
import type { ReactNode } from '../react.js'
import {
  Button,
  IconChevronDownOutlineRegular,
  Menu,
  MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { AT_TOP, GROUP_H, ROW_H, ROW_H_PLAIN } from '../constants.js'
import { entriesOf, exhaustedGroups, folderNames } from '../derive.js'
import type { Entry, GroupEntry } from '../derive.js'
import { groupFloorOf, offsetIndex, scrollAfterRebuild, scrollReads, settledAbove, windowOf } from '../window.js'
import type { ItemListProps, MarkScope } from '../types.js'
import { fmtTime } from '../util.js'
import { IconStar } from '../icons.js'
import { EmptyState, IconButton } from './Controls.js'
import { FolderMenu } from './FolderMenu.js'

/** One menu row: the scope label on the left and what it would touch on the right. */
function scopeLabel(label: string, n: number) {
  return (
    <span className="gf-menu-row">
      <span>{label}</span>
      <span className="gf-menu-count">{String(n)}</span>
    </span>
  )
}

/** How long a finished section fades before the list is rebuilt without it. */
const FADE_MS = 380
/** Rows the first paint fakes: more than any pane of this list holds. */
const SKELETON_ROWS = 8

/**
 * Row-shaped blocks at the height the rows will have, so the first paint does
 * not jump when the page lands.
 * @param props.height - the row height the list is about to use.
 * @param props.digest - whether the rows will carry a digest line.
 * @param props.label - what the loading state is called, for a screen reader.
 * @returns the placeholder rows.
 */
function Skeleton({ height, digest, label }: { height: number; digest: boolean; label: string }) {
  return (
    <div className="gf-skel" role="status" aria-label={label}>
      {Array.from({ length: SKELETON_ROWS }, function (_, i) {
        return (
          <div key={i} className="gf-skel-row" style={{ height: height }}>
            <div className="gf-skel-line" style={{ width: '62%' }} />
            <div className="gf-skel-line" style={{ width: '34%' }} />
            {digest ? <div className="gf-skel-line" style={{ width: '88%' }} /> : null}
          </div>
        )
      })}
    </div>
  )
}
/**
 * Read rows above the band before a scroll releases them in one batch. One
 * rebuild per row would re-derive the whole archive every 66 pixels; this is
 * roughly a screen and a half of slack.
 */
const TRIM_AT = 24

export function ItemList({ state, controller, t, wide }: ItemListProps) {
  const list = controller.getList()
  const groupBy = state.groupBy || state.reader.groupBy || 'none'
  const markOnScroll = state.markOnScroll === null ? state.reader.markReadOnScroll : state.markOnScroll
  const showDigest = state.showDigest === null ? true : state.showDigest
  const rowH = showDigest ? ROW_H : ROW_H_PLAIN
  const viewportRef = useRef<HTMLDivElement>(null)
  /** The scroll offset the mounted band is drawn for. */
  const [top, setTop] = useState(0)
  /** The viewport's own height: the end screen is exactly one of them. */
  const [viewportH, setViewportH] = useState(0)
  /** The scroll offset as the DOM has it — a render cannot read the element. */
  const topRef = useRef(0)
  /** Where the list was last drawn from, so a rebuild can put the edge back. */
  const drawn = useRef<{ entries: Entry[]; offsets: number[]; scope: string } | null>(null)
  /** Whether the viewport has left the top since a refresh held rows for it. */
  const leftTop = useRef(false)
  const raf = useRef(0)
  /** The row the reader was last moved to, so a rebuild does not drag them off it. */
  const lastSelected = useRef<string | null>(null)
  /** The rows that have been on screen, and since when. */
  const seen = useRef<Map<string, number>>(new Map())
  /** The scope menu for marking read; it shows its counts before acting. */
  const [markOpen, setMarkOpen] = useState(false)
  /** Only the whole-library entry needs a second, differently placed click. */
  const [markArmed, setMarkArmed] = useState(false)
  /** The feed whose section header is asking before unsubscribing. */
  const [pendingUnsub, setPendingUnsub] = useState<string | null>(null)
  function closeMark() {
    setMarkOpen(false)
    setMarkArmed(false)
  }

  /** Counts for the mark menu; recomputed when the list or the read set moves. */
  const counts = useMemo(function () {
    return controller.markCounts()
  }, [state.items, state.read, state.version, state.listEpoch, state.feedId, state.query, state.filter, controller])

  const entries = useMemo<Entry[]>(function () {
    return entriesOf(
      list,
      groupBy,
      rowH,
      GROUP_H,
      function (id) { return controller.feedTitle(id) },
      function (id) { return controller.feedFolder(id) },
    )
  }, [list, groupBy, controller, rowH])

  const offsets = useMemo(function () {
    return offsetIndex(entries)
  }, [entries])

  /** Which group entry covers each entry, so a section header can stay mounted. */
  const groupFloor = useMemo(function () {
    return groupFloorOf(entries)
  }, [entries])

  const itemIndex = useMemo(function () {
    const map = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (entry.kind === 'row') map.set(entry.item.id, i)
    }
    return map
  }, [entries])

  const total = offsets[entries.length] || 0
  const height = viewportH || 600
  /** What the list is a list *of*: a change here is a new list, not a rebuild. */
  const scopeKey = `${groupBy}\u0000${state.query}\u0000${state.feedId || ''}`

  /**
   * The band this render draws. It is derived, never stored: the entries and
   * the scroll offset are the same render's, so a rebuild cannot paint rows
   * that describe the list it replaced.
   */
  const band = useMemo(function () {
    return windowOf({ entries: entries, offsets: offsets, groupFloor: groupFloor, top: top, height: height, groupBy: groupBy })
  }, [entries, offsets, groupFloor, top, height, groupBy])

  /**
   * The list's side effects for one viewport pass: the rows the scroll read,
   * the rows it can let go, and whether a held arrival may land. The band is
   * not one of them — it comes from the render that carries the offset.
   * @param at - the scroll offset this pass is about.
   * @param h - the viewport height at that offset.
   */
  const settle = useCallback(function (at: number, h: number) {
    // Held arrivals land when the reader leaves the top and comes back. Sitting
    // at the top is not leaving it: the rows would push the one being read down.
    if (at <= AT_TOP) {
      if (leftTop.current) {
        leftTop.current = false
        controller.releaseHeld()
      }
    } else {
      leftTop.current = true
    }
    // Rows above the band that were read on the way here were kept only so the
    // list would not move; the anchor holds the position now. A flat list has
    // no section to fade them out, so the band is what lets them go.
    if (state.filter === 'unread') {
      const next = windowOf({ entries: entries, offsets: offsets, groupFloor: groupFloor, top: at, height: h, groupBy: groupBy })
      const settled = settledAbove(entries, next.start, state.read)
      if (settled.length >= TRIM_AT) controller.trimSticky(settled)
    }
    // A row counts as read once it has been on screen long enough to be seen
    // and the viewport has scrolled past it; with the preference off, nothing
    // is timed and nothing is marked. This pass runs on a rebuild as well as on
    // a scroll, which is why only a row the band carried over is read: rows a
    // rebuild pushed down were never scrolled past.
    if (!markOnScroll) {
      seen.current.clear()
      return
    }
    for (const id of seen.current.keys()) {
      if (!itemIndex.has(id) || state.read.has(id)) seen.current.delete(id)
    }
    const reads = scrollReads({
      entries: entries,
      offsets: offsets,
      index: itemIndex,
      top: at,
      height: h,
      seen: seen.current,
      read: state.read,
      now: window.performance.now(),
    })
    for (const row of reads.entering) seen.current.set(row[0], row[1])
    for (const id of reads.leaving) seen.current.delete(id)
    // Implicit marks keep their rows: a row must not vanish from under the
    // pointer. The section releases them once it has nothing unread left.
    if (reads.readIds.length) void controller.mark(reads.readIds, true, true)
  }, [entries, offsets, groupFloor, groupBy, itemIndex, markOnScroll, state.read, state.filter, controller])

  // A rebuild, or a scope change, has to be dealt with before it is painted:
  // the scroll offset is the one part of the band a render cannot answer for.
  // The band is derived from the render that carries the corrected offset, so
  // the frame that reaches the screen is already consistent — the failure this
  // replaces was one painted frame of the old band, then a correction.
  useLayoutEffect(function () {
    // A list with rows on it is a position to protect, at the top as much as in
    // the middle: a row inserted above the reader pushes the reader down.
    controller.setHold(list.length > 0)
    const el = viewportRef.current
    if (!el) {
      // No viewport is on screen (loading, empty, or failed): there is no
      // position to hold, so the next list that appears starts at its own top.
      drawn.current = null
      return
    }
    const h = el.clientHeight || height
    const previous = drawn.current
    let target = topRef.current
    if (!previous) {
      target = el.scrollTop
    } else if (previous.scope !== scopeKey) {
      // A new filter, search, or source is a new list: it starts at its own top.
      target = 0
      seen.current.clear()
      leftTop.current = false
    } else if (previous.entries !== entries) {
      target = scrollAfterRebuild({
        prev: previous.entries,
        prevOffsets: previous.offsets,
        next: entries,
        nextOffsets: offsets,
        top: topRef.current,
        height: h,
        groupBy: groupBy,
      })
    }
    // A row the keyboard moved to is an explicit act: bring it into view, even
    // if the rebuild would have held the old position.
    const selected = state.current
    if (selected !== lastSelected.current) {
      lastSelected.current = selected
      const index = selected ? itemIndex.get(selected) : undefined
      if (index !== undefined) {
        const shown = windowOf({ entries: entries, offsets: offsets, groupFloor: groupFloor, top: target, height: h, groupBy: groupBy })
        if (index < shown.start || index >= shown.end) target = Math.max(0, (offsets[index] || 0) - 32)
      }
    }
    if (el.scrollTop !== target) el.scrollTop = target
    // The browser clamps past the end of the list; what it kept is where the
    // band has to be drawn.
    const settled = el.scrollTop
    topRef.current = settled
    if (settled !== top) setTop(settled)
    if (el.clientHeight !== viewportH) setViewportH(el.clientHeight)
    drawn.current = { entries: entries, offsets: offsets, scope: scopeKey }
    settle(settled, h)
  }, [entries, offsets, groupFloor, groupBy, top, viewportH, state.current, list, controller, scopeKey, settle, itemIndex])

  const onScroll = useCallback(function (event: { currentTarget: HTMLDivElement }) {
    const el = event.currentTarget
    topRef.current = el.scrollTop
    if (raf.current) return
    raf.current = requestAnimationFrame(function () {
      raf.current = 0
      const node = viewportRef.current
      if (!node) return
      const at = node.scrollTop
      topRef.current = at
      const h = node.clientHeight || height
      const next = windowOf({ entries: entries, offsets: offsets, groupFloor: groupFloor, top: at, height: h, groupBy: groupBy })
      // Re-render only when the band moves, or when the viewport crosses the
      // top: the overscan covers the rows between one band and the next, and
      // the top is what says whether a held arrival may land or the pill shows.
      const crossed = (at <= AT_TOP) !== (top <= AT_TOP)
      if (crossed || next.start !== band.start || next.end !== band.end || next.headerIndex !== band.headerIndex) setTop(at)
      settle(at, h)
    })
  }, [band, entries, offsets, groupFloor, groupBy, height, top, settle])

  useEffect(function () {
    return function () {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = 0
    }
  }, [])

  useEffect(function () {
    const el = viewportRef.current
    if (!el) return
    let alive = true
    const observer = new ResizeObserver(function () {
      if (!alive) return
      const node = viewportRef.current
      if (!node) return
      setViewportH(function (current) { return current === node.clientHeight ? current : node.clientHeight })
    })
    observer.observe(el)
    return function () {
      alive = false
      observer.disconnect()
    }
  }, [])

  /**
   * Sections whose unread rows have all been read: they are kept on screen only
   * so nothing moves under the pointer, so they fade where they stand and the
   * list is rebuilt without them once the fade is done.
   */
  // The section the open article is in keeps its rows, even once nothing in it
  // is unread: the reader is looking at that row, and fading it out under the
  // click is the one movement opening an article should not cause. The section
  // leaves when the reader closes the article or moves to another one.
  const holdKey = useMemo(function () {
    if (!state.current) return null
    const index = itemIndex.get(state.current)
    if (index === undefined) return null
    const floor = groupFloor[index]
    if (floor < 0) return null
    const header = entries[floor]
    return header.kind === 'group' ? header.group.key : null
  }, [state.current, itemIndex, groupFloor, entries])
  const finished = useMemo(function () {
    return exhaustedGroups(entries, state.read, state.filter, holdKey)
  }, [entries, state.read, state.filter, holdKey])
  const finishedKey = finished.join('\u0000')
  const finishedSet = new Set(finished)
  useEffect(function () {
    if (!finishedKey) return
    const timer = setTimeout(function () {
      const ids: string[] = []
      for (const entry of entries) {
        if (entry.kind !== 'group' || !finishedSet.has(entry.group.key)) continue
        for (const item of entry.group.items) ids.push(item.id)
      }
      if (ids.length) controller.releaseSticky(ids)
    }, FADE_MS)
    return function () { clearTimeout(timer) }
  }, [finishedKey, controller])

  /** Whether the entry at one index belongs to a section that is leaving. */
  function leaving(index: number): boolean {
    if (!finishedSet.size) return false
    const floor = groupFloor[index]
    if (floor < 0) return false
    const header = entries[floor]
    return header.kind === 'group' && finishedSet.has(header.group.key)
  }

  const slice = entries.slice(band.start, band.end)
  /** The rows above and below the mounted band, kept as spacers of their height. */
  const lead = offsets[band.start] || 0
  const trail = Math.max(0, total - (offsets[band.end] || total))
  /** The section header covering the band while it sits above the mounted rows. */
  const pinned = band.headerIndex === null ? undefined : entries[band.headerIndex]

  /**
   * One section header: its name, and the things done *while reading a feed* —
   * move it to another folder, mark the section read, and stop following it. A
   * folder section can only be marked. The same markup renders in place and
   * pinned at the top of the band, so the pinned bar never drifts from the row
   * it stands for.
   * @param entry - the section header entry.
   * @returns the header's children.
   */
  function sectionHeader(entry: GroupEntry) {
    const groupUnread = entry.group.items.filter(function (item) { return !state.read.has(item.id) }).length
    const feedId = groupBy === 'feed' ? entry.group.key : ''
    const feed = feedId ? state.feedMap.get(feedId) || null : null
    const confirming = feedId !== '' && pendingUnsub === feedId
    return (
      <>
        <span className="gf-group-name">
          {confirming ? t('confirm.unsubscribe') : entry.group.label}
        </span>
        <div className="gf-group-actions">
          {confirming
            ? [
              <Button
                key="cancel"
                variant="ghost"
                size="sm"
                className="gf-group-read"
                onClick={function () { setPendingUnsub(null) }}
              >
                {t('action.cancel')}
              </Button>,
              <Button
                key="remove"
                variant="ghost"
                size="sm"
                className="gf-group-read gf-danger"
                disabled={state.busy.remove}
                title={t('confirm.unsubscribeHint')}
                onClick={function () {
                  setPendingUnsub(null)
                  void controller.removeFeed(feedId)
                }}
              >
                {t('action.remove')}
              </Button>,
            ]
            : [
              // A source's own actions sit together, where unsubscribe already
              // is: the header is the one place a source is acted on without
              // leaving the rows.
              feedId
                ? (
                  <FolderMenu
                    key="move"
                    folder={feed ? feed.folder : null}
                    folders={folderNames(state.feeds)}
                    label={t('action.moveFolder')}
                    t={t}
                    align="end"
                    onMove={function (name) {
                      setPendingUnsub(null)
                      void controller.setFeedFolder(feedId, name)
                    }}
                    trigger={function (picker) {
                      return (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gf-group-read"
                          title={t('action.moveSource')}
                          onClick={picker.toggle}
                        >
                          {t('action.move')}
                        </Button>
                      )
                    }}
                  />
                )
                : null,
              feedId
                ? (
                  <Button
                    key="unsub"
                    variant="ghost"
                    size="sm"
                    className="gf-group-unsub"
                    title={t('confirm.unsubscribeHint')}
                    onClick={function () { setPendingUnsub(feedId) }}
                  >
                    {t('action.remove')}
                  </Button>
                )
                : null,
              <Button
                key="mark"
                variant="ghost"
                size="sm"
                className="gf-group-read"
                disabled={!groupUnread}
                title={t('action.markGroup')}
                onClick={function () { controller.markGroup(entry.group.key) }}
              >
                {groupUnread ? t('action.markGroupCount', { n: groupUnread }) : t('action.markGroup')}
              </Button>,
            ]}
        </div>
      </>
    )
  }

  const listRows = slice.map(function (entry, offset) {
    const gone = leaving(band.start + offset) ? ' gf-fade' : ''
    if (entry.kind === 'group') {
      return (
        <div key={entry.key} className={`gf-group${gone}`}>
          {sectionHeader(entry)}
        </div>
      )
    }
    const item = entry.item
    const unread = !state.read.has(item.id)
    const starred = state.starred.has(item.id)
    const digest = showDigest ? controller.digest(item) : ''
    return (
      <div
        key={entry.key}
        className={`gf-row${unread ? ' unread' : ''}${state.current === item.id ? ' active' : ''}${state.fresh.has(item.id) ? ' gf-row-in' : ''}${gone}`}
      >
        {/* The row is the container; the row's own target is the button, so the
            star beside it is never announced as part of the row's name. */}
        <button
          type="button"
          className="gf-row-main"
          tabIndex={-1}
          aria-current={state.current === item.id ? 'true' : undefined}
          onClick={function () { controller.select(item.id) }}
        >
          <span className="gf-row-title">
            {unread ? <span className="gf-dot" aria-hidden="true" /> : null}
            <span className="t">{item.title || '(untitled)'}</span>
          </span>
          <span className="gf-row-meta">
            {/* Every row under a source section would repeat the name the sticky
                header already carries; only an ungrouped list needs it per row. */}
            {groupBy === 'feed' ? null : <span className="feed-name">{controller.feedTitle(item.feed)}</span>}
            <span className="when">{fmtTime(item.date)}</span>
          </span>
          {digest ? <span className="gf-row-digest">{digest}</span> : null}
        </button>
        {/* The star is an action on the row, not a way into it: it sits on
            every row so an item can be kept without opening the article, and
            it holds its space so the title never re-wraps on hover. */}
        <span className={`gf-row-actions${starred ? ' on' : ''}`}>
          <IconButton
            icon={<IconStar filled={starred} size={13} />}
            label={starred ? t('action.unstar') : t('action.star')}
            small
            active={starred}
            // The rows are reached with j/k, not the tab key; a tab stop per
            // row would put hundreds of them between the reader and the
            // controls that are actually tabbed to.
            tabIndex={-1}
            onClick={function () { controller.toggleStar(item.id) }}
          />
        </span>
      </div>
    )
  })

  const count = list.length
  /**
   * What the header counts: the rows this view has, counted from the archive
   * rather than from the list. A read row stays listed until something else
   * moves the list, so counting the list made the number lag behind the
   * reading — and a refresh that holds its arrivals back would leave them out
   * of the only number that says they are there.
   */
  const remaining = useMemo(function () {
    return controller.countInView()
  }, [state.items, state.read, state.starred, state.filter, state.query, state.feedId, state.listEpoch, controller])
  const paneClass = `gf-listpane${wide ? ' wide' : ''}${showDigest ? '' : ' rows-plain'}`

  // The bar follows the viewport, but the scope is picked from the strongest
  // scope that is actually in effect: a search, then a selected source, then
  // the group under the edge. A source always wins over grouping, so a folder
  // that reaches past the current source can never be marked from inside it,
  // and with neither grouping nor a source the label stays put instead of
  // flipping with every row.
  const scope = useMemo(function (): MarkScope | null {
    if (!count) return null
    const searching = !!state.query.trim()
    // A single source is marked from that source's own row (here or in the
    // feed list), so the bar only speaks for a wider view.
    if (searching) return { kind: 'results', label: t('action.markResults'), n: counts.results }
    if (state.feedId) return null
    return { kind: 'all', label: t('action.markAll'), n: counts.all }
  }, [count, state.query, state.feedId, counts, controller, t])

  function runScope() {
    if (!scope || !scope.n) return
    if (scope.kind === 'all') controller.markEverything()
    else controller.markAll()
  }

  // The button marks the view; the menu holds the one scope the view does not
  // reach — every unread item in the library — and only when that differs.
  const markRows: ReactNode[] = []
  if (counts.all > 0 && counts.all !== (scope ? scope.n : 0)) {
    markRows.push(
      <MenuItemButton
        key="everything"
        danger
        onSelect={function () {
          if (!markArmed) {
            setMarkArmed(true)
            return
          }
          closeMark()
          controller.markEverything()
        }}
      >
        {scopeLabel(markArmed ? t('action.markAllConfirm', { n: counts.all }) : t('action.markEverything'), counts.all)}
      </MenuItemButton>,
    )
  }

  /** Rows a refresh is holding back; they land when the reader asks or moves. */
  const heldCount = controller.heldCount()
  const header = (
    <div className="gf-listbar">
      <span className="gf-count-label">{t('items.count', { n: remaining })}</span>
      {/* At the top, arrivals are held rather than pushing the newest row down.
          This is how they are asked for; anywhere else the reader gets them by
          coming back to the top, which is why the control only appears here. */}
      {heldCount > 0 && top <= AT_TOP
        ? (
          <button
            type="button"
            className="gf-newitems"
            title={t('list.newHint')}
            onClick={function () { controller.releaseHeld() }}
          >
            {t('list.newItems', { n: heldCount })}
          </button>
        )
        : null}
    </div>
  )

  const markBar = !scope
    ? null
    : (
      <div className={`gf-markfloat${scope.n ? '' : ' off'}`}>
        <Button
          variant="ghost"
          size="sm"
          className="gf-markfloat-main"
          disabled={!scope.n}
          title={scope.label}
          onClick={runScope}
        >
          <span className="gf-markfloat-label">{scope.label}</span>
          <span className="gf-markfloat-count">{String(scope.n)}</span>
        </Button>
        {markRows.length > 0
          ? (
            <Menu
              open={markOpen}
              side="top"
              align="end"
              onClose={closeMark}
              className="gf-markfloat-more"
              anchor={(
                <IconButton
                  icon={<IconChevronDownOutlineRegular size={14} />}
                  label={t('action.markPick')}
                  small
                  hasPopup="menu"
                  expanded={markOpen}
                  onClick={function () {
                    if (markOpen) closeMark()
                    else { setMarkOpen(true); setMarkArmed(false) }
                  }}
                />
              )}
            >
              {markRows}
            </Menu>
          )
          : null}
      </div>
    )

  if (state.status === 'loading' && !state.items.length) {
    return (
      <div className={paneClass} aria-busy="true">
        {header}
        <Skeleton height={rowH} digest={showDigest} label={t('status.loading')} />
      </div>
    )
  }
  if (state.status === 'error' && !state.items.length) {
    return (
      <div className={paneClass}>
        {header}
        <EmptyState className="compact" hint={state.error || t('status.error')} />
      </div>
    )
  }
  if (!count) {
    return (
      <div className={paneClass}>
        {header}
        <EmptyState className="compact" hint={state.items.length ? t('empty.nothing') : t('empty.noItems')} />
      </div>
    )
  }

  return (
    <div className={paneClass}>
      {header}
      <div className="gf-scrollwrap">
        <div className="gf-scroll" ref={viewportRef} onScroll={onScroll}>
          <div style={{ height: lead }} />
          {listRows}
          <div style={{ height: trail }} />
          {/* One viewport of scroll past the last row. The rows the list ends
              on could otherwise never leave the viewport, so they stayed
              unread; this is also where the reader learns the list is over. */}
          <div className="gf-endnote" style={{ height: viewportH ? viewportH + 1 : undefined }}>{t('list.end')}</div>
        </div>
        {pinned && pinned.kind === 'group'
          ? (
            <div className={`gf-group gf-group-pinned${finishedSet.has(pinned.group.key) ? ' gf-fade' : ''}`}>
              {sectionHeader(pinned)}
            </div>
          )
          : null}
      </div>
      {markBar}
    </div>
  )
}
