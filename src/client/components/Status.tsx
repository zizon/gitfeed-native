/**
 * What the scheduler and the checkout are doing, as the status line, the rail
 * menu, and the rail's refresh marker report them. The words are built once so
 * the three cannot describe one job differently.
 */

import type { ReactNode } from '../react.js'
import type { ScheduleJobInfo } from '../../shared/types.js'
import type { ClientState } from '../types.js'
import type { Translate } from '../locales.js'
import { fmtIn, fmtTime } from '../util.js'

/** One job of the reader's scheduler, by id; the fetch job drives the refresh UI. */
export function jobOf(state: ClientState, id: string): ScheduleJobInfo | undefined {
  return state.schedule.find(function (job) { return job.id === id })
}

/** A job's interval in whole minutes, at least one. */
function minutesOf(job: ScheduleJobInfo): number {
  return Math.max(1, Math.round(job.intervalMs / 60000))
}

/**
 * One job's facts in words. A surface shows the parts it needs and joins them
 * with its own separator; none of them words the scheduler itself.
 */
export interface JobWords {
  /** The recurring rhythm, or '' while the job is disabled. */
  cadence: string
  /** When the next run is due, or '' before the scheduler has one. */
  next: string
  /** The last run, including that there has never been one. */
  last: string
  /** How many feeds the last fetch covered; '' for a git job or before one. */
  feeds: string
  /** What the last fetch found; '' for a git job or before its first run. */
  counts: string
  /** Whether the last push landed; '' before the job's first run. */
  verdict: string
}

/**
 * @param job - the scheduler entry, when the Host reported one.
 * @param t - the status words.
 * @returns that job's parts, each empty when it does not apply.
 */
export function jobWords(job: ScheduleJobInfo | undefined, t: Translate): JobWords {
  if (!job) return { cadence: '', next: '', last: '', feeds: '', counts: '', verdict: '' }
  const sync = job.id === 'git'
  const last = job.last
  return {
    cadence: job.enabled
      ? t(sync ? 'status.autoSyncEvery' : 'status.autoEvery', { n: minutesOf(job) })
      : '',
    next: job.nextDueAt ? t('status.nextIn', { age: fmtIn(job.nextDueAt) }) : '',
    last: `${t(sync ? 'status.lastSync' : 'status.lastRefresh')}: ${job.lastRunAt ? fmtTime(job.lastRunAt) : t('status.never')}`,
    feeds: !sync && last ? t('status.feedCount', { n: last.detail?.feeds ?? 0 }) : '',
    counts: !sync && last
      ? t('status.fetchLine', { fresh: last.detail?.added ?? 0, failed: last.detail?.failed ?? 0 })
      : '',
    verdict: sync && last ? (last.ok ? t('status.synced') : t('status.syncFailed')) : '',
  }
}

export function GitStatus({ state, t }: { state: ClientState; t: Translate }) {
  const git = state.git
  const fetchJob = jobOf(state, 'fetch')
  const syncJob = jobOf(state, 'git')
  const fetch = jobWords(fetchJob, t)
  const sync = jobWords(syncJob, t)
  const nodes: ReactNode[] = []
  if (!git || !git.repo) {
    nodes.push(<span key="nogit" className="gf-muted">{t('status.noGit')}</span>)
  } else {
    nodes.push(<b key="branch">{git.branch || '?'}</b>)
    if (git.behind) nodes.push(<span key="behind" className="gf-warn">{t('status.behind', { n: git.behind })}</span>)
    else if (git.ahead) nodes.push(<span key="ahead">{t('status.ahead', { n: git.ahead })}</span>)
    else if (git.dirty) nodes.push(<span key="dirty" className="gf-warn">{t('status.dirty')}</span>)
  }
  if (fetchJob && fetchJob.enabled) {
    const detail = [fetch.last, fetch.counts].filter(Boolean).join(' · ')
    nodes.push(
      <span
        key="auto"
        className={fetchJob.last && !fetchJob.last.ok ? 'gf-warn' : undefined}
        title={detail}
      >
        {fetch.cadence}
      </span>,
    )
  }
  if (fetchJob && fetchJob.running) nodes.push(<span key="running" className="gf-muted">{t('status.running')}</span>)
  if (syncJob && syncJob.enabled) {
    const detail = [sync.cadence, sync.next, sync.last, sync.verdict].filter(Boolean).join(' · ')
    nodes.push(
      <span
        key="sync"
        className={syncJob.last && !syncJob.last.ok ? 'gf-warn' : undefined}
        title={detail}
      >
        {`⇄ ${minutesOf(syncJob)}m`}
      </span>,
    )
  }
  return <div className="gf-status">{nodes}</div>
}

/** Compact background-refresh indicator: age of the last run, and a warn tint when it failed. */
export function RefreshState({ state, t }: { state: ClientState; t: Translate }) {
  const job = jobOf(state, 'fetch')
  if (!job || !job.enabled) return null
  const run = job.last
  // Partial failures stay quiet: the Feeds list marks those rows and the
  // tooltip carries the counts. Only a run where every feed failed is an alarm.
  const broken = run ? !run.ok : false
  const age = job.lastRunAt ? fmtTime(job.lastRunAt) : t('status.never')
  const words = jobWords(job, t)
  const title = [
    words.cadence,
    words.next,
    words.last,
    words.feeds,
    words.counts,
  ].filter(Boolean).join(' · ')
  // No glyph: the refresh button a few pixels above already carries one, and a
  // second arrow that does not act reads as a second button.
  return (
    <span
      className={`gf-refresh-state${job.running ? ' running' : broken ? ' warn' : ''}`}
      title={title}
      aria-label={title}
      role="status"
    >
      {job.running ? '…' : age}
    </span>
  )
}
