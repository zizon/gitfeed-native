/** The full three-pane reader in the central main panel. */

import { useRef, useState } from '../react.js'
import type { CSSProperties } from '../react.js'
import {
  Button,
  IconDownloadOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconSlidersTwoOutlineRegular,
  MenuSurface,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_LIST, DEFAULT_RAIL } from '../constants.js'
import { useKeyboard, useMount, useOutsideClose, useReader } from '../hooks.js'
import type { GitfeedPageProps } from '../types.js'
import { clamp } from '../util.js'
import { IconRss } from '../icons.js'
import { Article } from './Article.js'
import { FeedRail } from './FeedRail.js'
import { ItemList } from './ItemList.js'
import { DisplayPrefs, ErrorState, FilterTabs, GitStatus, SearchBox, Toasts } from './Shared.js'

export function GitfeedPage({ controller, t }: GitfeedPageProps) {
  const state = useReader(controller)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const prefsRef = useRef<HTMLDivElement>(null)
  useMount(controller)
  useKeyboard(controller, searchRef, rootRef)
  useOutsideClose(prefsRef, prefsOpen, function () { setPrefsOpen(false) })

  function startResize(which: 'rail' | 'list') {
    return function (event: React.PointerEvent) {
      event.preventDefault()
      const startX = event.clientX
      const start = which === 'rail' ? state.railW : state.listW
      const total = rootRef.current ? rootRef.current.clientWidth : 1200
      function move(moveEvent: PointerEvent) {
        const delta = moveEvent.clientX - startX
        if (which === 'rail') {
          controller.setWidths({ railW: clamp(start + delta, 150, Math.min(460, total - 520)) })
        } else {
          controller.setWidths({ listW: clamp(start + delta, 260, Math.min(760, total - state.railW - 340)) })
        }
      }
      function up() {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }
  }

  // The toolbar emphasises the git action that actually applies right now:
  // pull when the branch is behind, sync when there is something to push,
  // fetch otherwise. The others stay available, just not as the primary.
  const primaryAction = !state.git || !state.git.repo ? 'fetch'
    : state.git.behind ? 'pull'
      : state.git.dirty ? 'sync' : 'fetch'

  if (state.status === 'error' && !state.items.length) {
    return (
      <div className="gf gf-page">
        <ErrorState state={state} controller={controller} t={t} />
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className="gf gf-page"
      style={{
        '--gf-rail': `${state.railW}px`,
        '--gf-list': `${state.listW}px`,
      } as CSSProperties}
    >
      <header className="gf-toolbar">
        {/* The list's own controls already state the figures that matter; the
            brand stays a name. */}
        <div className="gf-brand">
          <IconRss size={20} />
          <span className="gf-brand-name">{t('page.title')}</span>
        </div>
        <FilterTabs filter={state.filter} controller={controller} t={t} />
        <SearchBox controller={controller} t={t} value={state.query} inputRef={searchRef} />
        <div className="gf-spacer" />
        <GitStatus state={state} t={t} />
        <div className="gf-actions">
          <div className="gf-prefs-wrap" ref={prefsRef}>
            <Button
              variant="ghost"
              size="sm"
              icon={<IconSlidersTwoOutlineRegular size={14} />}
              aria-haspopup="dialog"
              aria-expanded={prefsOpen}
              onClick={function () { setPrefsOpen(!prefsOpen) }}
            >
              {t('action.prefs')}
            </Button>
            {prefsOpen
              ? (
                <MenuSurface className="gf-popover gf-prefs">
                  <DisplayPrefs state={state} controller={controller} t={t} />
                </MenuSurface>
              )
              : null}
          </div>
          <Button
            variant={primaryAction === 'pull' ? 'primary' : 'ghost'}
            size="sm"
            icon={<IconDownloadOutlineRegular size={14} />}
            disabled={state.busy.pull || !state.allowGit || !state.git || !state.git.repo}
            title={state.git && state.git.behind ? t('status.behind', { n: state.git.behind }) : t('action.pull')}
            onClick={function () { void controller.runAction('pull') }}
          >
            {t('action.pull')}
          </Button>
          <Button
            variant={primaryAction === 'fetch' ? 'primary' : 'ghost'}
            size="sm"
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={state.busy.fetch}
            onClick={function () { void controller.runAction('fetch') }}
          >
            {state.busy.fetch ? t('status.running') : t('action.fetch')}
          </Button>
          <Button
            variant={primaryAction === 'sync' ? 'primary' : 'ghost'}
            size="sm"
            icon={<IconRightUpOutlineRegular size={14} />}
            disabled={state.busy.sync || !state.allowGit || !state.git || !state.git.repo}
            title={state.git && state.git.dirty ? t('status.dirty') : t('action.sync')}
            onClick={function () { void controller.runAction('sync') }}
          >
            {t('action.sync')}
          </Button>
        </div>
      </header>
      {state.loadError
        ? <div className="gf-banner">{t('status.banner', { error: state.loadError })}</div>
        : null}
      <div className="gf-body">
        <FeedRail state={state} controller={controller} t={t} />
        <div
          className="gf-splitter"
          role="separator"
          aria-orientation="vertical"
          title={t('action.resize')}
          onPointerDown={startResize('rail')}
          onDoubleClick={function () { controller.setWidths({ railW: DEFAULT_RAIL }) }}
        />
        <ItemList state={state} controller={controller} t={t} wide={!state.current} />
        {state.current
          ? (
            <>
              <div
                className="gf-splitter"
                role="separator"
                aria-orientation="vertical"
                title={t('action.resize')}
                onPointerDown={startResize('list')}
                onDoubleClick={function () { controller.setWidths({ listW: DEFAULT_LIST }) }}
              />
              <div className="gf-articlepane">
                <Article state={state} controller={controller} t={t} />
              </div>
            </>
          )
          : null}
      </div>
      <Toasts toast={state.toast} controller={controller} t={t} />
    </div>
  )
}
