// The first activation of a plugin with no data root: the files it seeds, the
// git repository it initialises, and the roots it must refuse to touch. A
// seeded root is a repository on `main` with no remote, so `Sync reads` has a
// branch to commit to once the reader adds one.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { finish, lib, ok } from './harness.mjs'

const { scaffoldData, starterFiles } = await import(lib('host', 'scaffold.js'))
const { pull, sync } = await import(lib('host', 'git.js'))

const base = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-scaffold-'))
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const branch = (root) => git(root, ['symbolic-ref', '--short', 'HEAD']).trim()
const hasCommit = (root) => {
  try {
    git(root, ['rev-parse', '--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

// ---------- a root that does not exist yet ----------
const fresh = path.join(base, 'fresh')
const seeded = scaffoldData(fresh)
ok(seeded.seeded === true && seeded.reason === 'seeded', 'a missing root is seeded', seeded)
ok(seeded.repo === true, 'and is initialised as a repository', seeded)
for (const file of ['feeds.json', 'config.json', '.gitattributes', '.gitignore', 'data/meta.json', 'data/read.ndjson']) {
  ok(existsSync(path.join(fresh, file)), `the starter carries ${file}`)
}
ok(existsSync(path.join(fresh, '.git')), 'the seeded root is a git repository')
ok(branch(fresh) === 'main', 'on main, the branch the data expects', branch(fresh))
ok(hasCommit(fresh) === false, 'with no commit: baseline belongs to the first Sync')
ok(JSON.parse(readFileSync(path.join(fresh, 'feeds.json'), 'utf8')).feeds.length === 0, 'the inbox starts empty')

// The ignore list and the merge rules are what make the first commit and a
// two-machine read state safe, so they have to be inside the repository.
mkdirSync(path.join(fresh, '.local'), { recursive: true })
writeFileSync(path.join(fresh, '.local', 'cache.json'), '{}')
const ignored = git(fresh, ['check-ignore', '.local/cache.json']).trim()
ok(ignored === '.local/cache.json', 'the local cache is ignored from the first commit', ignored)
const attributes = readFileSync(path.join(fresh, '.gitattributes'), 'utf8')
ok(attributes.includes('data/read.ndjson merge=union'), 'the merge rules travel with the repository')

// ---------- a root that already has a reader ----------
const existing = path.join(base, 'existing')
mkdirSync(existing, { recursive: true })
writeFileSync(path.join(existing, 'feeds.json'), JSON.stringify({ feeds: [{ id: 'keep', url: 'https://example.com/rss' }] }))
const present = scaffoldData(existing)
ok(present.seeded === false && present.reason === 'present', 'a root with feeds.json is left alone', present)
ok(JSON.parse(readFileSync(path.join(existing, 'feeds.json'), 'utf8')).feeds[0].id === 'keep', 'and its subscription survives')
ok(!existsSync(path.join(existing, '.git')), 'no repository is forced on an existing root')

// ---------- a directory with someone else's files ----------
const occupied = path.join(base, 'occupied')
mkdirSync(occupied, { recursive: true })
writeFileSync(path.join(occupied, 'notes.txt'), 'mine')
const notEmpty = scaffoldData(occupied)
ok(notEmpty.seeded === false && notEmpty.reason === 'not-empty', 'a non-empty root is refused', notEmpty)
ok(!existsSync(path.join(occupied, 'feeds.json')), 'and nothing is written into it')
ok(!existsSync(path.join(occupied, '.git')), 'and no repository is created there')

// ---------- a pristine directory that is already a repository ----------
const cloned = path.join(base, 'cloned')
mkdirSync(cloned, { recursive: true })
git(cloned, ['init', '-b', 'trunk'])
const overRepo = scaffoldData(cloned)
ok(overRepo.seeded === true && overRepo.repo === false, 'a repository on another branch keeps its own', overRepo)
ok(branch(cloned) === 'trunk', 'and its branch is not renamed', branch(cloned))

// ---------- a repository with nowhere to push ----------
// The root starts as a repository on main with no remote. Pull and Sync are
// enabled (there is a repository), so the one missing step has to be named
// rather than left as git's "no configured push destination".
const synced = await sync(fresh)
ok(synced.ok === false && /no git remote/.test(synced.error || ''), 'Sync on a fresh root names the missing remote', synced.error)
const pulled = await pull(fresh)
ok(pulled.ok === false && /no git remote/.test(pulled.error || ''), 'Pull says the same', pulled.error)

// ---------- the CLI's list matches what a seed writes ----------
ok(starterFiles().includes('feeds.json') && starterFiles().includes('.gitattributes'), 'the reported starter files are the ones written', starterFiles())

rmSync(base, { recursive: true, force: true })
finish()
