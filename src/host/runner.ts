// One adaptive scheduler for every periodic thing the reader does.
//
// A job declares a base interval and a ceiling; the scheduler owns the policy,
// and the Host's timer service owns the clock. There is no start or stop of
// its own: registering a job arms its first wake-up, and every timer belongs to
// the caller's fiber, so the plugin's lifetime is the runner's lifetime. Each job carries its own
// wake-up: when its deadline changes the previous timer is disposed and a new
// one is armed through `ctx.timer`, so the reader wakes exactly when a job is
// due and sleeps otherwise. There is no heartbeat, no wake arithmetic shared
// across jobs, and no timer the scheduler keeps for itself.
//
// A pass stores what the job reports: `nextAt` (when to wake again) and
// `intervalMin` (what the status line shows). A job that returns neither is
// retried at its base interval. `nudge` moves a job's deadline out to the end
// of a burst of local changes, which is how a read mark turns into a sync
// about twenty seconds after the last mark instead of one commit per mark.
//
// The state is machine-local (`.local/schedule.json`): restarts keep the
// deadlines without committing them to the data repository, and version 1 --
// the fetch-only file -- is read as the fetch job's per-feed payload. A timer
// is only ever derived from that state, so losing it to a reload loses no
// work: the next mount arms every job again from the same numbers.

import type { Logger } from './types.js'
import type { ScheduleJobInfo, ScheduleJobRun } from '../shared/types.js'
import { pathsFor } from './settings.js'
import { readJson, writeJson } from './store.js'
import { messageOf } from '../shared/errors.js'

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
  /** Exact next run; when absent the runner retries after `intervalMin`. */
  nextAt?: number
  /** The cadence this run leaves the job on; the status line shows it. */
  intervalMin?: number
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

