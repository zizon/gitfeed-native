/** The compact reader that lives in the right Sidebar. */

import { useRef, useState } from '../react.js'
import type { CSSProperties } from '../react.js'
import {
  Button,
  IconEllipsisOutlineRegular,
  IconRefreshOutlineRegular,
  MenuSurface,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Chevron } from '../icons.js'
import { DEFAULT_LIST, LIST_MAX, LIST_MIN } from '../constants.js'
import { useElementWidth, useKeyboard, useMount, useOutsideClose } from '../hooks.js'
import { clamp, fmtIn, fmtTime } from '../util.js'
import type { ClientState, GitfeedRailProps } from '../types.js'
import type { Controller } from '../types.js'
import type { Translate } from '../locales.js'
import { Article } from './Article.js'
import { FeedRail } from './FeedRail.js'
import { ItemList } from './ItemList.js'
import { IconButton } from './Controls.js'
import { DisplayPrefs, ErrorState, FilterTabs, jobOf, RefreshState, SearchBox, Toasts } from './Shared.js'

function RailMenu({ state, controller, t, onClose }: {
  state: ClientState
  controller: Controller
  t: Translate
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(ref, true, onClose)
  function actionRow(label: string, disabled: boolean, run: () => void) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="gf-menubtn"
        disabled={disabled}
        onClick={function () { onClose(); run() }}
      >
        {label}
      </Button>
    )
  }
  const fetchJob = jobOf(state, 'fetch')
  const syncJob = jobOf(state, 'git')
  const fetchCadence = fetchJob && fetchJob.enabled
    ? t('status.autoEvery', { n: Math.max(1, Math.round(fetchJob.intervalMs / 60000)) })
    : ''
  const fetchNext = fetchJob && fetchJob.nextDueAt
    ? ` · ${t('status.nextIn', { age: fmtIn(fetchJob.nextDueAt) })}`
    : ''
  const fetchState = fetchJob
    ? fetchJob.running
      ? t('status.running')
      : `${t('status.lastRefresh')}: ${fetchJob.lastRunAt ? fmtTime(fetchJob.lastRunAt) : t('status.never')}`
    : ''
  const fetchCounts = fetchJob && fetchJob.last && !fetchJob.running
    ? [
      t('status.feedCount', { n: fetchJob.last.detail?.feeds ?? 0 }),
      t('status.fetchLine', {
        fresh: fetchJob.last.detail?.added ?? 0,
        failed: fetchJob.last.detail?.failed ?? 0,
      }),
    ].join(' · ')
    : ''
  const fetchInfo = `${fetchState}${fetchCounts ? ` · ${fetchCounts}` : ''}`
  const syncCadence = syncJob && syncJob.enabled
    ? t('status.autoSyncEvery', { n: Math.max(1, Math.round(syncJob.intervalMs / 60000)) })
    : ''
  const syncNext = syncJob && syncJob.nextDueAt
    ? ` · ${t('status.nextIn', { age: fmtIn(syncJob.nextDueAt) })}`
    : ''
  const syncOk = syncJob && syncJob.last ? (syncJob.last.ok ? t('status.synced') : t('status.syncFailed')) : ''
  const syncState = syncJob && syncJob.lastRunAt
    ? `${t('status.lastSync')}: ${fmtTime(syncJob.lastRunAt)}${syncOk ? ` · ${syncOk}` : ''}`
    : null
  return (
    <MenuSurface ref={ref} className="gf-popover gf-rail-menu">
      <DisplayPrefs state={state} controller={controller} t={t} />
      <div className="gf-menu-sep" />
      <div className="gf-menu-label">{t('menu.actions')}</div>
      {actionRow(
        t('action.pull'),
        state.busy.pull || !state.allowGit || !state.git || !state.git.repo,
        function () { void controller.runAction('pull') },
      )}
      {actionRow(
        t('action.sync'),
        state.busy.sync || !state.allowGit || !state.git || !state.git.repo,
        function () { void controller.runAction('sync') },
      )}
      <div className="gf-menu-sep" />
      <div className="gf-menu-label">{t('menu.refresh')}</div>
      <div className="gf-menu-info">
        {fetchJob && fetchJob.enabled ? `${fetchCadence}${fetchNext}` : t('status.autoOff')}
      </div>
      {fetchJob ? <div className="gf-menu-info">{fetchInfo}</div> : null}
      <div className="gf-menu-sep" />
      <div className="gf-menu-label">{t('menu.sync')}</div>
      <div className="gf-menu-info" title={syncJob?.error ?? undefined}>
        {syncJob && syncJob.enabled ? `${syncCadence}${syncNext}` : t('status.autoSyncOff')}
      </div>
      {syncState ? <div className="gf-menu-info">{syncState}</div> : null}
      <div className="gf-menu-sep" />
      <div className="gf-menu-label">{t('menu.repo')}</div>
      <div className="gf-menu-info">{state.repo || '~'}</div>
      {state.git && !state.git.repo
        ? <div className="gf-menu-info">{t('repo.hintLocal')}</div>
        : null}
    </MenuSurface>
  )
}

