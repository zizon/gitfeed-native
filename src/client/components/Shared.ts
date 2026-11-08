/** Small controls shared by the page, rail, and article surfaces. */

import { Fragment, h, useEffect, useRef, useState } from '../react.js'
import type { ReactNode } from '../react.js'
import {
  Button,
  IconRefreshOutlineRegular,
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
import { tf } from '../locales.js'
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
  return h('div', { className: 'gf-pills' + (compact ? ' compact' : ''), role: 'group', 'aria-label': t('filter.label') },
    items.map(function (entry) {
      return h(Pill, {
        key: entry[0],
        active: filter === entry[0],
        title: entry[2],
        'aria-pressed': filter === entry[0],
        onClick: function () { controller.setFilter(entry[0]) },
      }, t(entry[1]))
    }))
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
  return h(Input, {
    ref: inputRef,
    className: 'gf-search' + (compact ? ' compact' : ''),
    type: 'search',
    icon: h(IconSearchOutlineRegular, { size: 16 }),
    value: text,
    placeholder: t('search.placeholder'),
    'aria-label': t('search.placeholder'),
    spellCheck: false,
    autoComplete: 'off',
    onChange: onChange,
  })
}

function prefRow(label: string, control: ReactNode) {
  return h('div', { className: 'gf-prefrow' },
    h('span', { className: 'gf-prefrow-label' }, label),
    control)
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
  return h(Fragment, null,
    h('div', { className: 'gf-prefgroup' },
      h('div', { className: 'gf-prefgroup-label' }, t('pref.display')),
      prefRow(t('pref.hideEmpty'), h(Switch, {
        checked: hideEmpty,
        label: t('pref.hideEmpty'),
        onChange: function (value) { controller.setHideEmpty(value) },
      })),
      prefRow(t('pref.markOnScroll'), h(Switch, {
        checked: markOnScroll,
        label: t('pref.markOnScroll'),
        onChange: function (value) { controller.setMarkOnScroll(value) },
      })),
      prefRow(t('pref.showDigest'), h(Switch, {
        checked: showDigest,
        label: t('pref.showDigest'),
        onChange: function (value) { controller.setShowDigest(value) },
      }))),
    h('div', { className: 'gf-prefgroup' },
      h('div', { className: 'gf-prefgroup-label' }, t('pref.groupBy')),
      h('div', { className: 'gf-pills' }, modes.map(function (entry) {
        return h(Pill, {
          key: entry[0],
          active: groupBy === entry[0],
          'aria-pressed': groupBy === entry[0],
          onClick: function () { controller.setGroupBy(entry[0]) },
        }, t(entry[1]))
      }))))
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
    nodes.push(h('span', { key: 'nogit', className: 'gf-muted' }, t('status.noGit')))
  } else {
    nodes.push(h('b', { key: 'branch' }, git.branch || '?'))
    if (git.behind) nodes.push(h('span', { key: 'behind', className: 'gf-warn' }, tf(t, 'status.behind', { n: git.behind })))
    else if (git.ahead) nodes.push(h('span', { key: 'ahead' }, tf(t, 'status.ahead', { n: git.ahead })))
    else if (git.dirty) nodes.push(h('span', { key: 'dirty', className: 'gf-warn' }, t('status.dirty')))
  }
  if (fetchJob && fetchJob.enabled) {
    const detail = [t('status.lastRefresh') + ': ' + (fetchJob.lastRunAt ? fmtTime(fetchJob.lastRunAt) : t('status.never'))]
    if (fetchJob.last) {
      detail.push(tf(t, 'status.fetchLine', {
        fresh: fetchJob.last.detail?.added ?? 0,
        failed: fetchJob.last.detail?.failed ?? 0,
      }))
    }
    nodes.push(h('span', {
      key: 'auto',
      className: fetchJob.last && !fetchJob.last.ok ? 'gf-warn' : undefined,
      title: detail.join(' · '),
    }, `↻ ${Math.max(1, Math.round(fetchJob.intervalMs / 60000))}m`))
  }
  if (fetchJob && fetchJob.running) nodes.push(h('span', { key: 'running', className: 'gf-muted' }, t('status.running')))
  if (syncJob && syncJob.enabled) {
    const detail = [
      tf(t, 'status.autoSyncEvery', { n: Math.max(1, Math.round(syncJob.intervalMs / 60000)) }),
      syncJob.nextDueAt ? tf(t, 'status.nextIn', { age: fmtIn(syncJob.nextDueAt) }) : '',
      t('status.lastSync') + ': ' + (syncJob.lastRunAt ? fmtTime(syncJob.lastRunAt) : t('status.never')),
      syncJob.last ? (syncJob.last.ok ? t('status.synced') : t('status.syncFailed')) : '',
    ].filter(Boolean).join(' · ')
    nodes.push(h('span', {
      key: 'sync',
      className: syncJob.last && !syncJob.last.ok ? 'gf-warn' : undefined,
      title: detail,
    }, `⇄ ${Math.max(1, Math.round(syncJob.intervalMs / 60000))}m`))
  }
  return h('div', { className: 'gf-status' }, nodes)
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
  return h(Toast, {
    key: String(toast.at),
    text: toast.text,
    icon: toast.error ? h(IconWarningOutlineRegular, { size: 16 }) : undefined,
    holdMs: toast.undo ? 7000 : 4000,
    actions: actions,
    onDone: function () { controller.dismissToast() },
  })
}

export function ErrorState({ state, controller, t }: {
  state: ClientState
  controller: Controller
  t: Translate
}) {
  return h(EmptyState, {
    icon: h(IconRss, { size: 28 }),
    title: t('error.title'),
    action: h(Button, {
      variant: 'primary',
      size: 'sm',
      onClick: function () { void controller.load({ force: true }) },
    }, t('action.retry')),
  },
  h('p', { className: 'gf-placeholder-hint error' }, state.error),
  state.repo ? h('p', { className: 'gf-placeholder-hint' }, state.repo) : null)
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
    tf(t, 'status.autoEvery', { n: Math.max(1, Math.round(job.intervalMs / 60000)) }),
    job.nextDueAt ? tf(t, 'status.nextIn', { age: fmtIn(job.nextDueAt) }) : '',
    t('status.lastRefresh') + ': ' + age,
    run ? tf(t, 'status.feedCount', { n: run.detail?.feeds ?? 0 }) : '',
    run ? tf(t, 'status.fetchLine', { fresh: run.detail?.added ?? 0, failed: run.detail?.failed ?? 0 }) : '',
  ].filter(Boolean).join(' · ')
  return h('span', {
    className: 'gf-refresh-state' + (job.running ? ' running' : broken ? ' warn' : ''),
    title: title,
    'aria-label': title,
    role: 'status',
  },
  h(IconRefreshOutlineRegular, { size: 12 }),
  job.running ? '…' : age)
}

export function EmptyArticle({ state, t }: { state: ClientState; t: Translate }) {
  const unread = state.items.filter(function (item) { return !state.read.has(item.id) }).length
  return h(EmptyState, {
    icon: h(IconRss, { size: 28 }),
    title: t('page.title'),
    hint: tf(t, 'items.count', { n: state.items.length }) + ' · ' + tf(t, 'unread.count', { n: unread }),
  },
  h('p', { className: 'gf-placeholder-hint' }, t('empty.articleHint')))
}
