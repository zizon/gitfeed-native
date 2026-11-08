// Per-feed clocks for the fetch job.
//
// The scheduler gives the fetch job one job-level interval, but a reader
// subscribes to feeds that publish at very different rates. Each feed
// therefore carries its own `nextAt`: a feed that keeps producing items stays
// at the base interval, while a quiet or failing feed doubles its interval up
// to the ceiling. The fetch job stores these clocks in its own payload inside
// `.local/schedule.json`; they are machine-local and never committed.

/** One feed's place in the fetch schedule. */
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

export type FeedClocks = Record<string, FeedScheduleEntry | undefined>

/** What one run observed for one feed, as `runFetch` reports it. */
export interface FeedOutcome {
  added: number
  failed?: boolean
}

/**
 * Feeds whose next fetch is due, in subscription order.
 * @param clocks the fetch job's per-feed clocks.
 * @param feedIds the ids currently subscribed.
 * @param nowMs current epoch milliseconds.
 * @returns ids to fetch now.
 */
export function dueFeeds(clocks: FeedClocks, feedIds: string[], nowMs: number): string[] {
  return feedIds.filter(function (id) {
    const entry = clocks[id]
    return !entry || entry.nextAt <= nowMs
  })
}

/**
 * Earliest scheduled fetch across the subscribed feeds.
 * @param clocks the fetch job's per-feed clocks.
 * @param feedIds the ids currently subscribed.
 * @param nowMs current epoch milliseconds; a feed with no entry is due now.
 * @returns epoch milliseconds, or null when there is nothing subscribed.
 */
export function nextDueAt(clocks: FeedClocks, feedIds: string[], nowMs: number): number | null {
  if (feedIds.length === 0) return null
  let earliest: number | null = null
  for (const id of feedIds) {
    const entry = clocks[id]
    if (!entry) return nowMs
    if (earliest === null || entry.nextAt < earliest) earliest = entry.nextAt
  }
  return earliest
}

/**
 * Fold one run's outcome into the per-feed clocks.
 *
 * A feed that produced items returns to the base interval; one that was
 * unchanged, not modified, or failed doubles its current interval. Feeds move
 * on independent clocks, which is what keeps a rarely updated source from
 * being polled on every run.
 * @param clocks the fetch job's per-feed clocks, updated in place.
 * @param outcomes per-feed results of the run.
 * @param options clock and interval bounds, all in minutes except `nowMs`.
 */
export function applyRun(
  clocks: FeedClocks,
  outcomes: Record<string, FeedOutcome>,
  options: { nowMs: number; baseMin: number; maxMin: number },
): void {
  const base = Math.max(1, Math.round(options.baseMin))
  const max = Math.max(base, Math.round(options.maxMin))
  for (const id of Object.keys(outcomes)) {
    const outcome = outcomes[id]
    const prev = clocks[id]
    const current = prev && prev.intervalMin > 0 ? prev.intervalMin : base
    const fresh = outcome.added > 0
    const intervalMin = fresh ? base : Math.min(max, Math.max(base, current * 2))
    clocks[id] = {
      intervalMin: intervalMin,
      nextAt: options.nowMs + intervalMin * 60000,
      quiet: fresh ? 0 : (prev ? prev.quiet + 1 : 1),
      lastFetchAt: options.nowMs,
      lastFreshAt: fresh ? options.nowMs : (prev ? prev.lastFreshAt : 0),
    }
  }
}

/** Drop clocks for feeds that are no longer subscribed. */
export function pruneSchedule(clocks: FeedClocks, feedIds: string[]): number {
  const live = new Set(feedIds)
  let dropped = 0
  for (const id of Object.keys(clocks)) {
    if (live.has(id)) continue
    Reflect.deleteProperty(clocks, id)
    dropped++
  }
  return dropped
}
