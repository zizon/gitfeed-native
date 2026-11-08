/**
 * The viewport half of the list: which entries are mounted, which one the top
 * edge sits on, and which rows scrolling past marked. Pure — the component
 * keeps the rAF throttle, the self-inflicted-scroll guard, and the restore.
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
  /** Scroll offset the previous pass saw. */
  prevTop: number
  /** Scroll offset now. */
  top: number
  /** Viewport height; the caller substitutes a default before measuring. */
  height: number
  /** Grouping in effect; `none` turns the sticky floor off. */
  groupBy: string
  /** Whether rows scrolling past are marked at all. */
  markOnScroll: boolean
}

/** What one pass decided to render and to mark. */
export interface ListWindow {
  /** First entry to mount. */
  start: number
  /** One past the last entry to mount. */
  end: number
  /** Entry under the viewport edge, and how far into it the edge sits. */
  anchor: { key: string; delta: number } | null
  /** Rows the viewport top crossed on the way down, in archive order. */
  passedIds: string[]
  /**
   * The section header covering the band when it sits above the mounted rows.
   * The caller pins that one header instead of pulling the band back to it.
   */
  headerIndex: number | null
}

/** Rows kept mounted beyond the visible band, so a fast scroll never shows a gap. */
const OVERSCAN = 4
/** Below this offset the viewport counts as being at the very top. */
const AT_TOP = 12

/**
 * Decide one viewport pass.
 * @param input - the mounted entries, their offsets, and the scroll facts.
 * @returns the mounted band, the anchor, and the rows to mark.
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
  const passedIds: string[] = []
  // Rows the viewport top passed on the way down are read, including the ones a
  // scrollbar drag skipped over without ever rendering them.
  if (input.markOnScroll && top > input.prevTop) {
    const from = lowerBound(offsets, input.prevTop)
    const to = lowerBound(offsets, top)
    for (let i = from; i < to; i++) {
      const entry = entries[i]
      if (entry.kind === 'row') passedIds.push(entry.item.id)
    }
  }
  return {
    start: start,
    end: end,
    anchor: anchor,
    passedIds: passedIds,
    headerIndex: headerIndex,
  }
}
