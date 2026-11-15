/**
 * What the reader's attention says about its sources, and how much of it is
 * still worth counting.
 *
 * Two acts say a source is worth the reader's time: opening one of its rows to
 * read the article, and starring one. The read mark is deliberately not one of
 * them — most rows are marked read by a scroll past the band or by a bulk mark,
 * so the read set is saturated: every source looks equally read, and the marks
 * that were a choice cannot be told apart from the ones that were traffic.
 *
 * An event's weight halves every month, so the order follows habits rather than
 * a lifetime tally, and a source that stops earning attention fades out of the
 * ranked part of the list instead of sinking below it. A score under
 * {@link INTEREST_MIN_SCORE} is not a place in the order at all: the rest of the
 * list stays in name order, which is the one order that never buries a source
 * the reader has not tried yet.
 */

/** The acts that count. A star is deliberate, an open is the row being read. */
export type InterestKind = 'open' | 'star'

/** One act, as the Host's append-only log stores it. */
export interface InterestEvent {
  kind: InterestKind
  /** The source the act belongs to; stored, because the archive is pruned. */
  feed: string
  /** The row that was opened or starred; one row counts once. */
  item: string
  /** When the act happened, ISO 8601. */
  at: string
}

/** How long an act takes to count half as much. */
export const INTEREST_HALF_LIFE_DAYS = 30

/**
 * How much attention a source needs to earn a place ahead of the names.
 *
 * Half an open, which is one open that has not yet aged out: a source stays in
 * the ranked part while the reader has opened something from it in the last
 * month or so, and an order built from older acts is the only thing this bar
 * drops. Below it a source keeps its alphabetical place with the ones the
 * reader has never touched.
 */
export const INTEREST_MIN_SCORE = 0.5

/**
 * What one act is worth, in "opens". A star is the reader saying so on purpose;
 * opening a row is the reader reading it. Three opens weigh as much as a star.
 */
export const INTEREST_WEIGHT: Readonly<Record<InterestKind, number>> = { open: 1, star: 3 }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The identity of one act, for the two places that must not count it twice: the
 * Host's log (an item is appended once) and the score (a topic republished under
 * two ids, or a row opened on two visits, is still one argument for its source).
 * @param event - the act, or the shape a log row was read as.
 * @returns a key that is stable across writes of the same act.
 */
export function interestKey(event: { kind?: string; item?: string; feed?: string; at?: string }): string {
  const item = typeof event.item === 'string' ? event.item : ''
  if (item) return `${event.kind || ''}\u0000${item}`
  return `${event.kind || ''}\u0000${event.feed || ''}\u0000${event.at || ''}`
}

/** Whether a value read back from a log is a kind this build knows. */
export function isInterestKind(value: unknown): value is InterestKind {
  return value === 'open' || value === 'star'
}

/**
 * Turn a log into one score per source, with everything already decayed to
 * `nowMs`.
 *
 * The result carries only the sources that earned a place; a caller orders by
 * these and falls back to the name for the rest. Values are rounded to three
 * decimals so two reads of the same log describe the same order to the reader
 * and to a test. Rows are expected to be events: the log reader drops the ones
 * a hand edit or an older build left unusable, before they reach this.
 * @param events - the log, oldest first or in any other order.
 * @param nowMs - wall clock the decay is measured against, in ms.
 * @returns the ranked sources and their scores; unranked ones are absent.
 */
export function interestScores(
  events: readonly InterestEvent[],
  nowMs: number,
): Record<string, number> {
  const seen = new Set<string>()
  const scores = new Map<string, number>()
  for (const event of events) {
    const at = Date.parse(event.at)
    if (!Number.isFinite(at)) continue
    const key = interestKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    // A clock that moved backwards dates an act in the future; it is new, not
    // stronger than new.
    const ageDays = Math.max(0, nowMs - at) / DAY_MS
    const score = INTEREST_WEIGHT[event.kind] * Math.pow(2, -ageDays / INTEREST_HALF_LIFE_DAYS)
    scores.set(event.feed, (scores.get(event.feed) || 0) + score)
  }
  const ranked: Record<string, number> = {}
  for (const [feed, score] of scores) {
    if (score < INTEREST_MIN_SCORE) continue
    ranked[feed] = Math.round(score * 1000) / 1000
  }
  return ranked
}
