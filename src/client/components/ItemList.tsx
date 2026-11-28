/** Fixed-height virtualized item list with group headers and read-on-scroll. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../react.js'
import type { RefObject } from '../react.js'
import { AT_TOP, GROUP_H, ROW_H, ROW_H_PLAIN } from '../constants.js'
import { entriesOf, exhaustedGroups, sourceOrder } from '../derive.js'
import type { Entry, SourceOrder } from '../derive.js'
import { groupFloorOf, offsetIndex, scrollAfterRebuild, scrollReads, settledAbove, windowOf } from '../window.js'
import type { ClientState, Controller, Filter, ItemListProps, MarkCounts, MarkScope } from '../types.js'
import type { GroupBy, Item } from '../../shared/types.js'
import type { Translate } from '../locales.js'
import { bandParts, ListBody, ListHeader, listRowsOf, MarkArea, placeholderOf } from './item-list-parts.js'

/**
 * The list with no rows to show: the loading skeleton, or the reason there is
 * nothing. The count bar is the same one the rows get, so it does not jump.
 */

/** One menu row: the scope label on the left and what it would touch on the right. */
/**
 * The one menu row the view's own button does not cover: every unread item in the
 * library, offered only when that is a different set. Taking it back is a second
 * press, which is what `armed` is.
 */


/** One section header: its name, and the actions taken while reading a feed. */

/** The two buttons a confirming section header offers. */

/** A source section's actions: move it, stop following it, mark it read. */

/** One item row: the row's own target, its digest line, and the star beside it. */

/** The rows and section headers for one list, in the order the rail shows. */
function entriesFor(
  list: Item[], groupBy: GroupBy, rowH: number, order: SourceOrder, controller: Controller,
): Entry[] {
  return entriesOf(
    list,
    groupBy,
    { row: rowH, group: GROUP_H },
    function (id) { return controller.feedTitle(id) },
    function (id) { return controller.feedFolder(id) },
    function (key) {
      const rank = groupBy === 'feed' ? order.rank.get(key) : order.folders.get(key)
      return rank === undefined ? order.next : rank
    },
  )
}

/** The bar over the list: how many rows the view has, and the arrivals it holds. */

/**
 * The floating bar that marks the current view, with the one scope the view does
 * not reach — every unread item in the library — in its menu.
 */


/** How long a finished section fades before the list is rebuilt without it. */
const FADE_MS = 380
/** Rows the first paint fakes: more than any pane of this list holds. */

/**
 * Row-shaped blocks at the height the rows will have, so the first paint does
 * not jump when the page lands.
 * @param props.height - the row height the list is about to use.
 * @param props.digest - whether the rows will carry a digest line.
 * @param props.label - what the loading state is called, for a screen reader.
 * @returns the placeholder rows.
 */
/**
 * Read rows above the band before a scroll releases them in one batch. One
 * rebuild per row would re-derive the whole archive every 66 pixels; this is
 * roughly a screen and a half of slack.
 */
const TRIM_AT = 24

/** The refs the scroll bookkeeping lives on; they outlive every render. */
interface ViewportRefs {
  viewportRef: RefObject<HTMLDivElement>
  /** The scroll offset as the DOM has it — a render cannot read the element. */
  topRef: { current: number }
  /** Where the list was last drawn from, so a rebuild can put the edge back. */
  drawn: { current: { entries: Entry[]; offsets: number[]; scope: string } | null }
  /** Whether the viewport has left the top since a refresh held rows for it. */
  leftTop: { current: boolean }
  raf: { current: number }
  /** The row the reader was last moved to, so a rebuild does not drag them off it. */
  lastSelected: { current: string | null }
  /** The rows that have been on screen, and since when. */
  seen: { current: Map<string, number> }
}

/** The render values one scroll pass works with. */
interface ListView {
  entries: Entry[]
  offsets: number[]
  groupFloor: number[]
  groupBy: GroupBy
  itemIndex: Map<string, number>
  markOnScroll: boolean
  read: Set<string>
  filter: Filter
  controller: Controller
  current: string | null
  listLen: number
  scopeKey: string
  height: number
  band: ReturnType<typeof windowOf>
}

/** The rail's order over sources: the one the load settled, not the read set. */
function sourceOrderOf(state: ClientState, t: Translate): SourceOrder {
  const interestOrder = state.interestOrder === null ? true : state.interestOrder
  const scores = interestOrder ? state.ranks : null
  return sourceOrder(state.feeds, scores, t('feed.uncategorized'))
}

