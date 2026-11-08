// One adaptive scheduler for every periodic thing the reader does.
//
// A job declares a base interval and a ceiling; the scheduler owns the clock.
// It wakes for the earliest job that is due, skips jobs the reader has not
// touched recently when the job asks for that, runs what is ready, and folds
// each result back into that job's interval: a run that produced something
// returns the job to its base interval, while a quiet or failing run doubles
// it, up to the ceiling. A job can also return its own `nextAt` (the fetch job
// keeps one clock per feed), and `debounce` waits out a burst of local changes
// before running, which is how a read mark turns into a sync about twenty
// seconds after the last mark instead of one commit per mark.
//
// The state is machine-local (`.local/schedule.json`): restarts keep the
// clocks without committing them to the data repository, and version 1 -- the
// fetch-only file -- is read as the fetch job's per-feed payload.

import type { Logger } from './types.js'
import type { ScheduleJobInfo, ScheduleJobRun } from '../shared/types.js'
import { pathsFor } from './settings.js'
import { readJson, writeJson } from './store.js'

/** Whether a job has work right now, and when to look again when it does not. */
export interface DueDecision {
  run: boolean
  nextAt?: number
}

/** What one run reports back to the scheduler. */
export interface JobOutcome {
  /** The run produced new work; the job returns to its base interval. */
  fresh?: boolean
  /** The run failed; it backs off like a quiet run. */
  failed?: boolean
  summary?: string
  /** Counters for the status line (the fetch job reports added/failed/feeds). */
  detail?: Record<string, number>
  /** Exact next run, for jobs with their own clocks (the fetch job). */
  nextAt?: number
  /** Result handed back to the caller of `runNow` (a fetcher report, a git result). */
  value?: unknown
}

export interface JobRunContext {
  now: number
  /** The job's own persisted payload. */
  state: unknown
  /** A one-off request from `runNow`, such as fetching one feed. */
  scope?: unknown
}

export interface ScheduledJob {
  id: string
  label: string
  /** Minutes between runs after the job produced something. */
  baseMin: number
  /** Ceiling of the adaptive backoff. */
  maxMin: number
  /** Pause while the reader has been idle this many minutes; absent means never. */
  activeWithinMin?: number
  /** Delay before the very first run of a fresh schedule, in minutes. */
  firstRunAfterMin?: number
  /** Report the base interval instead of the current backoff (jobs with their own clocks). */
  reportBaseInterval?: boolean
  /** The job-owned payload persisted beside its clocks. */
  initial(): unknown
  /** Whether the job can run at all: its config switch, a remote, a data root. */
  available(): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string }
  /** Whether there is anything to do now. */
  due(now: number, state: unknown): Promise<DueDecision> | DueDecision
  run(context: JobRunContext): Promise<JobOutcome>
}

export interface JobRunResult {
  id: string
  ok: boolean
  outcome: JobOutcome
  value?: unknown
}

export interface Scheduler {
  register(job: ScheduledJob): void
  start(): void
  stop(): void
  /** One scheduling pass; also the test entry point. */
  tick(): Promise<void>
  /** Run a job now, whatever its clocks say (the manual buttons). */
  runNow(id: string, scope?: unknown): Promise<JobRunResult>
  /**
   * Wait for a burst of changes to settle: each call moves the next run to
   * `now + delayMs`, but never past `capMs` after the burst began. A job that
   * is already failing keeps its backoff instead of being retried sooner.
   */
  debounce(id: string, delayMs: number, capMs: number): void
  touch(): void
  status(): Promise<ScheduleJobInfo[]>
}

export interface SchedulerOptions {
  root: string
  logger: Logger
  /** Reader inactivity after which an activity-gated job pauses. */
  idleMinutes: number
  /** Called after a run or a manual fold, so caches keyed on data files drop. */
  onRun?: (jobId: string) => void
  /** Clock, injectable for tests. */
  now?: () => number
}

/** The minimum sleep between scheduler passes. */
const MIN_WAKE_MS = 1000
/** The longest sleep, so a new feed or an idle window is noticed. */
const MAX_WAKE_MS = 5 * 60000

interface JobState {
  intervalMin: number
  nextAt: number
  quiet: number
  failures: number
  lastRunAt: number
  lastOkAt: number
  last: ScheduleJobRun | null
  data?: unknown
}

interface RuntimeJob {
  job: ScheduledJob
  running: boolean
  queued: number
  chain: Promise<void>
  /** Start of the current debounce window, in epoch milliseconds. */
  debounceSince: number
}

