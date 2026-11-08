/** The compact reader that lives in the right Sidebar. */

import { h, useRef, useState } from '../react.js'
import type { CSSProperties } from '../react.js'
import {
  Button,
  IconEllipsisOutlineRegular,
  IconRefreshOutlineRegular,
  MenuSurface,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Chevron } from '../icons.js'
import { DEFAULT_LIST } from '../constants.js'
import { useElementWidth, useKeyboard, useMount, useOutsideClose, useReader } from '../hooks.js'
import { tf } from '../locales.js'
import { fmtIn, fmtTime } from '../util.js'
import type { ClientState, GitfeedRailProps } from '../types.js'
import type { Controller } from '../types.js'
import type { Translate } from '../locales.js'
import { clamp } from '../util.js'
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
  const [confirmUnsub, setConfirmUnsub] = useState(false)
  useOutsideClose(ref, true, onClose)
  function actionRow(label: string, disabled: boolean, run: () => void) {
    return h(Button, {
      variant: 'ghost',
      size: 'sm',
      className: 'gf-menubtn',
      disabled: disabled,
      onClick: function () { onClose(); run() },
    }, label)
  }
  // The rail's feed list lives in a popover behind the feed trigger, so a row's
  // hover mark is easy to miss. The menu names the current feed outright.
  const currentFeed = state.feedId ? state.feeds.find(function (feed) { return feed.id === state.feedId }) : null
  const fetchJob = jobOf(state, 'fetch')
  const syncJob = jobOf(state, 'git')
  const fetchCadence = fetchJob && fetchJob.enabled
    ? tf(t, 'status.autoEvery', { n: Math.max(1, Math.round(fetchJob.intervalMs / 60000)) })
    : ''
  const fetchNext = fetchJob && fetchJob.nextDueAt
    ? ` · ${tf(t, 'status.nextIn', { age: fmtIn(fetchJob.nextDueAt) })}`
    : ''
  const fetchState = fetchJob
    ? fetchJob.running
      ? t('status.running')
      : `${t('status.lastRefresh')}: ${fetchJob.lastRunAt ? fmtTime(fetchJob.lastRunAt) : t('status.never')}`
    : ''
  const fetchCounts = fetchJob && fetchJob.last && !fetchJob.running
    ? [
      tf(t, 'status.feedCount', { n: fetchJob.last.detail?.feeds ?? 0 }),
      tf(t, 'status.fetchLine', {
        fresh: fetchJob.last.detail?.added ?? 0,
        failed: fetchJob.last.detail?.failed ?? 0,
      }),
    ].join(' · ')
    : ''
  const fetchInfo = `${fetchState}${fetchCounts ? ` · ${fetchCounts}` : ''}`
  const syncCadence = syncJob && syncJob.enabled
    ? tf(t, 'status.autoSyncEvery', { n: Math.max(1, Math.round(syncJob.intervalMs / 60000)) })
    : ''
  const syncNext = syncJob && syncJob.nextDueAt
    ? ` · ${tf(t, 'status.nextIn', { age: fmtIn(syncJob.nextDueAt) })}`
    : ''
  const syncOk = syncJob && syncJob.last ? (syncJob.last.ok ? t('status.synced') : t('status.syncFailed')) : ''
  const syncState = syncJob && syncJob.lastRunAt
    ? `${t('status.lastSync')}: ${fmtTime(syncJob.lastRunAt)}${syncOk ? ` · ${syncOk}` : ''}`
    : null
  return h(MenuSurface, { ref: ref, className: 'gf-popover gf-rail-menu' },
    h(DisplayPrefs, { state: state, controller: controller, t: t }),
    h('div', { className: 'gf-menu-sep' }),
    h('div', { className: 'gf-menu-label' }, t('menu.actions')),
    actionRow(
      state.busy.fetch ? t('status.running') : t('action.fetch'),
      state.busy.fetch,
      function () { void controller.runAction('fetch') },
    ),
    actionRow(
      t('action.pull'),
      state.busy.pull || !state.allowGit || !state.git || !state.git.repo,
      function () { void controller.runAction('pull') },
    ),
    actionRow(
      t('action.sync'),
      state.busy.sync || !state.allowGit || !state.git || !state.git.repo,
      function () { void controller.runAction('sync') },
    ),
    currentFeed ? h('div', { className: 'gf-menu-sep' }) : null,
    currentFeed ? h('div', { className: 'gf-menu-label' }, t('menu.feed')) : null,
    currentFeed && confirmUnsub
      ? h('div', { className: 'gf-menu-confirm' },
        h('div', { className: 'gf-menu-info' }, t('confirm.unsubscribe')),
        h('div', { className: 'gf-menu-info' }, t('confirm.unsubscribeHint')),
        h('div', { className: 'gf-menu-confirm-row' },
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            className: 'gf-menubtn',
            onClick: function () { setConfirmUnsub(false) },
          }, t('action.cancel')),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            className: 'gf-menubtn gf-danger',
            disabled: state.busy.remove,
            onClick: function () { onClose(); void controller.removeFeed(currentFeed.id) },
          }, t('action.remove'))))
      : currentFeed
        ? h(Button, {
          variant: 'ghost',
          size: 'sm',
          className: 'gf-menubtn',
          onClick: function () { setConfirmUnsub(true) },
        }, tf(t, 'menu.unsubscribe', { name: currentFeed.title }))
        : null,
    h('div', { className: 'gf-menu-sep' }),
    h('div', { className: 'gf-menu-label' }, t('menu.refresh')),
    h('div', { className: 'gf-menu-info' },
      fetchJob && fetchJob.enabled ? `${fetchCadence}${fetchNext}` : t('status.autoOff')),
    fetchJob ? h('div', { className: 'gf-menu-info' }, fetchInfo) : null,
    h('div', { className: 'gf-menu-sep' }),
    h('div', { className: 'gf-menu-label' }, t('menu.sync')),
    h('div', { className: 'gf-menu-info', title: syncJob?.error ?? undefined },
      syncJob && syncJob.enabled ? `${syncCadence}${syncNext}` : t('status.autoSyncOff')),
    syncState ? h('div', { className: 'gf-menu-info' }, syncState) : null,
    h('div', { className: 'gf-menu-sep' }),
    h('div', { className: 'gf-menu-label' }, t('menu.repo')),
    h('div', { className: 'gf-menu-info' }, state.repo || '~'),
    state.git && !state.git.repo
      ? h('div', { className: 'gf-menu-info' }, t('repo.hintLocal'))
      : null)
}