/** The item index of the entries, for the row the keyboard moved to. */
function itemIndexes(entries: Entry[]): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.kind === 'row') map.set(entry.item.id, i)
  }
  return map
}

/**
 * The section the open article is in keeps its rows, even once nothing in it is
 * unread: the reader is looking at that row, and fading it out under the click
 * is the one movement opening an article should not cause. The section leaves
 * when the reader closes the article or moves to another one.
 */
function holdKeyOf(
  entries: Entry[], itemIndex: Map<string, number>, groupFloor: number[], current: string | null,
): string | null {
  if (!current) return null
  const index = itemIndex.get(current)
  if (index === undefined) return null
  const floor = groupFloor[index]
  if (floor < 0) return null
  const header = entries[floor]
  return header.kind === 'group' ? header.group.key : null
}

/**
 * The list's side effects for one viewport pass: the rows the scroll read, the
 * rows it can let go, and whether a held arrival may land. The band is not one
 * of them — it comes from the render that carries the offset.
 */
function settleNow(refs: ViewportRefs, view: ListView, at: number, h: number): void {
  // Held arrivals land when the reader leaves the top and comes back. Sitting
  // at the top is not leaving it: the rows would push the one being read down.
  if (at <= AT_TOP) {
    if (refs.leftTop.current) {
      refs.leftTop.current = false
      view.controller.releaseHeld()
    }
  } else {
    refs.leftTop.current = true
  }
  // Rows above the band that were read on the way here were kept only so the
  // list would not move; the anchor holds the position now. A flat list has no
  // section to fade them out, so the band is what lets them go.
  if (view.filter === 'unread') {
    const next = windowOf({
      entries: view.entries, offsets: view.offsets, groupFloor: view.groupFloor,
      top: at, height: h, groupBy: view.groupBy,
    })
    const settled = settledAbove(view.entries, next.start, view.read)
    if (settled.length >= TRIM_AT) view.controller.trimSticky(settled)
  }
  // A row counts as read once it has been on screen long enough to be seen and
  // the viewport has scrolled past it; with the preference off, nothing is timed
  // and nothing is marked. This pass runs on a rebuild as well as on a scroll,
  // which is why only a row the band carried over is read: rows a rebuild pushed
  // down were never scrolled past.
  if (!view.markOnScroll) {
    refs.seen.current.clear()
    return
  }
  for (const id of refs.seen.current.keys()) {
    if (!view.itemIndex.has(id) || view.read.has(id)) refs.seen.current.delete(id)
  }
  const reads = scrollReads({
    entries: view.entries,
    offsets: view.offsets,
    index: view.itemIndex,
    top: at,
    height: h,
    seen: refs.seen.current,
    read: view.read,
    now: window.performance.now(),
  })
  for (const row of reads.entering) refs.seen.current.set(row[0], row[1])
  for (const id of reads.leaving) refs.seen.current.delete(id)
  // Implicit marks keep their rows: a row must not vanish from under the
  // pointer. The section releases them once it has nothing unread left.
  if (reads.readIds.length) void view.controller.mark(reads.readIds, true, true)
}

/**
 * A rebuild, or a scope change, has to be dealt with before it is painted: the
 * scroll offset is the one part of the band a render cannot answer for. The band
 * is derived from the render that carries the corrected offset, so the frame
 * that reaches the screen is already consistent.
 */