export interface Job {
  id: string
  label: string
  /** The job's floor cadence, used when it reports no interval of its own. */
  baseMin: number
  /** The ceiling the job may back off to (its own policy reads this too). */
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

/** The handle a caller keeps for one registered job. */
export interface JobHandle {
  /** The job's id in the schedule file and on the status line. */
  readonly id: string
  /** Run the job now, whatever its clocks say (the manual buttons). */
  runNow(scope?: unknown): Promise<JobRunResult>
  /**
   * Wait for a burst of changes to settle: each call moves the job's deadline
   * to `now + delayMs`, but never past `capMs` after the burst began. A job
   * that is already failing keeps its backoff instead of being retried sooner.
   */
  nudge(delayMs: number, capMs: number): void
}

export interface JobRunner {
  /** Add a job and arm its first wake-up on the caller's fiber. */
  add(job: Job): JobHandle
  /** The reader used the API: re-arm jobs that slept through an idle window. */
  touch(): void
  status(): Promise<ScheduleJobInfo[]>
  /** Stop arming work; an in-flight pass finishes but schedules nothing new. */
  dispose(): void
}

/**
 * The timer surface the scheduler runs on. The Harness `TimerService` backs it
 * (`ctx.timer`, `@deepseek-ai/cordis-plugin-timer`): each job's wake-up is one
 * timeout owned by the plugin's fiber, so a reload or dispose clears whatever
 * is pending with the rest of the plugin. Nothing here reimplements a clock.
 */
export interface JobTimers {
  /**
   * Run `callback` once after `delayMs`; the returned disposer cancels it. The
   * callback may return the pass it starts, so a fake timer can await it; the
   * Host's timer ignores the value.
   */
  timeout(callback: () => void | Promise<void>, delayMs: number): () => void
}

export interface JobRunnerOptions {
  root: string
  logger: Logger
  /** Reader inactivity after which an activity-gated job pauses. */
  idleMinutes: number
  /** The timers each job arms: the Harness timer service, or a test double. */
  timers: JobTimers
  /** Called after a run or a manual fold, so caches keyed on data files drop. */
  onRun?: (jobId: string) => void
  /** Clock, injectable for tests. */
  now?: () => number
}

/** A job that asks to rerun immediately still waits this long, so a stalled
 * clock or a nextAt in the past cannot spin the reader. */
const MIN_RERUN_MS = 1000

/**
 * What the runner persists per job: when to wake, what the status line shows,
 * and the job's own payload. Everything else -- backoff, per-feed clocks,
 * whether the last run failed -- is the job's business and lives in `data`.
 */
interface JobState {
  /** Minutes the job chose for its current cadence; a display value. */
  intervalMin: number
  nextAt: number
  last: ScheduleJobRun | null
  data?: unknown
}

interface RuntimeJob {
  job: Job
  running: boolean
  queued: number
  chain: Promise<void>
  /** Cancels this job's armed wake-up. */
  wake: (() => void) | null
  /** The reader was away when the deadline passed; `touch` arms the job again. */
  idleSleep: boolean
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
  const code = lastRun ? numberOr(lastRun.code, 1) : 1
  const job: JobState = {
    intervalMin: 0,
    nextAt: 0,
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

/** The runner's mutable copy: what it knows, what it has armed, and what it waits on. */
interface RunnerRecord {
  root: string
  logger: Logger
  clock: () => number
  timers: JobTimers
  onRun?: (jobId: string) => void
  jobs: Map<string, RuntimeJob>
  states: Map<string, JobState>
  /** The one read of the stored schedule; every caller awaits the same promise. */
  loaded: Promise<void> | null
  stopped: boolean
  lastActivity: number
  /** The tail of the schedule writes, so two passes cannot interleave a file. */
  writing: Promise<void>
}

/**
 * Create the reader's job runner. There is nothing to start: `add` arms that
 * job's first wake-up, and the timers live on the fiber of whoever supplies
 * `timers` (the plugin's own context), so teardown is the fiber's. `dispose` is
 * only here to make a pass that is already running inert.
 * @param options root, logger, idle window, timers, and an optional clock.
 * @returns the runner surface the Host service drives.
 */
export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const clock = options.now ?? (() => Date.now())
  const record: RunnerRecord = {
    root: options.root,
    logger: options.logger,
    clock: clock,
    timers: options.timers,
    onRun: options.onRun,
    jobs: new Map<string, RuntimeJob>(),
    states: new Map<string, JobState>(),
    loaded: null,
    stopped: false,
    lastActivity: clock(),
    writing: Promise.resolve(),
  }
  return {
    add: function (job) { return add(record, job) },
    touch: function () { touch(record) },
    status: function () { return status(record) },
    dispose: function () { dispose(record) },
  }
}

/**
 * A chain step whose result is answered elsewhere: the chain only orders runs,
 * and each run's outcome goes to the caller that asked for it.
 */
function chainStep(): void { /* the outcome is not the chain's */ }

function stateFor(record: RunnerRecord, job: Job): JobState {
  const existing = record.states.get(job.id)
  if (existing) return existing
  const created: JobState = {
    intervalMin: Math.max(1, Math.round(job.baseMin)),
    nextAt: record.clock() + Math.max(0, job.firstRunAfterMin ?? 0) * 60000,
    last: null,
    data: job.initial(),
  }
  record.states.set(job.id, created)
  return created
}

async function ensureLoaded(record: RunnerRecord): Promise<void> {
  if (record.loaded) return record.loaded
  record.loaded = (async function () {
    let file: PersistedSchedule
    try {
      file = await readScheduleFile(record.root)
    } catch (err) {
      record.logger.warn(`gitfeed: could not read the schedule: ${messageOf(err)}`)
      file = { version: 2, jobs: {} }
    }
    for (const runtime of record.jobs.values()) {
      const saved = file.jobs[runtime.job.id]
      if (!saved) continue
      const current = stateFor(record, runtime.job)
      record.states.set(runtime.job.id, Object.assign({}, current, saved, {
        // A job whose payload predates this format keeps its own default
        // object, so the job can keep writing to it.
        data: saved.data === undefined || saved.data === null ? current.data : saved.data,
      }))
    }
    await persist(record)
  })()
  return record.loaded
}

function snapshot(record: RunnerRecord): PersistedSchedule {
  const jobsOut: Record<string, JobState | undefined> = {}
  for (const id of Array.from(record.states.keys()).sort()) {
    const state = record.states.get(id)
    if (state) jobsOut[id] = state
  }
  return { version: 2, jobs: jobsOut }
}

async function persist(record: RunnerRecord): Promise<void> {
  const payload = snapshot(record)
  async function write(): Promise<void> {
    try {
      await writeJson(pathsFor(record.root).localSchedule, payload)
    } catch (err) {
      record.logger.warn(`gitfeed: could not save the schedule: ${messageOf(err)}`)
    }
  }
  record.writing = record.writing.then(write, write)
  return record.writing
}

/** Whether the reader has been away long enough for an activity-gated job. */
function paused(record: RunnerRecord, job: Job, now: number): boolean {
  const gate = job.activeWithinMin ?? 0
  return gate > 0 && now - record.lastActivity > gate * 60000
}

function disarm(runtime: RuntimeJob): void {
  if (runtime.wake) {
    runtime.wake()
    runtime.wake = null
  }
}

/**
 * Arm this job's own wake-up for the deadline in its state. A paused job holds
 * no timer at all: the deadline would only be skipped, and `touch` arms it again
 * the moment the reader is back.
 */
function arm(record: RunnerRecord, runtime: RuntimeJob): void {
  disarm(runtime)
  if (record.stopped) return
  const now = record.clock()
  if (paused(record, runtime.job, now)) {
    runtime.idleSleep = true
    return
  }
  runtime.idleSleep = false
  const state = stateFor(record, runtime.job)
  const delay = Math.max(0, state.nextAt - now)
  runtime.wake = record.timers.timeout(function () {
    runtime.wake = null
    return fire(record, runtime)
  }, delay)
}

/**
 * A deadline came due: run one pass, then arm the next deadline. The pass is
 * returned so a fake timer can await it; the Host's timer ignores the value.
 */
function fire(record: RunnerRecord, runtime: RuntimeJob): Promise<void> {
  if (record.stopped || runtime.running || runtime.queued > 0) return Promise.resolve()
  runtime.queued += 1
  const task = function (): Promise<void> {
    return pass(record, runtime)
  }
  const run = runtime.chain.then(task, task)
  runtime.chain = run.then(chainStep, chainStep)
  return run.then(settle, settle)
  function settle(): void {
    runtime.queued -= 1
    if (!record.stopped) arm(record, runtime)
  }
}

/**
 * Store what the job reported. The runner has no backoff of its own: a job that
 * wants to slow down says so with `intervalMin` and `nextAt`.
 */
function applyOutcome(job: Job, state: JobState, outcome: JobOutcome, now: number): void {
  const base = Math.max(1, Math.round(job.baseMin))
  const intervalMin = Math.max(1, Math.round(numberOr(outcome.intervalMin, base)))
  state.intervalMin = intervalMin
  const nextAt = numberOr(outcome.nextAt, 0)
  state.nextAt = nextAt > 0 ? Math.max(now + MIN_RERUN_MS, nextAt) : now + intervalMin * 60000
  state.last = {
    at: new Date(now).toISOString(),
    ok: outcome.failed !== true,
    fresh: outcome.fresh === true,
    summary: outcome.summary ?? '',
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  }
}

async function execute(
  record: RunnerRecord, runtime: RuntimeJob, now: number, scope: unknown,
): Promise<JobRunResult> {
  const job = runtime.job
  runtime.running = true
  const state = stateFor(record, job)
  let outcome: JobOutcome
  try {
    try {
      outcome = await job.run({ now: now, state: state.data, scope: scope })
      if (outcome.failed === true) {
        record.logger.warn(`gitfeed: ${job.id} failed: ${outcome.summary || 'unknown error'}`)
      }
    } catch (err) {
      const summary = messageOf(err)
      outcome = { failed: true, summary: summary }
      record.logger.warn(`gitfeed: ${job.id} job failed: ${summary}`)
    }
    applyOutcome(job, state, outcome, record.clock())
    await persist(record)
    record.onRun?.(job.id)
    return { id: job.id, ok: outcome.failed !== true, outcome: outcome, value: outcome.value }
  } finally {
    runtime.running = false
    runtime.debounceSince = 0
  }
}

/** One evaluation of one job: everything except the timer bookkeeping. */
async function pass(record: RunnerRecord, runtime: RuntimeJob): Promise<void> {
  const job = runtime.job
  try {
    await ensureLoaded(record)
    if (record.stopped) return
    const now = record.clock()
    const state = stateFor(record, job)
    if (paused(record, job, now)) {
      runtime.idleSleep = true
      return
    }
    runtime.idleSleep = false
    if (!(state.nextAt <= now)) return
    const base = Math.max(1, Math.round(job.baseMin))
    let availability: { ok: boolean; reason?: string }
    try {
      availability = await job.available()
    } catch (err) {
      record.logger.warn(`gitfeed: could not check ${job.id}: ${messageOf(err)}`)
      state.nextAt = now + base * 60000
      return
    }
    if (!availability.ok) {
      state.nextAt = now + base * 60000
      return
    }
    let decision: DueDecision
    try {
      decision = await job.due(now, state.data)
    } catch (err) {
      record.logger.warn(`gitfeed: could not check ${job.id}: ${messageOf(err)}`)
      state.nextAt = now + base * 60000
      return
    }
    if (!decision.run) {
      const nextAt = numberOr(decision.nextAt, 0)
      state.nextAt = nextAt > 0 ? nextAt : now + base * 60000
      return
    }
    await execute(record, runtime, now, undefined)
  } catch (err) {
    record.logger.warn(`gitfeed: ${job.id} pass failed: ${messageOf(err)}`)
  }
}

/**
 * Registering is the arming: the job's first deadline goes on the fiber at once,
 * and again after the stored schedule is read, because the persisted `nextAt`
 * replaces the fresh one. The returned handle is the only way to act on that
 * job, so no caller has to name it by string.
 */
function add(record: RunnerRecord, job: Job): JobHandle {
  const runtime: RuntimeJob = {
    job: job,
    running: false,
    queued: 0,
    chain: Promise.resolve(),
    wake: null,
    idleSleep: false,
    debounceSince: 0,
  }
  record.jobs.set(job.id, runtime)
  arm(record, runtime)
  void ensureLoaded(record).then(function () {
    if (!record.stopped) arm(record, runtime)
  })
  return {
    id: job.id,
    runNow: function (scope?: unknown) { return runJob(record, job.id, scope) },
    nudge: function (delayMs: number, capMs: number) { nudge(record, job.id, delayMs, capMs) },
  }
}

function dispose(record: RunnerRecord): void {
  record.stopped = true
  for (const runtime of record.jobs.values()) {
    disarm(runtime)
    runtime.idleSleep = false
  }
}

async function runJob(record: RunnerRecord, id: string, scope?: unknown): Promise<JobRunResult> {
  const runtime = record.jobs.get(id)
  if (!runtime) throw new Error(`gitfeed: no scheduled job ${id}`)
  await ensureLoaded(record)
  disarm(runtime)
  runtime.queued += 1
  const task = function (): Promise<JobRunResult> {
    return execute(record, runtime, record.clock(), scope)
  }
  const run = runtime.chain.then(task, task)
  runtime.chain = run.then(chainStep, chainStep)
  try {
    return await run
  } finally {
    runtime.queued -= 1
    if (!record.stopped) arm(record, runtime)
  }
}

function nudge(record: RunnerRecord, id: string, delayMs: number, capMs: number): void {
  const runtime = record.jobs.get(id)
  if (!runtime) return
  const state = stateFor(record, runtime.job)
  // A failing job is backing off on purpose; do not retry it early.
  if (state.last && !state.last.ok) return
  const now = record.clock()
  if (!runtime.debounceSince) runtime.debounceSince = now
  // A deadline, not a live debouncer: the burst cap is a property of the job's
  // stored state, so a reload in the middle of a burst still syncs.
  const limit = runtime.debounceSince + Math.max(0, capMs)
  state.nextAt = Math.max(now + MIN_RERUN_MS, Math.min(now + Math.max(0, delayMs), limit))
  arm(record, runtime)
}

function touch(record: RunnerRecord): void {
  record.lastActivity = record.clock()
  for (const runtime of record.jobs.values()) {
    if (runtime.idleSleep) arm(record, runtime)
  }
}

async function status(record: RunnerRecord): Promise<ScheduleJobInfo[]> {
  await ensureLoaded(record)
  const result: ScheduleJobInfo[] = []
  for (const runtime of record.jobs.values()) {
    const job = runtime.job
    const state = stateFor(record, job)
    let enabled = true
    let reason: string | null = null
    try {
      const availability = await job.available()
      enabled = availability.ok
      reason = availability.ok ? null : (availability.reason ?? 'disabled')
    } catch (err) {
      enabled = false
      reason = messageOf(err)
    }
    const base = Math.max(1, Math.round(job.baseMin))
    const intervalMin = job.reportBaseInterval || !(state.intervalMin > 0) ? base : Math.round(state.intervalMin)
    result.push({
      id: job.id,
      label: job.label,
      enabled: enabled,
      intervalMs: Math.max(1, intervalMin) * 60000,
      nextDueAt: enabled && state.nextAt > 0 ? new Date(state.nextAt).toISOString() : null,
      lastRunAt: state.last ? state.last.at : null,
      running: runtime.running || runtime.queued > 0,
      last: state.last,
      error: reason,
    })
  }
  return result
}
