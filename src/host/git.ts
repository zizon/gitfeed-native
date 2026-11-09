// Git operations for the reader: state, pull, and the commit/push sync.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GitActionResult } from './types.js'
import type { GitInfo } from '../shared/types.js'
import { messageOf } from '../shared/errors.js'

const execFileAsync = promisify(execFile)

/**
 * A git failure: the command writes its reason to stderr, which the generic
 * message helper never sees.
 * @param err - the rejected exec.
 * @returns the first lines of stderr, or the message.
 */
function gitMessage(err: unknown): string {
  const failure = err as { stderr?: unknown } | null
  const raw = typeof failure?.stderr === 'string' ? failure.stderr : ''
  // Git's reason is the first lines of stderr; anything else is the message the
  // rest of the package would have reported.
  return raw.trim().split('\n').slice(0, 6).join('\n') || messageOf(err)
}

/**
 * Run one git command in the checkout.
 * @param {string} root checkout directory.
 * @param {string[]} args git arguments.
 * @returns {Promise<string>} stdout.
 */
export async function runGit(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: root,
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return result.stdout || ''
}

/**
 * Branch, dirty state, remotes, and divergence for the status line.
 *
 * The check is `rev-parse --git-dir`, not a branch lookup: a freshly
 * `git init`-ed directory has no HEAD yet but is still a working tree the
 * reader may commit into.
 * @param {string} root checkout directory.
 * @returns {Promise<object>} repository facts.
 */
export async function readGitInfo(root: string): Promise<GitInfo> {
  try {
    await runGit(root, ['rev-parse', '--git-dir'])
  } catch (err) {
    return { repo: false, error: gitMessage(err) }
  }
  try {
    let branch = ''
    try {
      branch = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    } catch {
      // An empty repository has no commit to name.
    }
    // `--no-optional-locks` keeps this probe out of the index: without it a
    // status can take index.lock while the sync job is staging, and the loser
    // reports the checkout as no repository at all.
    const dirty = (await runGit(root, ['--no-optional-locks', 'status', '--porcelain', '--', 'data', 'feeds.json', 'config.json'])).trim().length > 0
    const remotes = (await runGit(root, ['remote'])).trim().split('\n').filter(Boolean)
    let ahead = 0
    let behind = 0
    try {
      const counts = (await runGit(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/)
      ahead = Number(counts[0] || 0)
      behind = Number(counts[1] || 0)
    } catch {
      // no upstream configured
    }
    return { repo: true, branch: branch || null, dirty: dirty, remotes: remotes, ahead: ahead, behind: behind }
  } catch (err) {
    return { repo: false, error: gitMessage(err) }
  }
}

/**
 * Pull with a rebase, preserving uncommitted read state.
 * @param {string} root checkout directory.
 * @returns {Promise<{ok:boolean, action:string, output?:string, error?:string}>} settled result.
 */
export async function pull(root: string): Promise<GitActionResult> {
  try {
    const output = await runGit(root, ['pull', '--rebase', '--autostash'])
    return { ok: true, action: 'pull', output: output.trim() }
  } catch (err) {
    return { ok: false, action: 'pull', error: gitMessage(err) }
  }
}

/** Whether an item shard directory holds anything worth staging. */
function hasShards(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/**
 * Commit the reader's state files, rebase on the remote, and push.
 *
 * A local copy that was attached to a repository in place (`git init`, then a
 * remote) may have no upstream yet and no merge history; the pull is therefore
 * best-effort and the push falls back to `-u origin HEAD`. A rejected push
 * still surfaces the remote's own error. The very first commit of such a
 * directory takes the whole seeded tree as the baseline, so the item shards it
 * copied from the bundle are tracked from then on.
 * @param {string} root checkout directory.
 * @returns {Promise<{ok:boolean, action:string, committed?:boolean, output?:string, error?:string}>} settled result.
 */
export async function sync(root: string): Promise<GitActionResult> {
  try {
    let hasHead = true
    try {
      await runGit(root, ['rev-parse', '--verify', 'HEAD'])
    } catch {
      hasHead = false
    }
    if (hasHead) {
      // Item shards are staged because unsubscribing rewrites them: an
      // unstated deletion leaves the worktree dirty forever and every later
      // sync run rebases for a change it will never commit. Each path is staged
      // only when it exists, because a pathspec that matches nothing is fatal
      // and a hand-made root need not carry every file.
      const targets = ['data/read.ndjson', 'data/starred.ndjson', 'feeds.json', 'config.json']
        .filter(function (rel) { return existsSync(path.join(root, rel)) })
      if (hasShards(path.join(root, 'data', 'items'))) targets.unshift('data/items')
      if (targets.length) await runGit(root, ['add', '--'].concat(targets))
      for (const extra of ['.gitattributes', '.gitignore']) {
        if (existsSync(path.join(root, extra))) await runGit(root, ['add', '--', extra])
      }
    } else {
      // The first commit takes the whole tree, and `add -A` would sweep
      // `.local/` — the machine-local cache — into the data repository when
      // there is no ignore file to stop it.
      if (!existsSync(path.join(root, '.gitignore'))) {
        throw new Error(`gitfeed: ${root} has no .gitignore, so a first commit would include .local/ (the refresh cache) — add one, then Sync again`)
      }
      await runGit(root, ['add', '-A'])
    }
    let staged = ''
    try {
      staged = await runGit(root, ['diff', '--cached', '--name-only'])
    } catch {
      staged = ''
    }
    let committed = false
    if (staged.trim()) {
      await runGit(root, ['commit', '-m', 'reader: sync state'])
      committed = true
    }
    try {
      await runGit(root, ['pull', '--rebase', '--autostash'])
    } catch {
      // No upstream yet (a fresh `git init` + remote) or a diverged history:
      // the push below is the authority on whether the result is on the remote.
    }
    try {
      await runGit(root, ['push'])
    } catch {
      await runGit(root, ['push', '-u', 'origin', 'HEAD'])
    }
    return { ok: true, action: 'sync', committed: committed, output: 'read state pushed' }
  } catch (err) {
    return { ok: false, action: 'sync', error: gitMessage(err) }
  }
}