function rebuildNow(
  refs: ViewportRefs,
  view: ListView,
  top: number,
  viewportH: number,
  io: { setTop: (value: number) => void; setViewportH: (value: number) => void; settle: (at: number, h: number) => void },
): void {
  // A list with rows on it is a position to protect, at the top as much as in
  // the middle: a row inserted above the reader pushes the reader down.
  view.controller.setHold(view.listLen > 0)
  const el = refs.viewportRef.current
  if (!el) {
    // No viewport is on screen (loading, empty, or failed): there is no position
    // to hold, so the next list that appears starts at its own top.
    refs.drawn.current = null
    return
  }
  const h = el.clientHeight || view.height
  const previous = refs.drawn.current
  let target = refs.topRef.current
  if (!previous) {
    target = el.scrollTop
  } else if (previous.scope !== view.scopeKey) {
    // A new filter, search, or source is a new list: it starts at its own top.
    target = 0
    refs.seen.current.clear()
    refs.leftTop.current = false
  } else if (previous.entries !== view.entries) {
    target = scrollAfterRebuild({
      prev: previous.entries,
      prevOffsets: previous.offsets,
      next: view.entries,
      nextOffsets: view.offsets,
      top: refs.topRef.current,
      height: h,
      groupBy: view.groupBy,
    })
  }
  // A row the keyboard moved to is an explicit act: bring it into view, even if
  // the rebuild would have held the old position.
  if (view.current !== refs.lastSelected.current) {
    refs.lastSelected.current = view.current
    const index = view.current ? view.itemIndex.get(view.current) : undefined
    if (index !== undefined) {
      const shown = windowOf({
        entries: view.entries, offsets: view.offsets, groupFloor: view.groupFloor,
        top: target, height: h, groupBy: view.groupBy,
      })
      if (index < shown.start || index >= shown.end) target = Math.max(0, (view.offsets[index] || 0) - 32)
    }
  }
  if (el.scrollTop !== target) el.scrollTop = target
  // The browser clamps past the end of the list; what it kept is where the band
  // has to be drawn.
  const settled = el.scrollTop
  refs.topRef.current = settled
  if (settled !== top) io.setTop(settled)
  if (el.clientHeight !== viewportH) io.setViewportH(el.clientHeight)
  refs.drawn.current = { entries: view.entries, offsets: view.offsets, scope: view.scopeKey }
  io.settle(settled, h)
}

/** One throttled scroll pass: re-render only when the band or the top edge moves. */
function scrollNow(
  refs: ViewportRefs,
  view: ListView,
  top: number,
  setTop: (value: number) => void,
  settle: (at: number, h: number) => void,
  el: HTMLDivElement,
): void {
  refs.topRef.current = el.scrollTop
  if (refs.raf.current) return
  refs.raf.current = requestAnimationFrame(function () {
    refs.raf.current = 0
    const node = refs.viewportRef.current
    if (!node) return
    const at = node.scrollTop
    refs.topRef.current = at
    const h = node.clientHeight || view.height
    const next = windowOf({
      entries: view.entries, offsets: view.offsets, groupFloor: view.groupFloor,
      top: at, height: h, groupBy: view.groupBy,
    })
    // Re-render only when the band moves, or when the viewport crosses the top:
    // the overscan covers the rows between one band and the next, and the top is
    // what says whether a held arrival may land or the pill shows.
    const crossed = (at <= AT_TOP) !== (top <= AT_TOP)
    if (crossed || next.start !== view.band.start || next.end !== view.band.end || next.headerIndex !== view.band.headerIndex) setTop(at)
    settle(at, h)
  })
}

/** Keep the viewport height in state, so the end screen is exactly one of them. */
function watchViewport(
  viewportRef: RefObject<HTMLDivElement>,
  setViewportH: (update: (current: number) => number) => void,
): () => void {
  const el = viewportRef.current
  if (!el) return function () { /* nothing to watch */ }
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
}

/** Let the sections that finished reading leave once their fade is done. */
function releaseFinished(entries: Entry[], finishedSet: Set<string>, controller: Controller): void {
  const ids: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'group' || !finishedSet.has(entry.group.key)) continue
    for (const item of entry.group.items) ids.push(item.id)
  }
  if (ids.length) controller.releaseSticky(ids)
}

/**
 * The bar follows the viewport, but the scope is picked from the strongest scope
 * that is actually in effect: a search, then a selected source, then the group
 * under the edge. A source always wins over grouping, so a folder that reaches
 * past the current source can never be marked from inside it.
 */
function scopeOf(count: number, state: ClientState, counts: MarkCounts, t: Translate): MarkScope | null {
  if (!count) return null
  // A single source is marked from that source's own row (here or in the feed
  // list), so the bar only speaks for a wider view.
  if (state.query.trim()) return { kind: 'results', label: t('action.markResults'), n: counts.results }
  if (state.feedId) return null
  return { kind: 'all', label: t('action.markAll'), n: counts.all }
}

/** Whether the entry at one index belongs to a section that is leaving. */

/** The mounted band's rows: section headers and item rows, each with its fade. */

/** The floating mark bar: its own open/armed state, and the scope it acts on. */

/** The mounted band's parts: its rows and the spacers above and below. */

/** The list with no rows yet, or why it has none; null when it has rows. */

/** The list's own frame: the rows, the end screen, the pinned header, the bar. */

/**
 * Sections whose unread rows have all been read: they are kept on screen only so
 * nothing moves under the pointer, so they fade where they stand and the list is
 * rebuilt without them once the fade is done.
 */
