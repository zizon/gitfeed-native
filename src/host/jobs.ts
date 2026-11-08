// The two jobs the reader schedules.
//
// `fetch` refills the gitignored `.local/` cache, one feed at a time: it keeps
// the per-feed clocks from `schedule.ts` and may return its own `nextAt`, so
// the scheduler wakes at the earliest feed rather than at a fixed tick.
//
// `git` publishes and repairs read state: after a read mark or a subscription
// change the service nudges it forward, so it commits, rebases, and pushes
// within seconds; on a quiet machine it backs off and only pulls, which is how
// a second device's marks arrive without a manual Sync.

import type { FeedDefinition, FetchResult, GitActionResult } from './types.js'
import type { GitInfo } from '../shared/types.js'
import type { JobOutcome, ScheduledJob } from './scheduler.js'
import type { FeedClocks } from './schedule.js'
import { applyRun, dueFeeds, nextDueAt, pruneSchedule } from './schedule.js'

/** Scope for a one-off fetch: one feed (subscribe), a set, or everything (Fetch). */
interface FetchScope {
  only?: string
  feeds?: string[]
  all?: boolean
}

/** The fetch job's persisted payload: one clock per subscribed feed. */
interface FetchJobData {
  feeds: FeedClocks
}

export interface FetchJobOptions {
  refreshMinutes: number
  maxIntervalMinutes: number
  adaptive: boolean
  idleMinutes: number
  loadFeeds(): Promise<FeedDefinition[]>
  fetch(options: { only?: string; feeds?: string[] }): Promise<FetchResult>
}

function fetchScope(value: unknown): FetchScope {
  if (!value || typeof value !== 'object') return {}
  const raw = value as { only?: unknown; feeds?: unknown; all?: unknown }
  const scope: FetchScope = {}
  if (typeof raw.only === 'string' && raw.only) scope.only = raw.only
  if (Array.isArray(raw.feeds)) {
    const feeds = raw.feeds.filter(function (id): id is string { return typeof id === 'string' && id.length > 0 })
    if (feeds.length) scope.feeds = feeds
  }
  if (raw.all === true) scope.all = true
  return scope
}

function fetchData(value: unknown): FetchJobData {
  if (value && typeof value === 'object') {
    const raw = value as { feeds?: unknown }
    if (raw.feeds && typeof raw.feeds === 'object' && !Array.isArray(raw.feeds)) {
      return { feeds: raw.feeds as FeedClocks }
    }
  }
  return { feeds: {} }
}

function nextRun(clocks: FeedClocks, ids: string[], now: number, baseMin: number): number {
  const next = nextDueAt(clocks, ids, now)
  return next === null ? now + Math.max(1, baseMin) * 60000 : next
}

/**
 * The feed-refresh job: due feeds only, per-feed backoff, a manual run that
 * can override the scope.
 * @param options interval bounds and the fetcher entry points.
 * @returns the job to register with the scheduler.
 */
export function createFetchJob(options: FetchJobOptions): ScheduledJob {
  const baseMin = Math.max(1, Math.round(options.refreshMinutes))
  const maxMin = options.adaptive ? Math.max(baseMin, Math.round(options.maxIntervalMinutes)) : baseMin
  return {
    id: 'fetch',
    label: 'Refresh',
    baseMin: baseMin,
    maxMin: maxMin,
    activeWithinMin: options.idleMinutes,
    // Per-feed clocks carry the adaptation, so the status line keeps showing
    // the configured minimum instead of one feed's current backoff.
    reportBaseInterval: true,
    initial(): FetchJobData {
      return { feeds: {} }
    },
    available(): { ok: boolean; reason?: string } {
      return options.refreshMinutes > 0
        ? { ok: true }
        : { ok: false, reason: 'scheduled refresh is off (refreshMinutes: 0)' }
    },
    async due(now: number, state: unknown): Promise<{ run: boolean; nextAt?: number }> {
      if (!options.adaptive) return { run: true }
      const data = fetchData(state)
      const feeds = await options.loadFeeds()
      const ids = feeds.map(function (feed) { return feed.id })
      if (ids.length === 0) return { run: false, nextAt: now + baseMin * 60000 }
      const due = dueFeeds(data.feeds, ids, now)
      if (due.length > 0) return { run: true }
      return { run: false, nextAt: nextRun(data.feeds, ids, now, baseMin) }
    },
    async run(context): Promise<JobOutcome> {
      const data = fetchData(context.state)
      const scope = fetchScope(context.scope)
      const feeds = await options.loadFeeds()
      const ids = feeds.map(function (feed) { return feed.id })
      const due = options.adaptive && !scope.only && !scope.feeds && !scope.all
        ? dueFeeds(data.feeds, ids, context.now)
        : ids
      const wanted = scope.only ? [scope.only] : scope.feeds ?? due
      if (wanted.length === 0) {
        return { fresh: false, summary: 'no feed is due', nextAt: nextRun(data.feeds, ids, context.now, baseMin) }
      }
      const result = await options.fetch(scope.only ? { only: scope.only } : { feeds: wanted })
      pruneSchedule(data.feeds, ids)
      if (options.adaptive) {
        applyRun(data.feeds, result.perFeed, {
          nowMs: context.now,
          baseMin: baseMin,
          maxMin: maxMin,
        })
      }
      const next = options.adaptive ? nextRun(data.feeds, ids, context.now, baseMin) : context.now + baseMin * 60000
      return {
        fresh: result.fresh > 0,
        failed: result.code !== 0,
        summary: result.summary,
        detail: { added: result.fresh, failed: result.failed, feeds: result.feeds },
        nextAt: next,
        value: result,
      }
    },
  }
}

