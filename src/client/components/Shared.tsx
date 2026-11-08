/** Small controls shared by the page, rail, and article surfaces. */

import { useEffect, useRef, useState } from '../react.js'
import type { ReactNode } from '../react.js'
import {
  Button,
  IconSearchOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  Pill,
  Switch,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientState, Controller, Toast as ToastState } from '../types.js'
import type { ScheduleJobInfo } from '../../shared/types.js'
import type { Translate } from '../locales.js'
import { IconRss } from '../icons.js'
import { EmptyState } from './Controls.js'
import { fmtIn, fmtTime } from '../util.js'

/** The three list filters as one labelled chip row. */
export function FilterTabs({ filter, controller, t, compact }: {
  filter: ClientState['filter']
  controller: Controller
  t: Translate
  compact?: boolean
}) {
  const items: Array<[ClientState['filter'], string, string]> = [
    ['unread', 'filter.unread', 'u'],
    ['all', 'filter.all', 'a'],
    ['starred', 'filter.starred', 's'],
  ]
  return (
    <div className={`gf-pills${compact ? ' compact' : ''}`} role="group" aria-label={t('filter.label')}>
      {items.map(function (entry) {
        return (
          <Pill
            key={entry[0]}
            active={filter === entry[0]}
            title={entry[2]}
            aria-pressed={filter === entry[0]}
            onClick={function () { controller.setFilter(entry[0]) }}
          >
            {t(entry[1])}
          </Pill>
        )
      })}
    </div>
  )
}

export function SearchBox({ controller, t, value, inputRef, compact }: {
  controller: Controller
  t: Translate
  value: string
  inputRef: React.RefObject<HTMLInputElement>
  compact?: boolean
}) {
  const [text, setText] = useState(value)
  const timer = useRef(0)
  useEffect(function () { setText(value) }, [value])
  useEffect(function () {
    return function () { clearTimeout(timer.current) }
  }, [])
  function onChange(event: { target: { value: string } }) {
    const next = event.target.value
    setText(next)
    clearTimeout(timer.current)
    timer.current = window.setTimeout(function () { controller.setQuery(next) }, 120)
  }
  return (
    <Input
      ref={inputRef}
      className={`gf-search${compact ? ' compact' : ''}`}
      type="search"
      icon={<IconSearchOutlineRegular size={16} />}
      value={text}
      placeholder={t('search.placeholder')}
      aria-label={t('search.placeholder')}
      spellCheck={false}
      autoComplete="off"
      onChange={onChange}
    />
  )
}

function prefRow(label: string, control: ReactNode) {
  return (
    <div className="gf-prefrow">
      <span className="gf-prefrow-label">{label}</span>
      {control}
    </div>
  )
}

export function DisplayPrefs({ state, controller, t }: {
  state: ClientState
  controller: Controller
  t: Translate
}) {
  const groupBy = state.groupBy || state.reader.groupBy || 'none'
  const hideEmpty = state.hideEmpty === null ? state.reader.hideEmptyFeeds : state.hideEmpty
  const markOnScroll = state.markOnScroll === null ? state.reader.markReadOnScroll : state.markOnScroll
  const showDigest = state.showDigest === null ? true : state.showDigest
  const modes: Array<[string, string]> = [
    ['none', 'pref.none'],
    ['folder', 'pref.folder'],
    ['feed', 'pref.feed'],
  ]
  return (
    <>
      <div className="gf-prefgroup">
        <div className="gf-prefgroup-label">{t('pref.display')}</div>
        {prefRow(t('pref.hideEmpty'), (
          <Switch
            checked={hideEmpty}
            label={t('pref.hideEmpty')}
            onChange={function (value) { controller.setHideEmpty(value) }}
          />
        ))}
        {prefRow(t('pref.markOnScroll'), (
          <Switch
            checked={markOnScroll}
            label={t('pref.markOnScroll')}
            onChange={function (value) { controller.setMarkOnScroll(value) }}
          />
        ))}
        {prefRow(t('pref.showDigest'), (
          <Switch
            checked={showDigest}
            label={t('pref.showDigest')}
            onChange={function (value) { controller.setShowDigest(value) }}
          />
        ))}
      </div>
      <div className="gf-prefgroup">
        <div className="gf-prefgroup-label">{t('pref.groupBy')}</div>
        <div className="gf-pills">
          {modes.map(function (entry) {
            return (
              <Pill
                key={entry[0]}
                active={groupBy === entry[0]}
                aria-pressed={groupBy === entry[0]}
                onClick={function () { controller.setGroupBy(entry[0]) }}
              >
                {t(entry[1])}
              </Pill>
            )
          })}
        </div>
      </div>
    </>
  )
}

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

/**
 * One transient banner. The shared Toast owns its own lifetime and places
 * itself at the top of the page; the mark undo rides its inline action.
 */
export function Toasts({ toast, controller, t }: {
  toast: ToastState | null
  controller: Controller
  t: Translate
}) {
  if (!toast) return null
  const actions = toast.undo
    ? [{
      label: t('toast.undo'),
      onClick: function () {
        controller.dismissToast()
        controller.undoMark()
      },
    }]
    : undefined
  return (
    <Toast
      key={String(toast.at)}
      text={toast.text}
      icon={toast.error ? <IconWarningOutlineRegular size={16} /> : undefined}
      holdMs={toast.undo ? 7000 : 4000}
      actions={actions}
      onDone={function () { controller.dismissToast() }}
    />
  )
}

export function ErrorState({ state, controller, t }: {
  state: ClientState
  controller: Controller
  t: Translate
}) {
  return (
    <EmptyState
      icon={<IconRss size={28} />}
      title={t('error.title')}
      action={(
        <Button
          variant="primary"
          size="sm"
          onClick={function () { void controller.load({ force: true }) }}
        >
          {t('action.retry')}
        </Button>
      )}
    >
      <p className="gf-placeholder-hint error">{state.error}</p>
      {state.repo ? <p className="gf-placeholder-hint">{state.repo}</p> : null}
    </EmptyState>
  )
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

export function EmptyArticle({ t }: { t: Translate }) {
  // The list bar already states the counts; this pane only needs to say what to
  // do next.
  return (
    <EmptyState icon={<IconRss size={28} />} title={t('page.title')}>
      <p className="gf-placeholder-hint">{t('empty.articleHint')}</p>
    </EmptyState>
  )
}
