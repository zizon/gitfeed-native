// First-run scaffolding for a data root that has nothing in it yet.
//
// The plugin package is code only. The data it reads — subscriptions, config,
// fetched items, read/star state — belongs to a separate, usually private
// repository (see the README's storage model). When that root has never been
// created, this writes a minimal but complete starting point so the reader
// mounts with an empty inbox instead of an error, and so `git init` in that
// directory immediately has the merge rules and ignore list it needs.

import fs from 'node:fs'
import path from 'node:path'
import { pathsFor } from './settings.js'

/** Entries that do not make a directory "someone else's data". */
const IGNORED_ENTRIES = new Set(['.git', '.DS_Store', '.local'])

const FEEDS = `${JSON.stringify({
  '$comment': 'Subscription list. Edit by hand, use Add feed in the reader, or run `gitfeed import-opml`; then Sync.',
  feeds: [],
}, null, 2)}\n`

const CONFIG = `${JSON.stringify({
  fetch: { concurrency: 6, timeoutMs: 25000, keepMonths: 6, maxSummaryChars: 2500 },
  reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
}, null, 2)}\n`

const GITATTRIBUTES = [
  '# Read/star state is append-only (one id per line). Union merge means two',
  '# machines marking different items read can never conflict.',
  'data/read.ndjson merge=union',
  'data/starred.ndjson merge=union',
  '# Item shards are appended to by CI only; union keeps a racing local push safe.',
  'data/items/*.ndjson merge=union',
  '',
].join('\n')

const GITIGNORE = [
  '# local refresh cache (never committed)',
  '.local/',
  '.DS_Store',
  '*.log',
  '.tmp/',
  'node_modules/',
  '',
].join('\n')

/** Relative path -> content for a starter data root. */
const STARTER_FILES: Array<[string, string]> = [
  ['feeds.json', FEEDS],
  ['config.json', CONFIG],
  ['data/meta.json', '{}\n'],
  ['data/read.ndjson', ''],
  ['data/starred.ndjson', ''],
  ['.gitattributes', GITATTRIBUTES],
  ['.gitignore', GITIGNORE],
]

export interface ScaffoldResult {
  seeded: boolean
  reason: 'seeded' | 'present' | 'not-empty'
}

function isPristine(dir: string): boolean {
  try {
    return fs.readdirSync(dir).every(function (name) { return IGNORED_ENTRIES.has(name) })
  } catch {
    return false
  }
}

function writeIfMissing(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(file, text, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

/**
 * Create the starter data root in `root` when it has no reader yet.
 *
 * A missing root is created; an existing root is filled only when it holds
 * nothing but a `.git`, `.local`, or `.DS_Store`. A root that already has
 * `feeds.json` is left untouched.
 * @param root absolute data root.
 * @returns what happened, for the caller's log line.
 */
export function scaffoldData(root: string): ScaffoldResult {
  const resolved = path.resolve(root)
  if (fs.existsSync(pathsFor(resolved).feeds)) return { seeded: false, reason: 'present' }
  if (fs.existsSync(resolved) && !isPristine(resolved)) return { seeded: false, reason: 'not-empty' }
  for (const [relative, text] of STARTER_FILES) {
    writeIfMissing(path.join(resolved, relative), text)
  }
  return { seeded: true, reason: 'seeded' }
}

/**
 * The files a starter root contains, for the CLI's confirmation output.
 * @returns relative paths.
 */
export function starterFiles(): string[] {
  return STARTER_FILES.map(function (entry) { return entry[0] })
}
