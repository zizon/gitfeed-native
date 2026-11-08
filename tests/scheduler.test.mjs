// Contract C1-C9 for the Host scheduler (docs/scheduler.md), driven by a fake
// clock and manual passes: nothing here knows the heartbeat exists.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFetchJob, createSyncJob } from '../lib/host/jobs.js'
import { pull, readGitInfo, sync } from '../lib/host/git.js'
import { createScheduler } from '../lib/host/scheduler.js'
import { finish, nodeTimers, ok } from './harness.mjs'

const timers = nodeTimers()
const log = { info() {}, warn() {}, error() {} }

// ---------- C1/C2: adaptive fetch, one clock per feed ----------
const rootA = mkdtempSync(path.join(tmpdir(), 'gitfeed-fetch-'))
let now = Date.parse('2026-01-01T00:00:00Z')
const calls = []
const feeds = [{ id: 'a', url: 'x', title: 'A', folder: 'F' }, { id: 'b', url: 'y', title: 'B', folder: 'F' }]
const fetchJob = createFetchJob({
  refreshMinutes: 1,
  maxIntervalMinutes: 4,
  adaptive: true,
  idleMinutes: 0,
  loadFeeds: async () => feeds,
  fetch: async (opts) => {
    const ids = opts.only ? [opts.only] : (opts.feeds || ['a', 'b'])
    calls.push({ only: opts.only, feeds: opts.feeds })
    return {
      code: 0, logs: [], summary: 'test', feeds: ids.length, fresh: 0, unchanged: ids.length,
      expired: 0, failed: 0,
      perFeed: Object.fromEntries(ids.map((id) => [id, { added: 0, failed: false, notModified: true }])),
    }
  },
})
const schedA = createScheduler({ timers, root: rootA, logger: log, idleMinutes: 15, now: () => now })
schedA.register(fetchJob)

await schedA.tick()
ok(calls.length === 1 && calls[0].feeds.length === 2, 'first pass fetches both due feeds')
let statusA = await schedA.status()
ok(statusA[0].intervalMs === 60000, 'the fetch status reports its base interval, not one feed backoff')
const firstNext = Date.parse(statusA[0].nextDueAt)
ok(firstNext === now + 120000, 'a quiet feed backs off to two minutes', statusA[0].nextDueAt)

now += 60000
await schedA.tick()
ok(calls.length === 1, 'no fetch before the per-feed clock is due')

now += 60001
await schedA.tick()
ok(calls.length === 2 && calls[1].feeds.length === 2, 'due clocks fetch only the feeds that are due')

await schedA.runNow('fetch', { all: true })
ok(calls.length === 3 && calls[2].feeds.length === 2, 'manual Fetch ignores the clocks and fetches every feed')

const manualStatus = await schedA.status()
ok(manualStatus[0].last.ok === true && manualStatus[0].last.detail.feeds === 2, 'manual run is reported in the job status')

// ---------- C7: the clocks survive a restart ----------
const schedA2 = createScheduler({ timers, root: rootA, logger: log, idleMinutes: 15, now: () => now })
schedA2.register(fetchJob)
const persisted = await schedA2.status()
ok(persisted[0].lastRunAt !== null && persisted[0].last.detail.feeds === 2, 'job clocks and last run survive a restart')

// ---------- C7: the version-1 fetch-only file is still read ----------
const rootB = mkdtempSync(path.join(tmpdir(), 'gitfeed-migrate-'))
mkdirSync(path.join(rootB, '.local'), { recursive: true })
writeFileSync(path.join(rootB, '.local', 'schedule.json'), JSON.stringify({
  version: 1,
  lastRun: { at: '2026-01-01T00:00:00.000Z', summary: '3 new', fresh: 3, failed: 0, code: 0, feeds: 2 },
  feeds: { a: { intervalMin: 5, nextAt: now + 300000, quiet: 0, lastFetchAt: now, lastFreshAt: now } },
}))
const callsB = []
const fetchJobB = createFetchJob({
  refreshMinutes: 1, maxIntervalMinutes: 4, adaptive: true, idleMinutes: 0,
  loadFeeds: async () => [{ id: 'a', url: 'x', title: null, folder: null }],
  fetch: async () => {
    callsB.push(1)
    return {
      code: 0, logs: [], summary: 'test', feeds: 1, fresh: 0, unchanged: 1, expired: 0, failed: 0,
      perFeed: { a: { added: 0, failed: false, notModified: true } },
    }
  },
})
const schedB = createScheduler({ timers, root: rootB, logger: log, idleMinutes: 15, now: () => now })
schedB.register(fetchJobB)
const migrated = await schedB.status()
ok(migrated[0].last && migrated[0].last.detail.added === 3, 'version-1 last run is read into the fetch job')
await schedB.tick()
ok(callsB.length === 0, 'migrated per-feed clock is respected')
await schedB.runNow('fetch', { all: true })
const fileB = JSON.parse(readFileSync(path.join(rootB, '.local', 'schedule.json'), 'utf8'))
ok(fileB.version === 2 && fileB.jobs.fetch && fileB.jobs.fetch.data.feeds.a, 'the schedule is rewritten as version 2')

