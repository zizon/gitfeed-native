/**
 * The viewport half of the list: which entries are mounted, which one the top
 * edge sits on, and which rows scrolling past have been read.
 *
 * The band is derived, never stored: a render draws the entries it was handed
 * from the scroll offset it was handed, so a rebuild cannot leave the mounted
 * rows describing the list that was replaced. The one transition the browser
 * cannot make on its own is a rebuild under a live viewport, and
 * {@link scrollAfterRebuild} answers where the viewport has to go for the entry
 * under its edge to stay under its edge. The component owns the rAF throttle,
 * the dwell clock, and applying the answer before paint.
 */

import { AT_TOP } from './constants.js'
import type { Entry } from './derive.js'

/**
 * The entry whose band contains `y`; `y` past the end returns one past the last
 * entry, so callers clamp before indexing.
 * @param offsets - the offset index.
 * @param y - a scroll offset.
 * @returns the entry index.
 */
export function lowerBound(offsets: readonly number[], y: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1] <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Running start offset per entry, plus one trailing total.
 * @param entries - the flattened list entries.
 * @returns `offsets[i]` is entry `i`'s top; the last value is the full height.
 */
export function offsetIndex(entries: readonly Entry[]): number[] {
  const out = new Array<number>(entries.length + 1)
  out[0] = 0
  for (let i = 0; i < entries.length; i++) out[i + 1] = out[i] + entries[i].h
  return out
}

/**
 * Which section header covers each entry, so a section can stay mounted under
 * the viewport edge instead of scrolling its header away.
 * @param entries - the flattened list entries.
 * @returns per entry, the index of its section header, or -1 before the first.
 */
export function groupFloorOf(entries: readonly Entry[]): number[] {
  const out = new Array<number>(entries.length)
  let owner = -1
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].kind === 'group') owner = i
    out[i] = owner
  }
  return out
}

/**
 * Rows above the mounted band the reader has already read. They were kept on
 * screen only so the list would not move under the pointer; the scroll anchor
 * holds that position now, and a flat list has no section to release them.
 * @param entries - the flattened list entries.
 * @param start - the first entry the band mounts.
 * @param read - the read set.
 * @returns the ids of the read rows above the band, in archive order.
 */
export function settledAbove(entries: readonly Entry[], start: number, read: ReadonlySet<string>): string[] {
  const out: string[] = []
  const end = Math.min(start, entries.length)
  for (let i = 0; i < end; i++) {
    const entry = entries[i]
    if (entry.kind === 'row' && read.has(entry.item.id)) out.push(entry.item.id)
  }
  return out
}

/** One viewport pass, before it decides anything. */
export interface WindowInput {
  entries: readonly Entry[]
  offsets: readonly number[]
  groupFloor: readonly number[]
  /** Scroll offset now. */
  top: number
  /** Viewport height; the caller substitutes a default before measuring. */
  height: number
  /** Grouping in effect; `none` turns the sticky floor off. */
  groupBy: string
}

/** What one pass decided to render. */
export interface ListWindow {
  /** First entry to mount. */
  start: number
  /** One past the last entry to mount. */
  end: number
  /** Entry under the viewport edge, and how far into it the edge sits. */
  anchor: { key: string; delta: number } | null
  /**
   * The section header covering the band when it sits above the mounted rows.
   * The caller pins that one header instead of pulling the band back to it.
   */
  headerIndex: number | null
}

/** How long a row has to stay on screen before the reader counts as having seen it. */
export const READ_DWELL_MS = 1000

/** Rows kept mounted beyond the visible band, so a fast scroll never shows a gap. */
const OVERSCAN = 4

/**
 * Decide one viewport pass.
 * @param input - the mounted entries, their offsets, and the scroll facts.
 * @returns the mounted band, the anchor, and the pinned section header.
 */
export function windowOf(input: WindowInput): ListWindow {
  const entries = input.entries
  const offsets = input.offsets
  const top = input.top
  const count = entries.length
  const visibleStart = lowerBound(offsets, top)
  const visibleEnd = Math.min(count, lowerBound(offsets, top + input.height) + 1)
  const start = Math.max(0, visibleStart - OVERSCAN)
  const end = Math.min(count, visibleEnd + OVERSCAN)
  const index = Math.min(count - 1, lowerBound(offsets, top + 1))
  // A section header above the band is not mounted, and mounting the rows back
  // to it would defeat the window: a tall section would mount from its own
  // header down. The caller pins that one header instead.
  const floor = input.groupBy === 'none' ? -1 : input.groupFloor[index] ?? -1
  const headerIndex = floor > -1 && floor < start ? floor : null
  // At the very top new rows should simply appear; anywhere else the entry
  // under the viewport edge is the landmark that must not move.
  const anchorIndex = Math.min(count - 1, lowerBound(offsets, top))
  const anchorEntry = top <= AT_TOP ? undefined : entries[anchorIndex]
  const anchor = anchorEntry
    ? { key: anchorEntry.key, delta: Math.max(0, top - offsets[anchorIndex]) }
    : null
  return {
    start: start,
    end: end,
    anchor: anchor,
    headerIndex: headerIndex,
  }
}

/** The entries a rebuild replaced, and the entries that replaced them. */
export interface RebuildInput {
  /** The entries that were on screen. */
  prev: readonly Entry[]
  prevOffsets: readonly number[]
  /** The entries the list was rebuilt from. */
  next: readonly Entry[]
  nextOffsets: readonly number[]
  /** The scroll offset just before the rebuild. */
  top: number
  /** Viewport height. */
  height: number
  /** Grouping in effect; a changed grouping is a new list, not a rebuild. */
  groupBy: string
}

