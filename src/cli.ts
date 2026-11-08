/**
 * The gitfeed command line.
 *
 * The plugin package is code only, so the data repository — which is usually
 * private and holds `feeds.json`, `config.json`, and `data/` — needs a way to
 * run the fetcher without checking the code out. This CLI imports the same
 * `lib/host` modules the native plugin uses, so cron, the agent tool, and the
 * reader cannot drift.
 *
 * It runs from a checkout of the data repository (`--root` defaults to the
 * current directory) or against any data root on disk.
 */

import path from 'node:path'
import { runFetch } from './host/fetch.js'
import { importOpml } from './host/opml.js'
import { scaffoldData, starterFiles } from './host/scaffold.js'
import { expandHome } from './host/settings.js'

interface Flags {
  root?: string
  only?: string
  dataDir?: string
  dryRun?: boolean
  refresh?: boolean
  replace?: boolean
  help?: boolean
}

const USAGE = `gitfeed — fetch feeds and manage a gitfeed data root

usage: gitfeed <command> [options]

commands:
  fetch                    fetch every subscribed feed into data/
  import-opml <file>       merge an OPML export into feeds.json
  init [dir]               create a starter data root

options:
  --root <dir>             data root (default: $GITFEED_REPO, else the current directory)
  --only <feed-id>         fetch exactly one feed
  --data-dir <dir>         output directory relative to the root (default: data)
  --dry-run                fetch and report without writing
  --refresh                ignore the cached ETag and re-read every feed (after
                           changing fetch.maxSummaryChars, so long bodies heal)
  --replace                import-opml: replace the subscription list
  -h, --help               show this help

There is no server-side job: the reader and the CLI fetch from wherever they
run, and the git remote is wherever that checkout pushes. The reader's fast
local refresh runs the same fetcher and writes to the gitignored .local/ cache
instead of data/.
`

function message(err: unknown): string {
  if (typeof err === 'string') return err.trim() || 'unknown error'
  if (err instanceof Error) return err.message.trim() || 'unknown error'
  const failure = err as { message?: unknown } | null
  return typeof failure?.message === 'string' && failure.message.trim() ? failure.message.trim() : 'unknown error'
}

function parseArgv(argv: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    function value(name: string): string {
      const next = argv.at(++i)
      if (next === undefined || next.startsWith('--')) throw new Error(`missing value for ${name}`)
      return next
    }
    if (arg === '-h' || arg === '--help') flags.help = true
    else if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--refresh') flags.refresh = true
    else if (arg === '--replace') flags.replace = true
    else if (arg === '--root') flags.root = value('--root')
    else if (arg.startsWith('--root=')) flags.root = arg.slice('--root='.length)
    else if (arg === '--only') flags.only = value('--only')
    else if (arg.startsWith('--only=')) flags.only = arg.slice('--only='.length)
    else if (arg === '--data-dir') flags.dataDir = value('--data-dir')
    else if (arg.startsWith('--data-dir=')) flags.dataDir = arg.slice('--data-dir='.length)
    else if (arg.startsWith('-') && arg !== '-') throw new Error(`unknown option ${arg}`)
    else positional.push(arg)
  }
  return { flags: flags, positional: positional }
}

function dataRoot(flags: Flags, explicit?: string): string {
  const raw = (explicit || flags.root || process.env.GITFEED_REPO || '').trim()
  return path.resolve(expandHome(raw || process.cwd()))
}

async function commandFetch(flags: Flags): Promise<number> {
  const root = dataRoot(flags)
  const result = await runFetch({
    root: root,
    dataDir: flags.dataDir,
    only: flags.only,
    dryRun:  flags.dryRun,
    refresh:  flags.refresh,
    onLog: function (line: string) { console.log(line) },
  })
  return result.code
}

async function commandImport(flags: Flags, positional: string[]): Promise<number> {
  const file = positional[1] || ''
  if (!file) {
    console.error('usage: gitfeed import-opml <file.opml> [--root <dir>] [--replace]')
    return 2
  }
  const root = dataRoot(flags)
  const summary = await importOpml(root, file, { replace:  flags.replace })
  console.log(`imported   ${summary.total} feed(s) from ${path.basename(file)}`)
  console.log(`new        ${summary.added}${summary.updated ? `, ${summary.updated} updated` : ''}${summary.kept ? `, ${summary.kept} kept from feeds.json` : ''}`)
  if (summary.duplicates) console.log(`duplicates ${summary.duplicates} skipped`)
  if (summary.invalid) console.log(`invalid    ${summary.invalid} skipped`)
  for (const folder of Object.keys(summary.folders).sort()) {
    console.log(`  ${String(summary.folders[folder]).padStart(4)}  ${folder}`)
  }
  return 0
}

function commandInit(flags: Flags, positional: string[]): number {
  const target = dataRoot(flags, positional[1])
  const result = scaffoldData(target)
  if (!result.seeded) {
    console.error(
      result.reason === 'present'
        ? `gitfeed: ${target} already has feeds.json`
        : `gitfeed: ${target} is not empty; refusing to write into it`,
    )
    return 1
  }
  console.log(`created ${target}`)
  console.log(`  ${starterFiles().join('  ')}`)
  console.log('git init, add a remote, and commit when you want the data backed up')
  console.log("add a feed with `gitfeed import-opml <file>` or the reader's Add feed box")
  return 0
}

/**
 * Run one command.
 * @param argv arguments after the program name.
 * @returns process exit code.
 */
export async function main(argv: string[]): Promise<number> {
  let flags: Flags
  let positional: string[]
  try {
    const parsed = parseArgv(argv)
    flags = parsed.flags
    positional = parsed.positional
  } catch (err) {
    console.error(`gitfeed: ${message(err)}`)
    console.error(USAGE)
    return 2
  }
  if (flags.help) {
    console.log(USAGE)
    return 0
  }
  const command = positional[0]
  if (!command) {
    console.error(USAGE)
    return 2
  }
  try {
    if (command === 'fetch') return await commandFetch(flags)
    if (command === 'import-opml') return await commandImport(flags, positional)
    if (command === 'init') return commandInit(flags, positional)
    console.error(`gitfeed: unknown command ${JSON.stringify(command)}`)
    console.error(USAGE)
    return 2
  } catch (err) {
    console.error(`gitfeed: ${message(err)}`)
    return 1
  }
}