// ---------- C4/C5/C6: the sync job, its debounce, and manual actions ----------
const rootC = mkdtempSync(path.join(tmpdir(), 'gitfeed-sync-'))
const origin = path.join(rootC, 'origin.git')
const work = path.join(rootC, 'work')
const other = path.join(rootC, 'other')
const git = (...args) => execFileSync('git', args, { stdio: 'pipe' }).toString()
git('init', '--bare', '-b', 'main', origin)
git('init', '-b', 'main', work)
for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) {
  git('-C', work, 'config', k, v)
}
writeFileSync(path.join(work, 'feeds.json'), JSON.stringify({ feeds: [{ id: 'a', url: 'https://example.com/rss' }] }))
writeFileSync(path.join(work, 'config.json'), '{}')
mkdirSync(path.join(work, 'data'), { recursive: true })
writeFileSync(path.join(work, 'data', 'read.ndjson'), `${JSON.stringify({ id: 'base' })}\n`)
writeFileSync(path.join(work, 'data', 'starred.ndjson'), '')
writeFileSync(path.join(work, '.gitignore'), '.local/\n')
git('-C', work, 'add', '-A')
git('-C', work, 'commit', '-m', 'seed')
git('-C', work, 'remote', 'add', 'origin', origin)
git('-C', work, 'push', '-u', 'origin', 'main')

const version = async () => readFileSync(path.join(work, 'data', 'read.ndjson'), 'utf8')
let t = Date.now()
const gitJob = () => createSyncJob({
  allowGit: true, syncMinutes: 1, maxIntervalMinutes: 2,
  gitInfo: () => readGitInfo(work),
  pull: () => pull(work),
  sync: () => sync(work),
  version,
})
const schedC = createScheduler({ timers, root: work, logger: log, idleMinutes: 15, now: () => t })
schedC.register(gitJob())

let statusC = await schedC.status()
ok(statusC[0].enabled === true, 'sync job is available in a checkout with an origin')
ok(statusC[0].nextDueAt === new Date(t + 60000).toISOString(), 'the first sync waits one interval')

await schedC.tick()
ok(git('-C', work, 'rev-list', '--count', 'HEAD').trim() === '1', 'no sync before the first interval')

writeFileSync(path.join(work, 'data', 'read.ndjson'), `${JSON.stringify({ id: 'base' })}\n${JSON.stringify({ id: 'local1' })}\n`)
schedC.debounce('git', 20000, 300000)
t += 10000
schedC.debounce('git', 20000, 300000)
const pending = await schedC.status()
ok(Date.parse(pending[0].nextDueAt) === t + 20000, 'a second change extends the sync debounce')
t += 21000
await schedC.tick()
const headLocal = git('-C', work, 'log', '--format=%s', '-1').trim()
ok(headLocal === 'reader: sync state', 'a local mark is committed by the sync job')
ok(git('-C', work, 'rev-list', '--count', 'HEAD').trim() === '2', 'the commit was created')
statusC = await schedC.status()
ok(statusC[0].last.ok === true && statusC[0].last.fresh === true, 'the push is reported as fresh')
ok(git('-C', origin, 'log', '--format=%s', '-1', 'main').trim() === 'reader: sync state', 'the commit reached the origin')

const beforeQuiet = git('-C', work, 'rev-list', '--count', 'HEAD').trim()
t = Date.parse(statusC[0].nextDueAt) + 1000
await schedC.tick()
statusC = await schedC.status()
ok(git('-C', work, 'rev-list', '--count', 'HEAD').trim() === beforeQuiet, 'a quiet sync creates no commit')
ok(statusC[0].intervalMs === 120000, 'a quiet sync doubles its interval to the ceiling')

git('clone', origin, other)
git('-C', other, 'config', 'user.name', 'Other')
git('-C', other, 'config', 'user.email', 'other@example.com')
writeFileSync(path.join(other, 'data', 'read.ndjson'),
  readFileSync(path.join(other, 'data', 'read.ndjson'), 'utf8') + `${JSON.stringify({ id: 'remote1' })}\n`)
git('-C', other, 'commit', '-am', 'reader: remote marks')
git('-C', other, 'push')
t = Date.parse(statusC[0].nextDueAt) + 1000
await schedC.tick()
statusC = await schedC.status()
ok(readFileSync(path.join(work, 'data', 'read.ndjson'), 'utf8').includes('remote1'), 'remote marks are pulled by the sync job')
ok(statusC[0].intervalMs === 60000, 'a productive sync returns to its base interval')

// ---------- C6/C8: a disabled sync reports why, manual actions still run ----------
const schedD = createScheduler({ timers, root: work, logger: log, idleMinutes: 15, now: () => t })
schedD.register(createSyncJob({
  allowGit: true, syncMinutes: 0, maxIntervalMinutes: 2,
  gitInfo: () => readGitInfo(work),
  pull: () => pull(work),
  sync: () => sync(work),
  version,
}))
const statusD = await schedD.status()
ok(statusD[0].enabled === false && statusD[0].error.includes('syncMinutes'), 'a disabled sync job reports its switch')
const manualRun = await schedD.runNow('git', { action: 'sync' })
ok(manualRun.ok === true, 'a manual git action still runs when auto-sync is off')

finish()
