/**
 * The viewport half of the list: which entries are mounted, which one the top
 * edge sits on, and which rows scrolling past have been read. Pure — the
 * component keeps the rAF throttle, the dwell clock, and the scroll restore.
 */

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
/** Below this offset the viewport counts as being at the very top. */
const AT_TOP = 12

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
  /** Rows that are no longer on screen, read or not: stop timing them. */
  leaving: string[]
  /** Rows that were on screen long enough, and are now behind the viewport. */
  readIds: string[]
}

/**
 * Decide which rows the reader has seen and can stop counting as unread.
 *
 * A row counts as read once it has been on screen for {@link READ_DWELL_MS}
 * and the viewport has moved off it. Rows that only flashed past — a flicked
 * scroll, a scrollbar drag — were never on screen long enough and stay unread.
 * The list scrolls one viewport past its last row, so the rows it ends on can
 * leave the viewport too, instead of resting there unread.
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
    if (visible.has(id) || input.read.has(id) || !input.index.has(id)) continue
    if (now - at >= READ_DWELL_MS) readIds.push(id)
    leaving.push(id)
  }
  return { entering: entering, leaving: leaving, readIds: readIds }
}
