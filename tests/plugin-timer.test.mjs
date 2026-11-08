// The timer runtime, checked against the real Harness: every job's wake-up is
// a ctx.timer timeout on the plugin's fiber, so disposal and reload cancel
// whatever is pending and nothing beats on a fixed clock.
//
// Needs a DeepSeek Harness checkout (for vendor/cordis and vendor/timer).
// Point DSH_CHECKOUT at it; otherwise a sibling deepseek-harness is tried.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot, finish, ok, skip } from './harness.mjs'

function findCheckout() {
  const candidates = [
    process.env.DSH_CHECKOUT,
    path.join(repoRoot, '..', 'deepseek-harness'),
    path.join(path.dirname(repoRoot), 'deepseek-harness'),
  ].filter(Boolean)
  return candidates.find((dir) => existsSync(path.join(dir, 'vendor/cordis/lib/index.js'))
    && existsSync(path.join(dir, 'vendor/timer/lib/index.js')))
}

const checkout = findCheckout()
if (!checkout) {
  skip('the timer runtime suite', 'no DSH checkout (set DSH_CHECKOUT)')
  finish()
  process.exit(0)
}

const load = async (rel) => import(pathToFileURL(path.join(checkout, rel)).href)
const { Context, Service } = await load('vendor/cordis/lib/index.js')
const { default: Timer } = await load('vendor/timer/lib/index.js')

const pendingTimeouts = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
const settle = () => new Promise((resolve) => { setTimeout(resolve, 100) })
const logger = { info() {}, warn() {}, error() {} }

const root = new Context()
await root.plugin(Timer)

class WebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }

  getOrigin() { return 'http://127.0.0.1:7796' }

  register(route) {
    this.routes.push(route)
    return () => { this.routes = this.routes.filter((entry) => entry !== route) }
  }
}
await root.plugin(WebServer)

const repo = mkdtempSync(path.join(tmpdir(), 'gitfeed-timer-'))
writeFileSync(path.join(repo, 'feeds.json'), '{ "feeds": [] }\n')
writeFileSync(path.join(repo, 'config.json'), '{}\n')
const plugin = await import('../lib/index.js')

ok(Array.isArray(plugin.inject) && plugin.inject.includes('timer'), 'the plugin declares the timer service', plugin.inject)

// ---------- the plugin: one wake-up per job, on its own fiber ----------
const before = pendingTimeouts()
const first = root.plugin(plugin, { repo, allowGit: false, refreshMinutes: 1, syncMinutes: 0, tool: false })
await first
await settle()
const mounted = pendingTimeouts()
ok(mounted === before + 2, 'mounting arms one wake-up per job', { before, mounted })
ok(root.webServer.routes.some((route) => route.path === '/gitfeed/api'), 'the API still mounts')

// ---------- the scheduler: a self-rearming timeout chain ----------
const { createJobRunner } = await import('../lib/host/runner.js')
const schedRepo = mkdtempSync(path.join(tmpdir(), 'gitfeed-timer-sched-'))
let passes = 0
let runs = 0
const ticking = root.plugin({
  name: 'scheduler-probe',
  inject: ['timer'],
  apply(ctx) {
    ctx.effect(() => {
      const scheduler = createJobRunner({
        root: schedRepo,
        logger,
        idleMinutes: 0,
        timers: { timeout: (callback, delayMs) => ctx.timeout(callback, delayMs) },
      })
      scheduler.add({
        id: 'probe',
        label: 'probe',
        baseMin: 1,
        maxMin: 2,
        initial() { return {} },
        available() { return { ok: true } },
        due() {
          passes += 1
          return { run: true }
        },
        async run() {
          runs += 1
          return { fresh: true, nextAt: Date.now() + 10 }
        },
      })
      return () => scheduler.dispose()
    }, 'probe scheduler')
  },
})
await ticking
await settle()
ok(runs >= 1, 'adding a job arms its first deadline at once', { runs })
await new Promise((resolve) => { setTimeout(resolve, 1300) })
ok(runs >= 2 && passes >= 2, 'the timeout it arms fires the next pass by itself', { runs, passes })
const passesBefore = passes
const runsBefore = runs
await ticking.dispose()
await new Promise((resolve) => { setTimeout(resolve, 1300) })
ok(passes === passesBefore && runs === runsBefore, 'disposing the fiber stops the chain for good', {
  before: { passesBefore, runsBefore },
  after: { passes, runs },
})

// ---------- reload: the old wake-ups go with the old fiber ----------
await first.dispose()
ok(pendingTimeouts() === before, 'disposing the plugin clears its wake-ups', { before, after: pendingTimeouts() })

const second = root.plugin(plugin, { repo, allowGit: false, refreshMinutes: 1, syncMinutes: 0, tool: false })
await second
await settle()
ok(pendingTimeouts() === mounted, 'a reload arms the same deadlines, not two sets')
await second.dispose()
ok(pendingTimeouts() === before, 'the reloaded plugin also leaves nothing armed')

rmSync(repo, { recursive: true, force: true })
rmSync(schedRepo, { recursive: true, force: true })
finish()
