// Per-feed clocks for the fetch job.
//
// The scheduler gives the fetch job one job-level interval, but a reader
// subscribes to feeds that publish at very different rates. Each feed
// therefore carries its own `nextAt`: a feed that keeps producing items stays
// at the base interval, while a quiet feed doubles its interval up to the
// ceiling. A failure is not the same thing as quiet — it says the feed did not
// answer, which is either a broken source or a missing network — so a failure
// leaves the feed's interval alone and only schedules its next attempt, while
// a run that reached *nothing* is the network and leaves every clock untouched
// except the attempt itself. The fetch job stores these clocks in its own
// payload inside `.local/schedule.json`; they are machine-local and never
// committed.

/** One feed's place in the fetch schedule. */
export interface FeedScheduleEntry {
  /**
   * Minutes this feed waits between fetches *when it answers* — the cadence
   * its publishing rate earned. A failure does not change it; it only moves
   * `nextAt` to the retry.
   */
  intervalMin: number
  /** Epoch milliseconds of the next fetch, retry or cadence. */
  nextAt: number
  /** Consecutive failed runs; cleared by the next run that reaches the feed. */
  failures?: number
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
 * A feed that produced items returns to the base interval; one that answered
 * but had nothing new doubles the interval it had earned. A failure is a
 * *retry*, not a cadence: it leaves that interval alone — "this feed is slow"
 * and "this feed did not answer" are different facts, and letting a missed
 * connection consume the first one parked an active feed for a day after one
 * bad afternoon — and only schedules the next attempt, doubling per
 * consecutive failure up to the ceiling.
 *
 * A run that reached nothing at all is the network, not the feeds
 * (`offline`): every feed keeps its cadence *and* its failure streak, and the
 * whole set is due again in one base interval, so the reader is back within
 * minutes of the connection returning instead of on the ladder an hour later.
 * Feeds move on independent clocks, which is what keeps a rarely updated
 * source from being polled on every run.
 * @param clocks the fetch job's per-feed clocks, updated in place.
 * @param outcomes per-feed results of the run.
 * @param options clock and interval bounds, all in minutes except `nowMs`, and
 *   whether the run itself was a network miss.
 */
export function applyRun(
  clocks: FeedClocks,
  outcomes: Record<string, FeedOutcome>,
  options: { nowMs: number; baseMin: number; maxMin: number; offline?: boolean },
): void {
  const base = Math.max(1, Math.round(options.baseMin))
  const max = Math.max(base, Math.round(options.maxMin))
  const offline = options.offline === true
  for (const id of Object.keys(outcomes)) {
    const outcome = outcomes[id]
    const prev = clocks[id]
    const current = prev && prev.intervalMin > 0 ? prev.intervalMin : base
    const streak = prev && prev.failures ? prev.failures : 0
    if (outcome.failed === true) {
      if (offline) {
        // Not judged: keep the clock the feed had, and look again soon.
        const kept: FeedScheduleEntry = { intervalMin: current, nextAt: options.nowMs + base * 60000 }
        if (streak) kept.failures = streak
        clocks[id] = kept
        continue
      }
      const failures = streak + 1
      const retryMin = Math.min(max, Math.max(base, base * 2 ** (failures - 1)))
      clocks[id] = {
        intervalMin: current,
        nextAt: options.nowMs + retryMin * 60000,
        failures: failures,
      }
      continue
    }
    const fresh = outcome.added > 0
    const intervalMin = fresh ? base : Math.min(max, Math.max(base, current * 2))
    clocks[id] = {
      intervalMin: intervalMin,
      nextAt: options.nowMs + intervalMin * 60000,
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
