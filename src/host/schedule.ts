// Per-feed refresh policy.
//
// The reader's schedule has two layers. A global minimum interval keeps any two
// refresh runs apart (the plugin's `refreshMinutes`), and every feed carries its
// own `nextAt`: a feed that keeps producing items stays at the minimum, while a
// quiet or failing feed doubles its interval up to a ceiling. The state is a
// property of this machine's network and habits, so it lives in the gitignored
// `.local` cache and never enters the data repository.

import { readJson, writeJson } from './store.js'
import { pathsFor } from './settings.js'

/** One feed's place in the refresh schedule. */
export interface FeedScheduleEntry {
  /** Minutes this feed waits between fetches. */
  intervalMin: number
  /** Epoch milliseconds of the next fetch. */
  nextAt: number
  /** Consecutive runs that produced nothing new (or failed). */
  quiet: number
  lastFetchAt: number
  lastFreshAt: number
}

export interface ScheduleState {
  version: 1
  feeds: Record<string, FeedScheduleEntry | undefined>
  /** Last completed run, so a restart still reports when and what it did. */
  lastRun?: import('../shared/types.js').LocalFetchRun | null
}

/** What one run observed for one feed, as `runFetch` reports it. */
export interface FeedOutcome {
  added: number
  failed?: boolean
}

export function emptySchedule(): ScheduleState {
  return { version: 1, feeds: {} }
}

function isEntry(value: unknown): value is FeedScheduleEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return Number.isFinite(entry.intervalMin) && Number.isFinite(entry.nextAt)
}

/** Read the local schedule; a missing or unreadable file starts an empty one. */
export async function readSchedule(root: string): Promise<ScheduleState> {
  const raw = await readJson<Record<string, unknown> | null>(pathsFor(root).localSchedule, null)
  if (!raw || raw.version !== 1) return emptySchedule()
  const feeds: Record<string, FeedScheduleEntry | undefined> = {}
  const source = raw.feeds
  if (source && typeof source === 'object') {
    for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
      if (isEntry(value)) feeds[id] = value
    }
  }
  const lastRun = raw.lastRun
  const state: ScheduleState = { version: 1, feeds: feeds }
  if (lastRun && typeof lastRun === 'object') state.lastRun = lastRun as import('../shared/types.js').LocalFetchRun
  return state
}

/** Persist the schedule in the gitignored cache. */
export async function writeSchedule(root: string, state: ScheduleState): Promise<void> {
  const feeds: Record<string, FeedScheduleEntry | undefined> = {}
  for (const id of Object.keys(state.feeds).sort()) feeds[id] = state.feeds[id]
  const payload: Record<string, unknown> = { version: 1, feeds: feeds }
  if (state.lastRun) payload.lastRun = state.lastRun
  await writeJson(pathsFor(root).localSchedule, payload)
}

/**
 * Feeds whose next fetch is due, in subscription order.
 * @param state the persisted schedule.
 * @param feedIds the ids currently subscribed.
 * @param nowMs current epoch milliseconds.
 * @returns ids to fetch now.
 */
export function dueFeeds(state: ScheduleState, feedIds: string[], nowMs: number): string[] {
  return feedIds.filter(function (id) {
    const entry = state.feeds[id]
    return !entry || entry.nextAt <= nowMs
  })
}

/**
 * Earliest scheduled fetch across the subscribed feeds.
 * @param state the persisted schedule.
 * @param feedIds the ids currently subscribed.
 * @param nowMs current epoch milliseconds; a feed with no entry is due now.
 * @returns epoch milliseconds, or null when the schedule is empty.
 */
export function nextDueAt(state: ScheduleState, feedIds: string[], nowMs: number): number | null {
  let earliest: number | null = null
  for (const id of feedIds) {
    const entry = state.feeds[id]
    if (!entry) return nowMs
    if (earliest === null || entry.nextAt < earliest) earliest = entry.nextAt
  }
  return earliest
}

/**
 * Fold one run's outcome into the schedule.
 *
 * A feed that produced items returns to the minimum interval; one that was
 * unchanged, not modified, or failed doubles its current interval. Feeds move
 * on independent clocks, which is what keeps a rarely updated source from
 * being polled on every run.
 * @param state the schedule to update in place.
 * @param outcomes per-feed results of the run.
 * @param options clock and interval bounds, all in minutes except `nowMs`.
 */
export function applyRun(
  state: ScheduleState,
  outcomes: Record<string, FeedOutcome>,
  options: { nowMs: number; baseMin: number; maxMin: number },
): void {
  const base = Math.max(1, Math.round(options.baseMin))
  const max = Math.max(base, Math.round(options.maxMin))
  for (const id of Object.keys(outcomes)) {
    const outcome = outcomes[id]
    const prev = state.feeds[id]
    const current = prev && prev.intervalMin > 0 ? prev.intervalMin : base
    const fresh = outcome.added > 0
    const intervalMin = fresh ? base : Math.min(max, Math.max(base, current * 2))
    state.feeds[id] = {
      intervalMin: intervalMin,
      nextAt: options.nowMs + intervalMin * 60000,
      quiet: fresh ? 0 : (prev ? prev.quiet + 1 : 1),
      lastFetchAt: options.nowMs,
      lastFreshAt: fresh ? options.nowMs : (prev ? prev.lastFreshAt : 0),
    }
  }
}

/** Drop entries for feeds that are no longer subscribed. */
export function pruneSchedule(state: ScheduleState, feedIds: string[]): number {
  const live = new Set(feedIds)
  let dropped = 0
  for (const id of Object.keys(state.feeds)) {
    if (live.has(id)) continue
    Reflect.deleteProperty(state.feeds, id)
    dropped++
  }
  return dropped
}