/** The whole snapshot: the rail's bar, list, and article all read it. */
const wholeState = function (state: ClientState) { return state }

export function GitfeedRail({ controller, t, useReader, useTabInfo }: GitfeedRailProps) {
  const state = useReader(wholeState)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [feedsOpen, setFeedsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const width = useElementWidth(rootRef)
  const wide = width >= 680
  const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null
  const visible = !tabInfo || !tabInfo.tab || tabInfo.tab.visible
  useMount(controller)
  useKeyboard(controller, searchRef, rootRef, visible)

  // The list keeps at least 320px for the article, so the stored width is
  // clamped to this Surface's own width instead of only to its global range.
  const wideListW = clamp(state.listW, LIST_MIN, Math.max(LIST_MIN, width - 325))

  function startResize() {
    return function (event: React.PointerEvent) {
      event.preventDefault()
      const startX = event.clientX
      const start = wideListW
      const total = rootRef.current ? rootRef.current.clientWidth : width
      const max = Math.max(LIST_MIN, Math.min(LIST_MAX, total - 325))
      function move(moveEvent: PointerEvent) {
        controller.setWidths({ listW: clamp(start + (moveEvent.clientX - startX), LIST_MIN, max) })
      }
      function up() {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }
  }

  const feedLabel = state.feedId ? controller.feedTitle(state.feedId) : t('feed.all')
  const fetchRunning = !!jobOf(state, 'fetch')?.running

  return (
    <div className="gf gf-railpage" ref={rootRef}>
      <div className="gf-rail-bar">
        <button
          type="button"
          className="gf-feed-trigger"
          aria-haspopup="dialog"
          aria-expanded={feedsOpen}
          onClick={function () { setFeedsOpen(!feedsOpen); setMenuOpen(false) }}
        >
          <span className="name">{feedLabel}</span>
          <Chevron open={feedsOpen} />
        </button>
        <IconButton
          icon={<IconRefreshOutlineRegular size={16} />}
          label={fetchRunning ? t('status.running') : t('action.fetch')}
          spin={fetchRunning}
          disabled={state.busy.fetch || fetchRunning}
          onClick={function () { void controller.runAction('fetch') }}
        />
        <IconButton
          icon={<IconEllipsisOutlineRegular size={16} />}
          label={t('action.more')}
          hasPopup="menu"
          expanded={menuOpen}
          onClick={function () { setMenuOpen(!menuOpen); setFeedsOpen(false) }}
        />
      </div>
      <div className="gf-rail-bar2">
        <FilterTabs filter={state.filter} controller={controller} t={t} compact />
        <SearchBox controller={controller} t={t} value={state.query} inputRef={searchRef} compact />
        <RefreshState state={state} t={t} />
      </div>
      {state.loadError
        ? <div className="gf-banner">{t('status.banner', { error: state.loadError })}</div>
        : null}
      {state.status === 'error' && !state.items.length
        ? <ErrorState state={state} controller={controller} t={t} />
        // An open article splits the rail; with nothing open the list owns the
        // whole surface, so closing the article hands the space straight back
        // instead of leaving an empty pane next to a half-width list.
        : state.current
          ? wide
            ? (
              <div className="gf-wide" style={{ '--gf-list': `${wideListW}px` } as CSSProperties}>
                <ItemList state={state} controller={controller} t={t} wide />
                <div
                  className="gf-splitter"
                  role="separator"
                  aria-orientation="vertical"
                  title={t('action.resize')}
                  onPointerDown={startResize()}
                  onDoubleClick={function () { controller.setWidths({ listW: DEFAULT_LIST }) }}
                />
                <div className="gf-wide-article">
                  <Article state={state} controller={controller} t={t} />
                </div>
              </div>
            )
            : (
              <div className="gf-rail-article">
                <Article state={state} controller={controller} t={t} compact />
              </div>
            )
          : <ItemList state={state} controller={controller} t={t} wide />}
      {feedsOpen
        ? (
          <MenuSurface className="gf-popover gf-feedpop">
            <FeedRail
              state={state}
              controller={controller}
              t={t}
              compact
              onPick={function () { setFeedsOpen(false) }}
            />
          </MenuSurface>
        )
        : null}
      {menuOpen
        ? (
          <RailMenu
            state={state}
            controller={controller}
            t={t}
            onClose={function () { setMenuOpen(false) }}
          />
        )
        : null}
      <Toasts toast={state.toast} controller={controller} t={t} />
    </div>
  )
}
