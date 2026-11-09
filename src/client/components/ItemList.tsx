/** Fixed-height virtualized item list with group headers and read-on-scroll. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../react.js'
import type { ReactNode } from '../react.js'
import {
  Button,
  IconChevronDownOutlineRegular,
  Menu,
  MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { GROUP_H, ROW_H, ROW_H_PLAIN } from '../constants.js'
import { entriesOf, exhaustedGroups, folderNames } from '../derive.js'
import type { Entry, GroupEntry } from '../derive.js'
import { groupFloorOf, offsetIndex, scrollReads, settledAbove, windowOf } from '../window.js'
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
  const [range, setRange] = useState<{ start: number; end: number; headerIndex: number | null }>({ start: 0, end: 24, headerIndex: null })
  const rangeRef = useRef(range)
  rangeRef.current = range
  const raf = useRef(0)
  const lastKey = useRef('')
  const lastSelected = useRef<string | null>(null)
  /** The rows that have been on screen, and since when. */
  const seen = useRef<Map<string, number>>(new Map())
  /** Pending pass for the rows held at the end of the list, or 0. */
  const restTimer = useRef(0)
  /** The latest pass, for the dwell timer to call without a stale closure. */
  const computeRef = useRef<() => void>(function () { /* no pass to run yet */ })
  /**
   * The entry at the viewport top and how far into it the viewport sits. When a
   * refresh inserts rows above, the list is put back on this entry, so the
   * reader keeps looking at the same rows instead of at whatever slid down.
   */
  const scrollAnchor = useRef<{ key: string; delta: number } | null>(null)
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

  /** Every entry key to its row offset, for putting the viewport back in place. */
  const keyIndex = useMemo(function () {
    const map = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) map.set(entries[i].key, i)
    return map
  }, [entries])

  const total = offsets[entries.length] || 0

  function scrollTo(el: HTMLDivElement, value: number) {
    el.scrollTop = value
  }

  const compute = useCallback(function () {
    const el = viewportRef.current
    if (!el) return
    const top = el.scrollTop
    const height = el.clientHeight || 600
    const next = windowOf({
      entries: entries,
      offsets: offsets,
      groupFloor: groupFloor,
      top: top,
      height: height,
      groupBy: groupBy,
    })
    setRange(function (current) {
      if (current.start === next.start && current.end === next.end && current.headerIndex === next.headerIndex) {
        return current
      }
      return { start: next.start, end: next.end, headerIndex: next.headerIndex }
    })
    scrollAnchor.current = next.anchor
    // A refresh must not put rows where the reader is looking, and the top of
    // the list is the one place where new rows are what the reader expects.
    controller.setScrolled(next.anchor !== null)
    if (!next.anchor) controller.releaseHeld()
    // Rows above the band that were read on the way here were kept only so the
    // list would not move; the anchor holds the position now. A flat list has
    // no section to fade them out, so the band is what lets them go.
    if (state.filter === 'unread') {
      const settled = settledAbove(entries, next.start, state.read)
      if (settled.length >= TRIM_AT) controller.trimSticky(settled)
    }
    window.clearTimeout(restTimer.current)
    restTimer.current = 0
    // A row counts as read once it has been on screen long enough to be seen
    // and the viewport has moved off it; with the preference off, nothing is
    // timed and nothing is marked.
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
      top: top,
      height: height,
      maxTop: Math.max(0, el.scrollHeight - el.clientHeight),
      seen: seen.current,
      read: state.read,
      now: window.performance.now(),
    })
    for (const row of reads.entering) seen.current.set(row[0], row[1])
    for (const id of reads.leaving) seen.current.delete(id)
    // Implicit marks keep their rows: a row must not vanish from under the
    // pointer. The section releases them once it has nothing unread left.
    if (reads.readIds.length) void controller.mark(reads.readIds, true, true)
    // The rows the scroll stopped on are the only ones that can become read
    // without a scroll, so the pass that can see them schedules the next one.
    if (reads.restMs > 0) {
      restTimer.current = window.setTimeout(function () { computeRef.current() }, reads.restMs)
    }
  }, [offsets, entries, groupFloor, groupBy, markOnScroll, state.read, state.filter, controller, itemIndex])
  computeRef.current = compute

  const onScroll = useCallback(function () {
    if (raf.current) return
    raf.current = requestAnimationFrame(function () {
      raf.current = 0
      compute()
    })
  }, [compute])

  /** The entry list the scroll anchor was captured against. */
  const anchoredFor = useRef<Entry[] | null>(null)
  // The rows were rebuilt under a live scroll position: put the entry that was
  // under the viewport edge back where it was, before the browser paints.
  useLayoutEffect(function () {
    const el = viewportRef.current
    const previous = anchoredFor.current
    anchoredFor.current = entries
    const held = scrollAnchor.current
    if (!el || !held || !previous || previous === entries) return
    const index = keyIndex.get(held.key)
    if (index === undefined) return
    const target = Math.max(0, (offsets[index] || 0) + held.delta)
    if (Math.abs(target - el.scrollTop) < 1) return
    scrollTo(el, target)
  }, [entries, offsets, keyIndex])

  useEffect(function () {
    const key = `${groupBy}\u0000${state.query}\u0000${state.feedId || ''}`
    if (lastKey.current !== key) {
      lastKey.current = key
      const el = viewportRef.current
      if (el) scrollTo(el, 0)
    }
    compute()
  }, [compute, groupBy, state.query, state.feedId, state.version])

  useEffect(function () {
    return function () { window.clearTimeout(restTimer.current); restTimer.current = 0 }
  }, [])

  useEffect(function () {
    const el = viewportRef.current
    if (!el) return
    let alive = true
    const observer = new ResizeObserver(function () { if (alive) compute() })
    observer.observe(el)
    return function () {
      alive = false
      observer.disconnect()
    }
  }, [compute])

  // Reveal a newly selected item, but never move the viewport because the
  // background refresh rebuilt the entries: the user may be reading elsewhere
  // in the list while new items land.
  useEffect(function () {
    const id = state.current
    if (!id) {
      lastSelected.current = null
      return
    }
    if (lastSelected.current === id) return
    lastSelected.current = id
    const index = itemIndex.get(id)
    if (index === undefined) return
    const currentRange = rangeRef.current
    if (index >= currentRange.start && index < currentRange.end) return
    const el = viewportRef.current
    if (el) scrollTo(el, Math.max(0, offsets[index] - 32))
  }, [state.current, itemIndex, offsets])

  /**
   * Sections whose unread rows have all been read: they are kept on screen only
   * so nothing moves under the pointer, so they fade where they stand and the
   * list is rebuilt without them once the fade is done.
   */
  const finished = useMemo(function () {
    return exhaustedGroups(entries, state.read, state.filter)
  }, [entries, state.read, state.filter])
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

  const slice = entries.slice(range.start, range.end)
  const top = offsets[range.start] || 0
  const bottom = Math.max(0, total - (offsets[range.end] || total))
  /** The section header covering the band while it sits above the mounted rows. */
  const pinned = range.headerIndex === null ? undefined : entries[range.headerIndex]

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
    const gone = leaving(range.start + offset) ? ' gf-fade' : ''
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
        role="button"
        tabIndex={-1}
        aria-current={state.current === item.id ? 'true' : undefined}
        onClick={function () { controller.select(item.id) }}
      >
        <div className="gf-row-title">
          {unread ? <span className="gf-dot" aria-hidden="true" /> : null}
          <span className="t">{item.title || '(untitled)'}</span>
          {/* The star is an action on the row, not a way into it: it sits on
              every row so an item can be kept without opening the article,
              and it holds its space so the title never re-wraps on hover. */}
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
              onClick={function (event) {
                event.stopPropagation()
                controller.toggleStar(item.id)
              }}
            />
          </span>
        </div>
        <div className="gf-row-meta">
          {/* Every row under a source section would repeat the name the sticky
              header already carries; only an ungrouped list needs it per row. */}
          {groupBy === 'feed' ? null : <span className="feed-name">{controller.feedTitle(item.feed)}</span>}
          <span className="when">{fmtTime(item.date)}</span>
        </div>
        {digest ? <div className="gf-row-digest">{digest}</div> : null}
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

  const header = (
    <div className="gf-listbar">
      <span className="gf-count-label">{t('items.count', { n: remaining })}</span>
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
      <div className={paneClass}>
        {header}
        <EmptyState className="compact" hint={t('status.loading')} />
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
          <div style={{ height: top }} />
          {listRows}
          <div style={{ height: bottom }} />
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