export function GitfeedRail({ controller, t, useTabInfo }: GitfeedRailProps) {
  const state = useReader(controller)
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
  const wideListW = clamp(state.listW, 260, Math.max(260, width - 325))

  function startResize() {
    return function (event: React.PointerEvent) {
      event.preventDefault()
      const startX = event.clientX
      const start = wideListW
      const total = rootRef.current ? rootRef.current.clientWidth : width
      const max = Math.max(260, Math.min(900, total - 325))
      function move(moveEvent: PointerEvent) {
        controller.setWidths({ listW: clamp(start + (moveEvent.clientX - startX), 260, max) })
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

  return h('div', { className: 'gf gf-railpage', ref: rootRef },
    h('div', { className: 'gf-rail-bar' },
      h('button', {
        type: 'button', className: 'gf-feed-trigger', 'aria-haspopup': 'dialog', 'aria-expanded': feedsOpen,
        onClick: function () { setFeedsOpen(!feedsOpen); setMenuOpen(false) },
      },
      h('span', { className: 'name' }, feedLabel),
      h(Chevron, { open: feedsOpen })),
      h(IconButton, {
        icon: h(IconRefreshOutlineRegular, { size: 16 }),
        label: fetchRunning ? t('status.running') : t('action.fetch'),
        spin: fetchRunning,
        disabled: state.busy.fetch || fetchRunning,
        onClick: function () { void controller.runAction('fetch') },
      }),
      h(IconButton, {
        icon: h(IconEllipsisOutlineRegular, { size: 16 }),
        label: t('action.more'),
        hasPopup: 'menu',
        expanded: menuOpen,
        onClick: function () { setMenuOpen(!menuOpen); setFeedsOpen(false) },
      })),
    h('div', { className: 'gf-rail-bar2' },
      h(FilterTabs, { filter: state.filter, controller: controller, t: t, compact: true }),
      h(SearchBox, { controller: controller, t: t, value: state.query, inputRef: searchRef, compact: true }),
      h(RefreshState, { state: state, t: t })),
    state.loadError ? h('div', { className: 'gf-banner' }, tf(t, 'status.banner', { error: state.loadError })) : null,
    state.status === 'error' && !state.items.length
      ? h(ErrorState, { state: state, controller: controller, t: t })
      // An open article splits the rail; with nothing open the list owns the
      // whole surface, so closing the article hands the space straight back
      // instead of leaving an empty pane next to a half-width list.
      : state.current
        ? wide
          ? h('div', {
            className: 'gf-wide',
            style: { '--gf-list': `${wideListW}px` } as CSSProperties,
          },
          h(ItemList, { state: state, controller: controller, t: t, wide: true }),
          h('div', {
            className: 'gf-splitter', role: 'separator', 'aria-orientation': 'vertical',
            title: t('action.resize'),
            onPointerDown: startResize(),
            onDoubleClick: function () { controller.setWidths({ listW: DEFAULT_LIST }) },
          }),
          h('div', { className: 'gf-wide-article' }, h(Article, { state: state, controller: controller, t: t })))
          : h('div', { className: 'gf-rail-article' }, h(Article, { state: state, controller: controller, t: t, compact: true }))
        : h(ItemList, { state: state, controller: controller, t: t, wide: true }),
    feedsOpen ? h(MenuSurface, { className: 'gf-popover gf-feedpop' },
      h(FeedRail, {
        state: state, controller: controller, t: t, compact: true,
        onPick: function () { setFeedsOpen(false) },
      })) : null,
    menuOpen ? h(RailMenu, {
      state: state, controller: controller, t: t,
      onClose: function () { setMenuOpen(false) },
    }) : null,
    h(Toasts, { toast: state.toast, controller: controller, t: t }))
}
