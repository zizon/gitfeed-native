/** The full three-pane reader in the central main panel. */

import { useRef, useState } from '../react.js'
import type { CSSProperties } from '../react.js'
import {
  Button,
  IconBranchOutlineRegular,
  IconDownloadOutlineRegular,
  IconRefreshOutlineRegular,
  IconSlidersTwoOutlineRegular,
  MenuSurface,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_LIST, DEFAULT_RAIL, LIST_MAX, LIST_MIN, RAIL_MAX, RAIL_MIN } from '../constants.js'
import { useKeyboard, useMount, useOutsideClose } from '../hooks.js'
import type { ClientState, GitfeedPageProps } from '../types.js'
import { clamp } from '../util.js'
import { IconRss } from '../icons.js'
import { Article } from './Article.js'
import { FeedRail } from './FeedRail.js'
import { ItemList } from './ItemList.js'
import { FilterTabs, SearchBox } from './FilterBar.js'
import { ErrorState } from './Placeholders.js'
import { DisplayPrefs } from './Prefs.js'
import { GitStatus } from './Status.js'
import { Toasts } from './Toasts.js'

/** The whole snapshot: one list, one article pane, one source list. */
const wholeState = function (state: ClientState) { return state }

export function GitfeedPage({ controller, t, useReader }: GitfeedPageProps) {
  const state = useReader(wholeState)
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
          controller.setWidths({ railW: clamp(start + delta, RAIL_MIN, Math.min(RAIL_MAX, total - 520)) })
        } else {
          controller.setWidths({ listW: clamp(start + delta, LIST_MIN, Math.min(LIST_MAX, total - state.railW - 340)) })
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

  // What each action would say if its label is collapsed away: the verb, and
  // the state that makes it the one worth pressing.
  const pullTip = state.git && state.git.behind
    ? `${t('action.pull')} · ${t('status.behind', { n: state.git.behind })}`
    : t('action.pull')
  const fetchTip = state.busy.fetch ? t('status.running') : t('action.fetch')
  const syncTip = state.git && state.git.dirty
    ? `${t('action.sync')} · ${t('status.dirty')}`
    : t('action.sync')

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
            <Tooltip label={t('action.prefs')} side="bottom" delayMs={500} portal>
              <Button
                variant="ghost"
                size="sm"
                className="gf-actbtn"
                icon={<IconSlidersTwoOutlineRegular size={13} />}
                aria-label={t('action.prefs')}
                aria-haspopup="dialog"
                aria-expanded={prefsOpen}
                onClick={function () { setPrefsOpen(!prefsOpen) }}
              >
                <span className="gf-actbtn-label">{t('action.prefs')}</span>
              </Button>
            </Tooltip>
            {prefsOpen
              ? (
                <MenuSurface className="gf-popover gf-prefs">
                  <DisplayPrefs state={state} controller={controller} t={t} />
                </MenuSurface>
              )
              : null}
          </div>
          <Tooltip label={pullTip} side="bottom" delayMs={500} portal>
            <Button
              variant="ghost"
              size="sm"
              className="gf-actbtn"
              icon={<IconDownloadOutlineRegular size={13} />}
              aria-label={pullTip}
              disabled={state.busy.pull || !state.allowGit || !state.git || !state.git.repo}
              onClick={function () { void controller.runAction('pull') }}
            >
              <span className="gf-actbtn-label">{t('action.pull')}</span>
            </Button>
          </Tooltip>
          <Tooltip label={fetchTip} side="bottom" delayMs={500} portal>
            <Button
              variant="ghost"
              size="sm"
              className="gf-actbtn"
              icon={<IconRefreshOutlineRegular size={13} />}
              aria-label={fetchTip}
              disabled={state.busy.fetch}
              onClick={function () { void controller.runAction('fetch') }}
            >
              <span className="gf-actbtn-label">{state.busy.fetch ? t('status.running') : t('action.fetch')}</span>
            </Button>
          </Tooltip>
          <Tooltip label={syncTip} side="bottom" delayMs={500} portal>
            <Button
              variant="ghost"
              size="sm"
              className="gf-actbtn"
              icon={<IconBranchOutlineRegular size={13} />}
              aria-label={syncTip}
              disabled={state.busy.sync || !state.allowGit || !state.git || !state.git.repo}
              onClick={function () { void controller.runAction('sync') }}
            >
              <span className="gf-actbtn-label">{t('action.sync')}</span>
            </Button>
          </Tooltip>
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
