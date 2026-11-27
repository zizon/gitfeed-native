// First-run scaffolding for a data root that has nothing in it yet.
//
// The plugin package is code only; the data it reads — subscriptions, config,
// fetched items, read/star state — belongs to a separate, usually private git
// repository. When a root has never been created, this writes a minimal but
// complete starting point so the reader mounts with an empty inbox instead of
// an error. The starter files carry the merge attributes and ignore list a data
// repository needs, and the root is initialised as a git repository on `main`,
// so the only thing left to do is add a remote. Fetches happen where the reader
// runs; nothing here assumes a server.

import { spawnSync } from 'node:child_process'
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
  fetch: { concurrency: 6, timeoutMs: 25000, keepMonths: 6, maxSummaryChars: 0 },
  reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
}, null, 2)}\n`

const GITATTRIBUTES = [
  '# Read/star state is append-only (one id per line). Union merge means two',
  '# machines marking different items read can never conflict.',
  'data/read.ndjson merge=union',
  'data/starred.ndjson merge=union',
  '# The attention log is append-only (one act per line).',
  'data/interest.ndjson merge=union',
  '# Item shards are appended to by fetches; union keeps a',
  '# racing push from colliding.',
  'data/items/*.ndjson merge=union',
  '',
].join('\n')

const GITIGNORE = [
  '# local refresh cache (never committed)',
  '.local/',
  '.DS_Store',
  '*.log',
  '.tmp/',
  '# a half-written replacement, from an interrupted write',
  '*.tmp',
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
  ['data/interest.ndjson', ''],
  ['.gitattributes', GITATTRIBUTES],
  ['.gitignore', GITIGNORE],
]

export interface ScaffoldResult {
  seeded: boolean
  reason: 'seeded' | 'present' | 'not-empty'
  /** Whether this call created the git repository. */
  repo: boolean
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
 * Make `root` a git repository on `main` when it is not one already.
 *
 * The scaffolder writes the merge attributes and the ignore list, so a seeded
 * root is ready to become a data repository; without this step the first thing
 * a new reader is told is to `git init`, which gets the branch and the ignore
 * file right only if the user remembers both. No commit is made: the first
 * `Sync reads` takes the seeded tree as its baseline once a remote exists.
 * @param root absolute data root.
 * @returns whether this call created the repository.
 */
export function initDataRepo(root: string): boolean {
  if (fs.existsSync(path.join(root, '.git'))) return false
  const created = spawnSync('git', ['init', '-b', 'main', root], { encoding: 'utf8' })
  // A missing `git` is not the reader's problem: the files are still usable
  // without a repository, and the status line says the root is a local copy.
  if (created.error) return false
  if (created.status === 0) return true
  // `-b` needs git 2.28; an older one still gets the branch the data wants.
  const legacy = spawnSync('git', ['init', root], { encoding: 'utf8' })
  if (legacy.error || legacy.status !== 0) return false
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root, encoding: 'utf8' })
  return true
}

/**
 * Create the starter data root in `root` when it has no reader yet.
 *
 * A missing root is created; an existing root is filled only when it holds
 * nothing but a `.git`, `.local`, or `.DS_Store`. A root that already has
 * `feeds.json` is left untouched. A seeded root is initialised as a git
 * repository on `main` unless it already is one.
 * @param root absolute data root.
 * @returns what happened, for the caller's log line.
 */
export function scaffoldData(root: string): ScaffoldResult {
  const resolved = path.resolve(root)
  if (fs.existsSync(pathsFor(resolved).feeds)) return { seeded: false, reason: 'present', repo: false }
  if (fs.existsSync(resolved) && !isPristine(resolved)) return { seeded: false, reason: 'not-empty', repo: false }
  for (const [relative, text] of STARTER_FILES) {
    writeIfMissing(path.join(resolved, relative), text)
  }
  return { seeded: true, reason: 'seeded', repo: initDataRepo(resolved) }
}

/**
 * The files a starter root contains, for the CLI's confirmation output.
 * @returns relative paths.
 */
export function starterFiles(): string[] {
  return STARTER_FILES.map(function (entry) { return entry[0] })
}
