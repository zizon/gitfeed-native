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
import { DisplayPrefs, EmptyArticle, ErrorState, FilterTabs, RefreshState, SearchBox, Toasts } from './Shared.js'

function RailMenu({ state, controller, t, onClose }: {
  state: ClientState
  controller: Controller
  t: Translate
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
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
  const auto = state.localFetch
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
    h('div', { className: 'gf-menu-sep' }),
    h('div', { className: 'gf-menu-label' }, t('menu.refresh')),
    h('div', { className: 'gf-menu-info' },
      auto && auto.enabled
        ? tf(t, 'status.autoEvery', { n: Math.max(1, Math.round(auto.intervalMs / 60000)) })
          + (auto.nextDueAt ? ' · ' + tf(t, 'status.nextIn', { age: fmtIn(auto.nextDueAt) }) : '')
        : t('status.autoOff')),
    auto
      ? h('div', { className: 'gf-menu-info' },
        (auto.running
          ? t('status.running')
          : t('status.lastRefresh') + ': ' + (auto.lastRunAt ? fmtTime(auto.lastRunAt) : t('status.never')))
        + (auto.last && !auto.running
          ? ' · ' + tf(t, 'status.feedCount', { n: auto.last.feeds })
            + ' · ' + tf(t, 'status.fetchLine', { fresh: auto.last.fresh, failed: auto.last.failed })
          : ''))
      : null,
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
        label: state.localFetch && state.localFetch.running ? t('status.running') : t('action.fetch'),
        spin: !!(state.localFetch && state.localFetch.running),
        disabled: state.busy.fetch || !!(state.localFetch && state.localFetch.running),
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
      : wide
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
        h('div', { className: 'gf-wide-article' },
          state.current ? h(Article, { state: state, controller: controller, t: t }) : h(EmptyArticle, { state: state, t: t })))
        : state.current
          ? h('div', { className: 'gf-rail-article' }, h(Article, { state: state, controller: controller, t: t, compact: true }))
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