/** Scope for a manual git action, so the job can run Pull or Sync directly. */
interface GitScope {
  action?: 'pull' | 'sync'
}

function gitScope(value: unknown): GitScope {
  if (!value || typeof value !== 'object') return {}
  const raw = value as { action?: unknown }
  if (raw.action === 'pull' || raw.action === 'sync') return { action: raw.action }
  return {}
}

export interface SyncJobOptions {
  allowGit: boolean
  syncMinutes: number
  maxIntervalMinutes: number
  gitInfo(): Promise<GitInfo>
  pull(): Promise<GitActionResult>
  sync(): Promise<GitActionResult>
  /** Data version before and after a run; a changed one means something arrived. */
  version(): Promise<string>
}

/**
 * The read-state sync job: commit and push local marks, pull remote ones.
 * @param options git entry points and the auto-sync bounds.
 * @returns the job to register with the scheduler.
 */
export function createSyncJob(options: SyncJobOptions): ScheduledJob {
  const baseMin = Math.max(1, Math.round(options.syncMinutes))
  return {
    id: 'git',
    label: 'Sync',
    baseMin: baseMin,
    maxMin: Math.max(baseMin, Math.round(options.maxIntervalMinutes)),
    firstRunAfterMin: baseMin,
    initial(): null {
      return null
    },
    async available(): Promise<{ ok: boolean; reason?: string }> {
      if (!options.syncMinutes) return { ok: false, reason: 'scheduled sync is off (syncMinutes: 0)' }
      if (!options.allowGit) return { ok: false, reason: 'git actions are disabled (allowGit)' }
      const info = await options.gitInfo()
      if (!info.repo) return { ok: false, reason: 'the data root is a local copy, not a git working tree' }
      if ((info.remotes ?? []).indexOf('origin') === -1) return { ok: false, reason: 'the data root has no origin remote' }
      return { ok: true }
    },
    due(): { run: boolean } {
      return { run: true }
    },
    async run(context): Promise<JobOutcome> {
      const scope = gitScope(context.scope)
      const before = await options.version()
      const info = await options.gitInfo()
      let result: GitActionResult
      const ahead = info.ahead ?? 0
      if (scope.action === 'pull') result = await options.pull()
      else if (scope.action === 'sync') result = await options.sync()
      else if (info.dirty || ahead > 0) result = await options.sync()
      else result = await options.pull()
      if (!result.ok) return { failed: true, summary: result.error || `${result.action} failed`, value: result }
      const after = await options.version()
      const pulled = after !== before
      const committed = result.committed === true
      const fresh = scope.action !== undefined || committed || pulled || ahead > 0
      const summary = committed ? 'committed read state'
        : pulled ? 'pulled remote changes'
          : 'nothing to sync'
      return {
        fresh: fresh,
        summary: summary,
        detail: { pulled: pulled ? 1 : 0, committed: committed ? 1 : 0 },
        value: result,
      }
    },
  }
}