/**
 * Where the viewport goes when the list is rebuilt under it.
 *
 * A rebuild replaces every entry object, so React has no key to keep the
 * browser's scroll position on: the entry under the viewport edge is the only
 * landmark that says what the reader is looking at. The answer puts that entry
 * back under the edge, at the same offset into it, so rows inserted or removed
 * above the viewport move the scroll offset instead of the text.
 *
 * Two cases have no landmark to hold. At the top there is no entry above the
 * edge to stand behind, so the top stays the top. And when the anchored entry
 * itself is gone — retention deleted it, or a mark dropped it — the first entry
 * after it that survived takes its place; if the whole tail went with it, the
 * list starts over at its top.
 *
 * @param input - the entries before and after, and where the viewport was.
 * @returns the scroll offset to apply before the next paint.
 */
export function scrollAfterRebuild(input: RebuildInput): number {
  const prev = input.prev
  if (!prev.length || !input.next.length) return 0
  const band = windowOf({
    entries: prev,
    offsets: input.prevOffsets,
    groupFloor: groupFloorOf(prev),
    top: input.top,
    height: input.height,
    groupBy: input.groupBy,
  })
  if (!band.anchor) return 0
  const anchorIndex = Math.min(prev.length - 1, lowerBound(input.prevOffsets, input.top))
  const nextAt = indexOf(input.next)
  const kept = nextAt.get(prev[anchorIndex].key)
  if (kept !== undefined) {
    const delta = Math.min(band.anchor.delta, Math.max(0, input.next[kept].h - 1))
    return Math.max(0, (input.nextOffsets[kept] || 0) + delta)
  }
  // The anchor is gone. The nearest entry after it that survived keeps the
  // screen position the anchor had, so the reader keeps looking at the same
  // part of the archive rather than at whatever slid into its place.
  for (let i = anchorIndex + 1; i < prev.length; i++) {
    const at = nextAt.get(prev[i].key)
    if (at === undefined) continue
    return Math.max(0, (input.nextOffsets[at] || 0) - (input.prevOffsets[i] - input.top))
  }
  for (let i = anchorIndex - 1; i >= 0; i--) {
    const at = nextAt.get(prev[i].key)
    if (at === undefined) continue
    return Math.max(0, (input.nextOffsets[at] || 0) - (input.prevOffsets[i] - input.top))
  }
  return 0
}

/** Every entry key to its index, for the rebuild's two lookups. */
function indexOf(entries: readonly Entry[]): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) out.set(entries[i].key, i)
  return out
}

/** One read-on-scroll pass. The caller owns `seen`, so a pass stays pure. */
export interface ScrollReadInput {
  entries: readonly Entry[]
  offsets: readonly number[]
  /** Row id to its entry index, for the rows the list still holds. */
  index: ReadonlyMap<string, number>
  /** Viewport top. */
  top: number
  /** Viewport height. */
  height: number
  /** When each row first came on screen, by id. */
  seen: ReadonlyMap<string, number>
  /** The rows already read; they are neither timed nor marked. */
  read: ReadonlySet<string>
  /** Now, on the same clock as `seen`. */
  now: number
}

/** What one read-on-scroll pass decides. */
export interface ScrollRead {
  /** Rows that came on screen this pass, and when. */
  entering: Array<[string, number]>
  /** Rows the viewport scrolled past, read or not: stop timing them. */
  leaving: string[]
  /** Rows that were on screen long enough and are now above the viewport. */
  readIds: string[]
}

/**
 * Decide which rows the reader has seen and can stop counting as unread.
 *
 * A row counts as read once it has been on screen for {@link READ_DWELL_MS}
 * and the viewport has scrolled *past* it: it sits wholly above the band. Rows
 * that only flashed past — a flicked scroll, a scrollbar drag — were never on
 * screen long enough and stay unread. The list scrolls one viewport past its
 * last row, so the rows it ends on can leave the viewport too, instead of
 * resting there unread.
 *
 * A row that left the band any other way keeps its clock and stays unread: the
 * list was rebuilt, rows arrived above it, or the view jumped back to the top.
 * Those rows were never scroll-past, and marking them is the reader losing
 * unread items to a refresh it did not ask for.
 *
 * @param input - the mounted entries, the scroll facts, and the dwell clock.
 * @returns the rows coming on screen, leaving, and read, plus the next wait.
 */
export function scrollReads(input: ScrollReadInput): ScrollRead {
  const first = lowerBound(input.offsets, input.top)
  const last = Math.min(input.entries.length, lowerBound(input.offsets, input.top + input.height) + 1)
  const now = input.now
  const entering: Array<[string, number]> = []
  const leaving: string[] = []
  const readIds: string[] = []
  const visible = new Set<string>()
  for (let i = first; i < last; i++) {
    const entry = input.entries[i]
    if (entry.kind !== 'row') continue
    const id = entry.item.id
    if (input.read.has(id)) continue
    visible.add(id)
    if (!input.seen.has(id)) entering.push([id, now])
  }
  for (const [id, at] of input.seen) {
    if (visible.has(id) || input.read.has(id)) continue
    const index = input.index.get(id)
    if (index === undefined) continue
    // Only the rows the viewport scrolled past are read. A row that left the
    // band downwards — pushed out by arrivals above it, or by the list jumping
    // to the top — was never scrolled past, so it keeps its clock and is
    // marked when a later pass carries the band over it.
    if (input.offsets[index] + input.entries[index].h > input.top) continue
    if (now - at >= READ_DWELL_MS) readIds.push(id)
    leaving.push(id)
  }
  return { entering: entering, leaving: leaving, readIds: readIds }
}
