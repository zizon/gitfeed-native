// What the status line reads from git, and how it is read: one `status` call
// answers branch, divergence, and dirty state, which is what keeps the first
// frame after a restart from waiting on five separate commands.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { finish, lib, ok } from './harness.mjs'

const { parseStatusV2, readGitInfo } = await import(lib('host', 'git.js'))

// --- the porcelain v2 shapes, without a repository ---
{
  const clean = parseStatusV2('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n')
  ok(clean.branch === 'main' && clean.ahead === 2 && clean.behind === 3 && clean.dirty === false,
    'a clean branch with an upstream is read from the headers', clean)

  const noUpstream = parseStatusV2('# branch.oid abc\n# branch.head trunk\n')
  ok(noUpstream.branch === 'trunk' && noUpstream.ahead === 0 && noUpstream.behind === 0,
    'a branch without an upstream counts nothing ahead', noUpstream)

  const detached = parseStatusV2('# branch.oid abc\n# branch.head (detached)\n')
  ok(detached.branch === null, 'a detached head names no branch', detached)

  const initial = parseStatusV2('# branch.oid (initial)\n')
  ok(initial.branch === null && initial.dirty === false, 'an empty repository has no branch and nothing dirty', initial)

  const changed = parseStatusV2('# branch.head main\n1 .M N... 100644 100644 100644 abc def data/read.ndjson\n')
  ok(changed.dirty === true, 'any path line is a dirty worktree', changed)

  const changedWithUpstream = parseStatusV2('# branch.head main\n# branch.ab +0 -0\n2 .M N... 100644 100644 100644 abc def feeds.json\n')
  ok(changedWithUpstream.dirty === true && changedWithUpstream.ahead === 0, 'a dirty branch can still be level with its upstream', changedWithUpstream)
}

// --- a real repository, created here: branch, clean, dirty, no remote ---
function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

const root = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-git-'))
const plain = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-plain-'))
try {
  git(root, ['init', '-b', 'trunk'])
  git(root, ['config', 'user.email', 'test@example.invalid'])
  git(root, ['config', 'user.name', 'Test'])
  mkdirSync(path.join(root, 'data'), { recursive: true })
  writeFileSync(path.join(root, 'data', 'read.ndjson'), '{"id":"a"}\n')
  writeFileSync(path.join(root, 'feeds.json'), '{"feeds":[]}\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'seed'])

  const clean = await readGitInfo(root)
  ok(clean.repo === true && clean.branch === 'trunk', 'the branch is the repository\u2019s own', clean)
  ok(clean.dirty === false && clean.remotes.length === 0, 'a fresh commit is clean, with no remotes', clean)

  writeFileSync(path.join(root, 'data', 'read.ndjson'), '{"id":"b"}\n')
  const dirty = await readGitInfo(root)
  ok(dirty.dirty === true, 'a write to the data root shows as dirty', dirty)

  const none = await readGitInfo(plain)
  ok(none.repo === false && typeof none.error === 'string', 'a directory that is not a repository says so', none)
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
}

finish()