function useStickySections(input: {
  entries: Entry[]
  itemIndex: Map<string, number>
  groupFloor: number[]
  current: string | null
  read: Set<string>
  filter: Filter
  controller: Controller
}): Set<string> {
  // The section the open article is in keeps its rows, even once nothing in it
  // is unread: the reader is looking at that row, and fading it out under the
  // click is the one movement opening an article should not cause.
  const holdKey = useMemo(function () {
    return holdKeyOf(input.entries, input.itemIndex, input.groupFloor, input.current)
  }, [input.current, input.itemIndex, input.groupFloor, input.entries])
  const finished = useMemo(function () {
    return exhaustedGroups(input.entries, input.read, input.filter, holdKey)
  }, [input.entries, input.read, input.filter, holdKey])
  const finishedKey = finished.join('\u0000')
  const finishedSet = new Set(finished)
  useEffect(function () {
    if (!finishedKey) return
    const timer = setTimeout(function () { releaseFinished(input.entries, finishedSet, input.controller) }, FADE_MS)
    return function () { clearTimeout(timer) }
  }, [finishedKey, input.controller])
  return finishedSet
}

/** The list's own reading of the reader's preferences. */
function useListPrefs(state: ClientState, controller: Controller): {
  list: Item[]
  groupBy: GroupBy
  markOnScroll: boolean
  showDigest: boolean
  rowH: number
} {
  const list = controller.getList()
  const groupBy = state.groupBy || state.reader.groupBy || 'none'
  const markOnScroll = state.markOnScroll === null ? state.reader.markReadOnScroll : state.markOnScroll
  const showDigest = state.showDigest === null ? true : state.showDigest
  const rowH = showDigest ? ROW_H : ROW_H_PLAIN
  return { list: list, groupBy: groupBy, markOnScroll: markOnScroll, showDigest: showDigest, rowH: rowH }
}

/** The rows and the section headers the list derives from them. */
function useListRows(state: ClientState, controller: Controller, t: Translate, list: Item[], groupBy: GroupBy, rowH: number): {
  counts: MarkCounts
  entries: Entry[]
  offsets: number[]
  groupFloor: number[]
  itemIndex: Map<string, number>
  total: number
  scopeKey: string
} {
  const counts = useMemo(function () {
    return controller.markCounts()
  }, [state.items, state.read, state.version, state.listEpoch, state.feedId, state.query, state.filter, controller])
  const order = useMemo(function () {
    return sourceOrderOf(state, t)
  }, [state.feeds, state.ranks, state.interestOrder, t])
  const entries = useMemo<Entry[]>(function () {
    return entriesFor(list, groupBy, rowH, order, controller)
  }, [list, groupBy, controller, rowH, order])
  const offsets = useMemo(function () { return offsetIndex(entries) }, [entries])
  const groupFloor = useMemo(function () { return groupFloorOf(entries) }, [entries])
  const itemIndex = useMemo(function () { return itemIndexes(entries) }, [entries])
  const total = offsets[entries.length] || 0
  const scopeKey = `${groupBy}\u0000${state.query}\u0000${state.feedId || ''}`
  return {
    counts: counts, entries: entries, offsets: offsets, groupFloor: groupFloor,
    itemIndex: itemIndex, total: total, scopeKey: scopeKey,
  }
}

