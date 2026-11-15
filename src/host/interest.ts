// The attention log: a committed, append-only record of the two acts that say a
// source is worth the reader's time. It lives beside the read and star state
// because it is the same kind of thing — reader state, written here, carried to
// another machine by Sync — and it is append-only for the same reason: two
// machines that write different rows can never conflict. The theory of what the
// rows mean is in `shared/interest.ts`; this module only reads, appends, and
// bootstraps the file.

import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appendNdjson, readNdjson, writeNdjson } from './store.js'
import { interestKey, interestScores, isInterestKind } from '../shared/interest.js'
import type { InterestEvent } from '../shared/interest.js'
import type { Item } from '../shared/types.js'

/**
 * The merge rule the data repository needs for this file. Appending on two
 * machines is the normal case, not a race to resolve: `union` keeps both sides.
 */
const MERGE_RULE = 'data/interest.ndjson merge=union'
const MERGE_COMMENT = '# The attention log is append-only (one act per line).'
/** Roots whose `.gitattributes` this process has already looked at. */
const ruleChecked = new Set<string>()
/** Logs this process has read, and the acts they already hold. */
const knownKeys = new Map<string, Set<string>>()

/**
 * The acts the log holds, as far as they are readable as acts.
 *
 * A row a hand edit or an older build left unusable is dropped here rather than
 * at the score: a log is committed history, and one bad line must cost one line,
 * not the state read that would have shown the reader its list.
 * @param file - absolute path of the log.
 * @returns the usable rows, in the order they were appended.
 */
export async function readInterest(file: string): Promise<InterestEvent[]> {
  // A line can be any JSON value; `null` is what an emptied row parses to.
  const rows = await readNdjson<Record<string, unknown> | null>(file)
  const events: InterestEvent[] = []
  for (const row of rows) {
    if (!row || !isInterestKind(row.kind)) continue
    const feed = typeof row.feed === 'string' ? row.feed : ''
    const at = typeof row.at === 'string' ? row.at : ''
    if (!feed || !Number.isFinite(Date.parse(at))) continue
    events.push({
      kind: row.kind,
      feed: feed,
      item: typeof row.item === 'string' ? row.item : '',
      at: at,
    })
  }
  return events
}

/**
 * Score every source the reader has shown attention to.
 * @param file - absolute path of the log.
 * @param nowMs - the clock the decay is measured against.
 * @returns the ranked sources and their scores; the rest are absent.
 */
export async function interestOf(file: string, nowMs: number): Promise<Record<string, number>> {
  return interestScores(await readInterest(file), nowMs)
}

/** The acts the log already holds, read once and then kept for the process. */
async function keysOf(file: string): Promise<Set<string>> {
  let keys = knownKeys.get(file)
  if (keys) return keys
  keys = new Set((await readInterest(file)).map(interestKey))
  knownKeys.set(file, keys)
  return keys
}

/**
 * Record one act, unless the log already holds it.
 *
 * A duplicate is answered without a write: the file is committed history, and
 * the same row twice is two arguments for a source that earned one.
 * @param file - absolute path of the log.
 * @param event - the act, already validated by the caller.
 * @returns whether the log grew.
 */
export async function recordAttention(file: string, event: InterestEvent): Promise<boolean> {
  const keys = await keysOf(file)
  const key = interestKey(event)
  if (keys.has(key)) return false
  keys.add(key)
  await ensureMergeRule(path.dirname(path.dirname(file)))
  await appendNdjson(file, [event])
  return true
}

/**
 * Give the log a first entry for the stars the reader already has.
 *
 * Before this feature there was no log, so the one explicit interest signal the
 * archive holds — the starred rows — would otherwise be ignored until the
 * reader starred something again. They are seeded at full weight once, on the
 * first read of a root that has stars and no log; the timestamp is the seed, not
 * a claim about when the star was clicked.
 * @param file - absolute path of the log.
 * @param starred - the starred item ids.
 * @param items - the rows the ids are looked up in, for the source each belongs to.
 * @param nowMs - the seed timestamp.
 * @returns whether a log was written.
 */
export async function seedFromStars(
  file: string,
  starred: readonly string[],
  items: readonly Item[],
  nowMs: number,
): Promise<boolean> {
  if (starred.length === 0) return false
  try {
    await stat(file)
    return false
  } catch {
    // No log yet: this is the first read of a root that predates it.
  }
  const feedOf = new Map<string, string>()
  for (const item of items) feedOf.set(item.id, item.feed)
  const at = new Date(nowMs).toISOString()
  const rows: InterestEvent[] = []
  for (const id of starred) {
    const feed = feedOf.get(id)
    if (feed) rows.push({ kind: 'star', feed: feed, item: id, at: at })
  }
  if (rows.length === 0) return false
  await ensureMergeRule(path.dirname(path.dirname(file)))
  await writeNdjson(file, rows)
  // The write is the log: a later act must not repeat one of these.
  const keys = new Set(rows.map(interestKey))
  knownKeys.set(file, keys)
  return true
}

/**
 * Make sure the data repository merges this log instead of conflicting on it.
 *
 * The seeded roots carry the rule; a root from before this feature does not,
 * and a log pulled from another machine would then collide with the local one.
 * The line is added once, preserving what the file already says.
 * @param root - the data root.
 */
export async function ensureMergeRule(root: string): Promise<void> {
  if (ruleChecked.has(root)) return
  ruleChecked.add(root)
  const file = path.join(root, '.gitattributes')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    // A hand-made root needs the rule as much as a seeded one.
  }
  const lines = text.split('\n')
  if (lines.some(function (line) { return line.trim() === MERGE_RULE })) return
  const head = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
  await writeFile(file, `${head}${MERGE_COMMENT}\n${MERGE_RULE}\n`)
}
