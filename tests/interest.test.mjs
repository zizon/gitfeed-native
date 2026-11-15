// The attention log and the score built from it, exercised without a browser or
// a Host: which acts count, how fast they fade, when a source has not earned a
// place at all, and the two file rules the log lives under — one row per act,
// and a merge rule so two machines can append to it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { finish, lib, ok } from './harness.mjs'

const theory = await import(lib('shared', 'interest.js'))
const log = await import(lib('host', 'interest.js'))

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString()
const open = (feed, item, daysAgo) => ({ kind: 'open', feed: feed, item: item, at: at(daysAgo) })
const star = (feed, item, daysAgo) => ({ kind: 'star', feed: feed, item: item, at: at(daysAgo) })

// --- the score: what one act says ---
const one = theory.interestScores([open('a', 'i1', 0)], NOW)
ok(one.a === 1, 'one open is one point for its source', one)
ok(one.b === undefined, 'and says nothing about any other source', Object.keys(one))

const starred = theory.interestScores([star('a', 'i1', 0)], NOW)
ok(starred.a === 3, 'a star is worth three opens, because it is said on purpose', starred)

const both = theory.interestScores([star('a', 'i1', 0), open('a', 'i1', 0)], NOW)
ok(both.a === 4, 'the same row starred and opened is two acts', both)

// --- the score: how fast it fades ---
const faded = theory.interestScores([star('a', 'i1', 30)], NOW)
ok(faded.a === 1.5, 'an act a month old counts half', faded)
const month = theory.interestScores([open('a', 'i1', 30)], NOW)
ok(month.a === 0.5, 'and the last month of reading is what the bar is made of', month)
const older = theory.interestScores([open('a', 'i1', 60)], NOW)
ok(older.a === undefined, 'a source not opened for two months is out of the order', older)

// --- the score: what does not count ---
const twice = theory.interestScores([open('a', 'i1', 0), open('a', 'i1', 0)], NOW)
ok(twice.a === 1, 'the same row twice is one act', twice)
const stale = theory.interestScores([open('a', 'i1', 40)], NOW)
ok(stale.a === undefined, 'a stray open six weeks ago has aged out of the list', stale)
const ahead = theory.interestScores([open('a', 'i1', -1)], NOW)
ok(ahead.a === 1, 'a clock that moved backwards dates an act as new, not stronger', ahead)

// --- the log: appending, dedupe, and the rules the repository needs ---
const root = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-interest-'))
try {
  const file = path.join(root, 'data', 'interest.ndjson')
  writeFileSync(path.join(root, '.gitattributes'), 'data/read.ndjson merge=union\n')

  ok(await log.recordAttention(file, open('feed-a', 'row-1', 0)) === true, 'an act is appended')
  ok(await log.recordAttention(file, open('feed-a', 'row-1', 0)) === false, 'the same act is not appended twice')
  ok(await log.recordAttention(file, star('feed-b', 'row-2', 0)) === true, 'a different act is')
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  ok(rows.length === 2 && rows[0].kind === 'open' && rows[1].kind === 'star', 'the log holds one row per act', rows)

  const attributes = readFileSync(path.join(root, '.gitattributes'), 'utf8')
  ok(attributes.startsWith('data/read.ndjson merge=union\n'), 'the existing merge rules are kept', attributes)
  ok(attributes.split('\n').filter((line) => line === 'data/interest.ndjson merge=union').length === 1,
    'and the log gets its own, once', attributes)

  const scores = await log.interestOf(file, NOW)
  ok(scores['feed-a'] === 1 && scores['feed-b'] === 3, 'the log scores to the sources that earned it', scores)

  // --- a root from before the log is seeded from the stars it already has ---
  const old = path.join(root, 'old')
  const oldFile = path.join(old, 'data', 'interest.ndjson')
  writeFileSync(path.join(root, 'placeholder'), '')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(old, { recursive: true })
  const items = [
    { id: 's1', feed: 'feed-s', title: 'one', link: '', date: at(0), author: '', summary: '' },
    { id: 's2', feed: 'feed-t', title: 'two', link: '', date: at(0), author: '', summary: '' },
  ]
  ok(await log.seedFromStars(oldFile, ['s1', 'gone'], items, NOW) === true, 'a root with stars and no log is seeded')
  const seeded = readFileSync(oldFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  ok(seeded.length === 1 && seeded[0].kind === 'star' && seeded[0].feed === 'feed-s',
    'with the stars whose row is still in the archive', seeded)
  ok(await log.seedFromStars(oldFile, ['s2'], items, NOW) === false, 'and a log that exists is never reseeded')

  // --- a log row that is not an act costs one row, not the read ---
  const damaged = path.join(root, 'damaged.ndjson')
  writeFileSync(damaged, [
    'not json',
    '',
    JSON.stringify({ kind: 'shrug', feed: 'x', item: '1', at: at(0) }),
    JSON.stringify({ kind: 'open', feed: 'y', item: '2', at: 'not a date' }),
    JSON.stringify({ kind: 'open', feed: 'z', item: '3', at: at(0) }),
  ].join('\n'))
  const read = await log.readInterest(damaged)
  ok(read.length === 1 && read[0].feed === 'z', 'an unusable row is dropped, and the rest still read', read)
} finally {
  rmSync(root, { recursive: true, force: true })
}

finish()