/** The list's scroll machinery: its refs, its offset, and the band it draws. */
function useListViewport(input: {
  entries: Entry[]
  offsets: number[]
  groupFloor: number[]
  groupBy: GroupBy
  itemIndex: Map<string, number>
  markOnScroll: boolean
  read: Set<string>
  filter: Filter
  controller: Controller
  current: string | null
  listLen: number
  scopeKey: string
}): {
  viewportRef: RefObject<HTMLDivElement>
  top: number
  viewportH: number
  band: ReturnType<typeof windowOf>
  onScroll: (event: { currentTarget: HTMLDivElement }) => void
} {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const topRef = useRef(0)
  const drawn = useRef<{ entries: Entry[]; offsets: number[]; scope: string } | null>(null)
  const leftTop = useRef(false)
  const raf = useRef(0)
  const lastSelected = useRef<string | null>(null)
  const seen = useRef<Map<string, number>>(new Map())
  const refs: ViewportRefs = {
    viewportRef: viewportRef, topRef: topRef, drawn: drawn, leftTop: leftTop,
    raf: raf, lastSelected: lastSelected, seen: seen,
  }
  const height = viewportH || 600
  const band = useMemo(function () {
    return windowOf({
      entries: input.entries, offsets: input.offsets, groupFloor: input.groupFloor,
      top: top, height: height, groupBy: input.groupBy,
    })
  }, [input.entries, input.offsets, input.groupFloor, top, height, input.groupBy])
  const view: ListView = {
    entries: input.entries, offsets: input.offsets, groupFloor: input.groupFloor, groupBy: input.groupBy,
    itemIndex: input.itemIndex, markOnScroll: input.markOnScroll, read: input.read, filter: input.filter,
    controller: input.controller, current: input.current, listLen: input.listLen, scopeKey: input.scopeKey,
    height: height, band: band,
  }

  const settle = useCallback(function (at: number, h: number) { settleNow(refs, view, at, h) }, [view])
  useLayoutEffect(function () {
    rebuildNow(refs, view, top, viewportH, { setTop: setTop, setViewportH: setViewportH, settle: settle })
  }, [view, top, viewportH, settle])
  const onScroll = useCallback(function (event: { currentTarget: HTMLDivElement }) {
    scrollNow(refs, view, top, setTop, settle, event.currentTarget)
  }, [view, top, settle])

  useEffect(function () {
    return function () {
      if (refs.raf.current) cancelAnimationFrame(refs.raf.current)
      refs.raf.current = 0
    }
  }, [refs])

  useEffect(function () { return watchViewport(refs.viewportRef, setViewportH) }, [refs])

  return { viewportRef: viewportRef, top: top, viewportH: viewportH, band: band, onScroll: onScroll }
}

export function ItemList({ state, controller, t, wide }: ItemListProps) {
  const [pendingUnsub, setPendingUnsub] = useState<string | null>(null)
  const { list, groupBy, markOnScroll, showDigest, rowH } = useListPrefs(state, controller)
  const { counts, entries, offsets, groupFloor, itemIndex, total, scopeKey } = useListRows(state, controller, t, list, groupBy, rowH)

  const { viewportRef, top, viewportH, band, onScroll } = useListViewport({
    entries: entries,
    offsets: offsets,
    groupFloor: groupFloor,
    groupBy: groupBy,
    itemIndex: itemIndex,
    markOnScroll: markOnScroll,
    read: state.read,
    filter: state.filter,
    controller: controller,
    current: state.current,
    listLen: list.length,
    scopeKey: scopeKey,
  })

  const finishedSet = useStickySections({
    entries: entries,
    itemIndex: itemIndex,
    groupFloor: groupFloor,
    current: state.current,
    read: state.read,
    filter: state.filter,
    controller: controller,
  })

  const { slice, lead, trail, pinned } = bandParts(entries, offsets, band, total)
  const count = list.length
  const remaining = useMemo(function () {
    return controller.countInView()
  }, [state.items, state.read, state.starred, state.filter, state.query, state.feedId, state.listEpoch, controller])
  const paneClass = `gf-listpane${wide ? ' wide' : ''}${showDigest ? '' : ' rows-plain'}`
  const scope = useMemo(function () {
    return scopeOf(count, state, counts, t)
  }, [count, state.query, state.feedId, counts, t])

  const listRows = listRowsOf({
    slice: slice,
    band: band,
    entries: entries,
    groupFloor: groupFloor,
    finishedSet: finishedSet,
    groupBy: groupBy,
    state: state,
    controller: controller,
    t: t,
    pendingUnsub: pendingUnsub,
    onPending: setPendingUnsub,
    showDigest: showDigest,
  })

  const markBar = scope
    ? <MarkArea t={t} counts={counts} scope={scope} controller={controller} />
    : null

  /** Rows a refresh is holding back; they land when the reader asks or moves. */
  const heldCount = controller.heldCount()
  const header = (
    <ListHeader
      t={t}
      remaining={remaining}
      heldCount={heldCount}
      atTop={top <= AT_TOP}
      onRelease={function () { controller.releaseHeld() }}
    />
  )

  const placeholder = placeholderOf({
    state: state, count: count, paneClass: paneClass, header: header, t: t, rowH: rowH, digest: showDigest,
  })
  if (placeholder) return placeholder

  return (
    <ListBody
      paneClass={paneClass}
      header={header}
      markBar={markBar}
      viewportRef={viewportRef}
      onScroll={onScroll}
      lead={lead}
      trail={trail}
      listRows={listRows}
      viewportH={viewportH}
      pinned={pinned}
      finishedSet={finishedSet}
      groupBy={groupBy}
      state={state}
      controller={controller}
      t={t}
      pendingUnsub={pendingUnsub}
      onPending={setPendingUnsub}
    />
  )
}