interface PersistedSchedule {
  version: 2
  jobs: Record<string, JobState | undefined>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err.trim() || 'unknown error'
  if (err instanceof Error) return err.message.trim() || 'unknown error'
  const failure = err as { message?: unknown } | null
  return typeof failure?.message === 'string' && failure.message.trim() ? failure.message.trim() : 'unknown error'
}

function parseLast(value: unknown): ScheduleJobRun | null {
  if (!isRecord(value) || typeof value.at !== 'string' || !value.at) return null
  const detail: Record<string, number> = {}
  if (isRecord(value.detail)) {
    for (const [key, number] of Object.entries(value.detail)) {
      if (typeof number === 'number' && Number.isFinite(number)) detail[key] = number
    }
  }
  return {
    at: value.at,
    ok: value.ok === true,
    fresh: value.fresh === true,
    summary: typeof value.summary === 'string' ? value.summary : '',
    ...(Object.keys(detail).length ? { detail: detail } : {}),
  }
}

function parseJobState(value: unknown): JobState | null {
  if (!isRecord(value)) return null
  const numericNext = typeof value.nextAt === 'number' && Number.isFinite(value.nextAt)
  const numericInterval = typeof value.intervalMin === 'number' && Number.isFinite(value.intervalMin)
  if (!numericNext && !numericInterval) return null
  const state: JobState = {
    intervalMin: Math.max(0, numberOr(value.intervalMin, 0)),
    nextAt: Math.max(0, numberOr(value.nextAt, 0)),
    quiet: Math.max(0, numberOr(value.quiet, 0)),
    failures: Math.max(0, numberOr(value.failures, 0)),
    lastRunAt: Math.max(0, numberOr(value.lastRunAt, 0)),
    lastOkAt: Math.max(0, numberOr(value.lastOkAt, 0)),
    last: parseLast(value.last),
  }
  if (value.data !== undefined) state.data = value.data
  return state
}

/** Read the fetch-only version 1 file as the fetch job's clocks and last run. */
function fromLegacy(raw: Record<string, unknown>): PersistedSchedule {
  const feeds = isRecord(raw.feeds) ? raw.feeds : {}
  const lastRun = isRecord(raw.lastRun) ? raw.lastRun : null
  const at = lastRun && typeof lastRun.at === 'string' ? lastRun.at : ''
  const atMs = at ? Date.parse(at) : Number.NaN
  const lastMs = Number.isFinite(atMs) ? atMs : 0
  const code = lastRun ? numberOr(lastRun.code, 1) : 1
  const job: JobState = {
    intervalMin: 0,
    nextAt: 0,
    quiet: 0,
    failures: 0,
    lastRunAt: lastMs,
    lastOkAt: code === 0 ? lastMs : 0,
    last: at && lastRun
      ? {
        at: at,
        ok: code === 0,
        fresh: numberOr(lastRun.fresh, 0) > 0,
        summary: typeof lastRun.summary === 'string' ? lastRun.summary : '',
        detail: { added: numberOr(lastRun.fresh, 0), failed: numberOr(lastRun.failed, 0), feeds: numberOr(lastRun.feeds, 0) },
      }
      : null,
    data: { feeds: feeds },
  }
  return { version: 2, jobs: { fetch: job } }
}

async function readScheduleFile(root: string): Promise<PersistedSchedule> {
  const raw = await readJson<Record<string, unknown> | null>(pathsFor(root).localSchedule, null)
  if (!isRecord(raw)) return { version: 2, jobs: {} }
  if (raw.version === 1) return fromLegacy(raw)
  if (raw.version !== 2 || !isRecord(raw.jobs)) return { version: 2, jobs: {} }
  const jobs: Record<string, JobState | undefined> = {}
  for (const [id, value] of Object.entries(raw.jobs)) {
    const state = parseJobState(value)
    if (state) jobs[id] = state
  }
  return { version: 2, jobs: jobs }
}

