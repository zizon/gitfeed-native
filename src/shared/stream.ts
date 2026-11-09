/**
 * The push half of the reader's transport: what the Host streams to a surface,
 * and the pure merge the surface applies to it.
 *
 * The stream replaces the poll. A surface opens one connection, gets the whole
 * archive once, and from then on receives only what changed: the rows a refresh
 * added or repaired, and the marks that moved. The frames are ordered by `rev`,
 * a counter the Host owns for this process, so a surface that reconnects (or a
 * frame that arrived twice) can tell what it has already seen. When the counter
 * cannot answer — a fresh surface, or a Host that restarted — the Host sends the
 * whole state again instead of pretending the gap is a delta.
 *
 * Nothing here reads a file, a clock, or a socket, so both halves can be tested
 * against the same values.
 */

import type { Feed, GitInfo, Item, ReaderPrefs, ScheduleJobInfo } from './types.js'

/** Where the Host mounts the event stream; the Client half opens it by name. */
export const STREAM_PATH = '/gitfeed/events'
/** Version of the frame shapes below. A surface that sees another one reloads. */
export const PROTOCOL = 1
/** How long a streaming Host waits between probes of the data root, in ms. */
export const PROBE_MS = 5000
/** Deltas kept for a surface that reconnected; older ones get a full state. */
export const HISTORY = 400

/** Rows that changed since the revision a surface holds. */
export interface ItemDelta {
  /** Rows the archive gained. */
  added: Item[]
  /** Rows whose text changed in place, for example a repaired body. */
  updated: Item[]
  /** Rows that are no longer in the archive. */
  removed: string[]
}

/** Marks whose membership changed. */
export interface MarkDelta {
  add: string[]
  remove: string[]
}

/** What changed between two revisions. Every field but the versions is optional. */
export interface StreamDelta {
  t: 'delta'
  protocol: number
  rev: number
  version: string
  itemsVersion: string
  items?: ItemDelta
  read?: MarkDelta
  starred?: MarkDelta
  feeds?: Feed[]
  reader?: ReaderPrefs
  git?: GitInfo | null
  schedule?: ScheduleJobInfo[]
  repo?: string
  allowGit?: boolean
}

/** The whole state, for a surface that holds no revision the Host can extend. */
export interface StreamWelcome {
  t: 'welcome'
  protocol: number
  rev: number
  version: string
  itemsVersion: string
  items: Item[]
  read: string[]
  starred: string[]
  feeds: Feed[]
  reader: ReaderPrefs
  git: GitInfo | null
  schedule: ScheduleJobInfo[]
  repo: string
  allowGit: boolean
}

/** A stream-level failure the surface should report and recover from. */
export interface StreamError {
  t: 'error'
  protocol: number
  message: string
}

export type StreamFrame = StreamWelcome | StreamDelta | StreamError

/**
 * The order the reader lists rows in: newest first, and the id as the tie-break
 * so two rows sharing a timestamp never swap places under the pointer.
 * @param a - one row.
 * @param b - the other row.
 * @returns a negative number when `a` is listed first.
 */
export function orderItems(a: { readonly id: string; readonly date: string }, b: { readonly id: string; readonly date: string }): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/**
 * Apply one delta to the rows a surface holds.
 *
 * The result is the same list a full load would have produced: rows are kept in
 * archive order, an updated row keeps its place, and a row that is both added
 * and removed never appears. The cost is linear in the rows held, plus a binary
 * insertion per added row, so a refresh that adds a handful of rows stays cheap
 * on an archive of thousands.
 * @param base - the rows the surface holds, in archive order.
 * @param delta - what the Host reports as changed.
 * @returns the rows to hold now.
 */
export function mergeItems(base: readonly Item[], delta: ItemDelta): Item[] {
  const removed = new Set(delta.removed)
  const updated = new Map<string, Item>()
  for (const item of delta.updated) updated.set(item.id, item)
  const out: Item[] = []
  for (const item of base) {
    if (removed.has(item.id)) continue
    out.push(updated.get(item.id) || item)
  }
  if (!delta.added.length) return out
  const present = new Set<string>()
  for (const item of out) present.add(item.id)
  const added: Item[] = []
  for (const item of delta.added) {
    if (removed.has(item.id) || present.has(item.id)) continue
    present.add(item.id)
    added.push(item)
  }
  if (!added.length) return out
  // A handful of rows goes in one at a time; a subscription that lands a whole
  // feed sorts the arrivals and merges them, so nothing pays n^2.
  if (added.length * 8 < out.length) {
    for (const item of added) insertOrdered(out, item)
    return out
  }
  added.sort(orderItems)
  const merged: Item[] = []
  let left = 0
  let right = 0
  while (left < out.length && right < added.length) {
    if (orderItems(out[left], added[right]) <= 0) merged.push(out[left++])
    else merged.push(added[right++])
  }
  while (left < out.length) merged.push(out[left++])
  while (right < added.length) merged.push(added[right++])
  return merged
}

/** Insert one row where the archive order puts it. */
function insertOrdered(rows: Item[], item: Item): void {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (orderItems(rows[mid], item) <= 0) lo = mid + 1
    else hi = mid
  }
  rows.splice(lo, 0, item)
}
