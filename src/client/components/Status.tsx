/**
 * What the scheduler and the checkout are doing, as the status line and the
 * rail's refresh marker report them.
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

export function GitStatus({ state, t }: { state: ClientState; t: Translate }) {
  const git = state.git
  const fetchJob = jobOf(state, 'fetch')
  const syncJob = jobOf(state, 'git')
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
    const detail = [`${t('status.lastRefresh')}: ${fetchJob.lastRunAt ? fmtTime(fetchJob.lastRunAt) : t('status.never')}`]
    if (fetchJob.last) {
      detail.push(t('status.fetchLine', {
        fresh: fetchJob.last.detail?.added ?? 0,
        failed: fetchJob.last.detail?.failed ?? 0,
      }))
    }
    nodes.push(
      <span
        key="auto"
        className={fetchJob.last && !fetchJob.last.ok ? 'gf-warn' : undefined}
        title={detail.join(' · ')}
      >
        {t('status.autoEvery', { n: Math.max(1, Math.round(fetchJob.intervalMs / 60000)) })}
      </span>,
    )
  }
  if (fetchJob && fetchJob.running) nodes.push(<span key="running" className="gf-muted">{t('status.running')}</span>)
  if (syncJob && syncJob.enabled) {
    const detail = [
      t('status.autoSyncEvery', { n: Math.max(1, Math.round(syncJob.intervalMs / 60000)) }),
      syncJob.nextDueAt ? t('status.nextIn', { age: fmtIn(syncJob.nextDueAt) }) : '',
      `${t('status.lastSync')}: ${syncJob.lastRunAt ? fmtTime(syncJob.lastRunAt) : t('status.never')}`,
      syncJob.last ? (syncJob.last.ok ? t('status.synced') : t('status.syncFailed')) : '',
    ].filter(Boolean).join(' · ')
    nodes.push(
      <span
        key="sync"
        className={syncJob.last && !syncJob.last.ok ? 'gf-warn' : undefined}
        title={detail}
      >
        {`⇄ ${Math.max(1, Math.round(syncJob.intervalMs / 60000))}m`}
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
  const title = [
    t('status.autoEvery', { n: Math.max(1, Math.round(job.intervalMs / 60000)) }),
    job.nextDueAt ? t('status.nextIn', { age: fmtIn(job.nextDueAt) }) : '',
    `${t('status.lastRefresh')}: ${age}`,
    run ? t('status.feedCount', { n: run.detail?.feeds ?? 0 }) : '',
    run ? t('status.fetchLine', { fresh: run.detail?.added ?? 0, failed: run.detail?.failed ?? 0 }) : '',
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
