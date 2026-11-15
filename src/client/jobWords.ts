/**
 * One scheduler job, said in words. The status line, the rail menu, and the
 * refresh marker all describe the same job, so every sentence about it is
 * built here and none of them is worded twice. Pure: it takes the job the Host
 * reported and the translate seat, and reads nothing else.
 */

import type { ScheduleJobInfo } from '../shared/types.js'
import type { Translate } from './locales.js'
import { fmtIn, fmtTime } from './util.js'

/** A job's interval in whole minutes, at least one. */
export function minutesOf(job: ScheduleJobInfo): number {
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
  const detail = !sync && last && last.detail ? last.detail : null
  return {
    cadence: job.enabled
      ? t(sync ? 'status.autoSyncEvery' : 'status.autoEvery', { n: minutesOf(job) })
      : '',
    next: job.nextDueAt ? t('status.nextIn', { age: fmtIn(job.nextDueAt) }) : '',
    last: `${t(sync ? 'status.lastSync' : 'status.lastRefresh')}: ${job.lastRunAt ? fmtTime(job.lastRunAt) : t('status.never')}`,
    feeds: !sync && last ? t('status.feedCount', { n: detail ? detail.feeds : 0 }) : '',
    // A run that reached no feed is reported as that, not as a page of broken
    // sources: the counts would say "N failed" for a train tunnel.
    counts: !sync && last
      ? (detail && detail.unreachable
        ? t('status.fetchOffline', { n: detail.feeds })
        : t('status.fetchLine', { fresh: detail ? detail.added : 0, failed: detail ? detail.failed : 0 }))
      : '',
    verdict: sync && last ? (last.ok ? t('status.synced') : t('status.syncFailed')) : '',
  }
}