/**
 * Create the reader's scheduler.
 * @param options root, logger, idle window, and an optional clock.
 * @returns the scheduler surface the Host service drives.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const root = options.root
  const logger = options.logger
  const clock = options.now ?? (() => Date.now())
  const jobs = new Map<string, RuntimeJob>()
  const states = new Map<string, JobState>()
  let loaded: Promise<void> | null = null
  let started = false
  let stopped = false
  let ticking = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastActivity = clock()
  let writing: Promise<void> = Promise.resolve()

  function isStopped(): boolean {
    return stopped
  }

  function stateFor(job: ScheduledJob): JobState {
    const existing = states.get(job.id)
    if (existing) return existing
    const created: JobState = {
      intervalMin: Math.max(1, Math.round(job.baseMin)),
      nextAt: clock() + Math.max(0, job.firstRunAfterMin ?? 0) * 60000,
      quiet: 0,
      failures: 0,
      lastRunAt: 0,
      lastOkAt: 0,
      last: null,
      data: job.initial(),
    }
    states.set(job.id, created)
    return created
  }

  function ensureLoaded(): Promise<void> {
    if (!loaded) {
      loaded = (async function () {
        let file: PersistedSchedule
        try {
          file = await readScheduleFile(root)
        } catch (err) {
          logger.warn(`gitfeed: could not read the schedule: ${errorText(err)}`)
          file = { version: 2, jobs: {} }
        }
        for (const runtime of jobs.values()) {
          const saved = file.jobs[runtime.job.id]
          if (!saved) continue
          const current = stateFor(runtime.job)
          states.set(runtime.job.id, Object.assign({}, current, saved, {
            data: saved.data === undefined ? current.data : saved.data,
          }))
        }
        await persist()
      })()
    }
    return loaded
  }

  function snapshot(): PersistedSchedule {
    const jobsOut: Record<string, JobState | undefined> = {}
    for (const id of Array.from(states.keys()).sort()) {
      const state = states.get(id)
      if (state) jobsOut[id] = state
    }
    return { version: 2, jobs: jobsOut }
  }

  function persist(): Promise<void> {
    const payload = snapshot()
    async function write(): Promise<void> {
      try {
        await writeJson(pathsFor(root).localSchedule, payload)
      } catch (err) {
        logger.warn(`gitfeed: could not save the schedule: ${errorText(err)}`)
      }
    }
    writing = writing.then(write, write)
    return writing
  }

  function paused(job: ScheduledJob, now: number): boolean {
    const gate = job.activeWithinMin ?? 0
    return gate > 0 && now - lastActivity > gate * 60000
  }

  function arm(ms: number): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(function () {
      void tick()
    }, Math.max(MIN_WAKE_MS, ms))
    if (typeof timer.unref === 'function') timer.unref()
  }

  function scheduleNext(): void {
    if (!started || stopped) return
    const now = clock()
    let wait = MAX_WAKE_MS
    for (const runtime of jobs.values()) {
      if (runtime.running || runtime.queued > 0) continue
      const state = stateFor(runtime.job)
      if (paused(runtime.job, now)) continue
      if (!(state.nextAt > 0)) {
        wait = MIN_WAKE_MS
        continue
      }
      wait = Math.min(wait, state.nextAt - now)
    }
    arm(wait)
  }

  function applyOutcome(job: ScheduledJob, state: JobState, outcome: JobOutcome, now: number): void {
    const base = Math.max(1, Math.round(job.baseMin))
    const max = Math.max(base, Math.round(job.maxMin))
    const previous = state.intervalMin > 0 ? state.intervalMin : base
    const failed = outcome.failed === true
    const fresh = outcome.fresh === true
    const intervalMin = fresh && !failed ? base : Math.min(max, Math.max(base, previous * 2))
    state.intervalMin = intervalMin
    state.quiet = fresh ? 0 : state.quiet + 1
    state.failures = failed ? state.failures + 1 : 0
    state.lastRunAt = now
    if (!failed) state.lastOkAt = now
    const nextAt = numberOr(outcome.nextAt, 0)
    state.nextAt = nextAt > 0 ? Math.max(now + 1000, nextAt) : now + intervalMin * 60000
    state.last = {
      at: new Date(now).toISOString(),
      ok: !failed,
      fresh: fresh,
      summary: outcome.summary ?? '',
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    }
  }

  async function execute(runtime: RuntimeJob, now: number, scope: unknown): Promise<JobRunResult> {
    const job = runtime.job
    runtime.running = true
    const state = stateFor(job)
    let outcome: JobOutcome
    try {
      try {
        outcome = await job.run({ now: now, state: state.data, scope: scope })
        if (outcome.failed === true) {
          logger.warn(`gitfeed: ${job.id} failed: ${outcome.summary || 'unknown error'}`)
        }
      } catch (err) {
        const summary = errorText(err)
        outcome = { failed: true, summary: summary }
        logger.warn(`gitfeed: ${job.id} job failed: ${summary}`)
      }
      applyOutcome(job, state, outcome, clock())
      await persist()
      options.onRun?.(job.id)
      return { id: job.id, ok: outcome.failed !== true, outcome: outcome, value: outcome.value }
    } finally {
      runtime.running = false
      runtime.debounceSince = 0
    }
  }

  async function tick(): Promise<void> {
    if (isStopped() || ticking) return
    ticking = true
    try {
      await ensureLoaded()
      if (isStopped()) return
      for (const runtime of Array.from(jobs.values())) {
        if (isStopped()) break
        if (runtime.running || runtime.queued > 0) continue
        const job = runtime.job
        const now = clock()
        const state = stateFor(job)
        if (paused(job, now)) continue
        if (!(state.nextAt <= now)) continue
        const base = Math.max(1, Math.round(job.baseMin))
        let availability: { ok: boolean; reason?: string }
        try {
          availability = await job.available()
        } catch (err) {
          logger.warn(`gitfeed: could not check ${job.id}: ${errorText(err)}`)
          state.nextAt = now + base * 60000
          continue
        }
        if (!availability.ok) {
          state.nextAt = now + base * 60000
          continue
        }
        let decision: DueDecision
        try {
          decision = await job.due(now, state.data)
        } catch (err) {
          logger.warn(`gitfeed: could not check ${job.id}: ${errorText(err)}`)
          state.nextAt = now + base * 60000
          continue
        }
        if (!decision.run) {
          const nextAt = numberOr(decision.nextAt, 0)
          state.nextAt = nextAt > 0 ? nextAt : now + base * 60000
          continue
        }
        await execute(runtime, now, undefined)
      }
    } finally {
      ticking = false
      if (!isStopped()) scheduleNext()
    }
  }

  function register(job: ScheduledJob): void {
    jobs.set(job.id, { job: job, running: false, queued: 0, chain: Promise.resolve(), debounceSince: 0 })
  }

  function start(): void {
    if (started) return
    started = true
    stopped = false
    lastActivity = clock()
    void (async function () {
      await ensureLoaded()
      if (!isStopped()) scheduleNext()
    })()
    arm(12000)
  }

  function stop(): void {
    started = false
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  async function runNow(id: string, scope?: unknown): Promise<JobRunResult> {
    const runtime = jobs.get(id)
    if (!runtime) throw new Error(`gitfeed: no scheduled job ${id}`)
    await ensureLoaded()
    runtime.queued += 1
    const task = function (): Promise<JobRunResult> {
      return execute(runtime, clock(), scope)
    }
    const run = runtime.chain.then(task, task)
    runtime.chain = run.then(function () { }, function () { })
    try {
      return await run
    } finally {
      runtime.queued -= 1
      if (started && !stopped) scheduleNext()
    }
  }

  function debounce(id: string, delayMs: number, capMs: number): void {
    const runtime = jobs.get(id)
    if (!runtime) return
    const state = stateFor(runtime.job)
    // A failing job is backing off on purpose; do not retry it early.
    if (state.failures > 0) return
    const now = clock()
    if (!runtime.debounceSince) runtime.debounceSince = now
    const limit = runtime.debounceSince + Math.max(0, capMs)
    state.nextAt = Math.max(now + 1000, Math.min(now + Math.max(0, delayMs), limit))
    if (started && !stopped) scheduleNext()
  }

  function touch(): void {
    lastActivity = clock()
    if (started && !stopped) scheduleNext()
  }

  async function status(): Promise<ScheduleJobInfo[]> {
    await ensureLoaded()
    const result: ScheduleJobInfo[] = []
    for (const runtime of jobs.values()) {
      const job = runtime.job
      const state = stateFor(job)
      let enabled = true
      let reason: string | null = null
      try {
        const availability = await job.available()
        enabled = availability.ok
        reason = availability.ok ? null : (availability.reason ?? 'disabled')
      } catch (err) {
        enabled = false
        reason = errorText(err)
      }
      const base = Math.max(1, Math.round(job.baseMin))
      const intervalMin = job.reportBaseInterval || !(state.intervalMin > 0) ? base : Math.round(state.intervalMin)
      result.push({
        id: job.id,
        label: job.label,
        enabled: enabled,
        intervalMs: Math.max(1, intervalMin) * 60000,
        nextDueAt: enabled && state.nextAt > 0 ? new Date(state.nextAt).toISOString() : null,
        lastRunAt: state.lastRunAt > 0 ? new Date(state.lastRunAt).toISOString() : null,
        running: runtime.running || runtime.queued > 0,
        last: state.last,
        error: reason,
      })
    }
    return result
  }

  return {
    register: register,
    start: start,
    stop: stop,
    tick: tick,
    runNow: runNow,
    debounce: debounce,
    touch: touch,
    status: status,
  }
}
