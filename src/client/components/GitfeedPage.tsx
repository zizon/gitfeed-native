/** The full three-pane reader in the central main panel. */

import { useEffect, useRef, useState } from '../react.js'
import type { CSSProperties, RefObject } from '../react.js'
import {
  Button,
  IconBranchOutlineRegular,
  IconDownloadOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconRefreshOutlineRegular,
  IconSlidersTwoOutlineRegular,
  MenuSurface,
  Tooltip,
  focusWithoutRing,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { DEFAULT_LIST, DEFAULT_RAIL, LIST_MAX, LIST_MIN, RAIL_MAX, RAIL_MIN } from '../constants.js'
import { useKeyboard, useMount, useOutsideClose } from '../hooks.js'
import type { ClientState, Controller, GitfeedPageProps } from '../types.js'
import type { Translate } from '../locales.js'
import { clamp } from '../util.js'
import { IconRss } from '../icons.js'
import { Article } from './Article.js'
import { FeedRail } from './FeedRail.js'
import { ItemList } from './ItemList.js'
import { FilterTabs, SearchBox } from './FilterBar.js'
import { IconButton } from './Controls.js'
import { ErrorState } from './Placeholders.js'
import { DisplayPrefs } from './Prefs.js'
import { GitStatus } from './Status.js'
import { Toasts } from './Toasts.js'

/**
 * The source list and the divider that resizes it: one pane. Folding eases the
 * pane's own track while its content keeps the width it was laid out at and is
 * clipped, so nothing reflows on the way; when the fade is done the content
 * leaves and the spine takes the spot.
 */
function SourcePane({ state, controller, t, foldSettled, spineRef, onResizeStart }: {
  state: ClientState
  controller: Controller
  t: Translate
  foldSettled: boolean
  spineRef: RefObject<HTMLDivElement>
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className={`gf-sourcepane${state.railHidden ? ' folded' : ''}${state.railHidden && !foldSettled ? ' fading' : ''}`}
    >
      {state.railHidden && foldSettled
        ? null
        : (
          <>
            <div className="gf-sourceclip">
              <FeedRail state={state} controller={controller} t={t} />
            </div>
            <div
              className="gf-splitter"
              role="separator"
              aria-orientation="vertical"
              title={t('action.resize')}
              onPointerDown={onResizeStart}
              onDoubleClick={function () { controller.setWidths({ railW: DEFAULT_RAIL }) }}
            />
          </>
        )}
      {state.railHidden && foldSettled
        ? (
          /* The folded list leaves a spine where its header was, and the toggle
             that reopens it sits at that header's corner: folding moves the
             control down the pane's edge, not across the page. */
          <div className="gf-spine" ref={spineRef}>
            <IconButton
              icon={<IconPanelLeftOutlineRegular size={16} />}
              label={t('action.expandSources')}
              small
              onClick={function () { controller.setRailHidden(false) }}
            />
          </div>
        )
        : null}
    </div>
  )
}

/** The page's working area: the source list, the rows, and the open article. */
function PageBody({ state, controller, t, foldSettled, spineRef, startResize }: {
  state: ClientState
  controller: Controller
  t: Translate
  foldSettled: boolean
  spineRef: RefObject<HTMLDivElement>
  startResize: (which: 'rail' | 'list') => (event: React.PointerEvent) => void
}) {
  return (
    <div className="gf-body">
      {/* The rail and the divider that resizes it are one pane: folding eases
            the pane's own track while its content keeps the width it was laid
            out at and is clipped, so nothing reflows on the way. When the fade
            is done the content leaves and the spine takes the spot. */}
      <SourcePane
        state={state}
        controller={controller}
        t={t}
        foldSettled={foldSettled}
        spineRef={spineRef}
        onResizeStart={startResize('rail')}
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
  )
}

/**
 * The rail leaves the DOM only after its fade: folding first lets the content
 * fade in place while the pane clips it, then unmounts it and hands the spot to
 * the spine. Unfolding mounts the rail again at once — it fades back in as the
 * pane opens. The pressed control left the DOM with the content, so focus
 * follows it to the spine's toggle; a reader who was elsewhere keeps their place.
 */
function useFold(state: ClientState, spineRef: RefObject<HTMLDivElement>): boolean {
  const [foldSettled, setFoldSettled] = useState(state.railHidden)

  useEffect(function () {
    if (!state.railHidden) {
      setFoldSettled(false)
      return
    }
    const timer = setTimeout(function () { setFoldSettled(true) }, FOLD_SETTLE_MS)
    return function () { clearTimeout(timer) }
  }, [state.railHidden])

  useEffect(function () {
    if (!state.railHidden || !foldSettled) return
    const active = document.activeElement
    const opener = spineRef.current ? spineRef.current.querySelector('button') : null
    if (opener && (active === null || active === document.body)) focusWithoutRing(opener, { preventScroll: true })
  }, [state.railHidden, foldSettled, spineRef])

  return foldSettled
}

/** A pointer drag on one splitter, clamped to what the two panes may take. */
function usePaneResize(
  state: ClientState, controller: Controller, rootRef: RefObject<HTMLDivElement>,
): { dragging: boolean; startResize: (which: 'rail' | 'list') => (event: React.PointerEvent) => void } {
  /** A rail drag writes widths at pointer cadence; the pane must not ease them. */
  const [dragging, setDragging] = useState(false)

  function startResize(which: 'rail' | 'list') {
    return function (event: React.PointerEvent) {
      event.preventDefault()
      const startX = event.clientX
      const start = which === 'rail' ? state.railW : state.listW
      const total = rootRef.current ? rootRef.current.clientWidth : 1200
      // A hidden rail occupies nothing, so the list may grow by its width; the
      // pane's own width is kept for when it comes back.
      const rail = state.railHidden ? 0 : state.railW
      if (which === 'rail') setDragging(true)
      function move(moveEvent: PointerEvent) {
        const delta = moveEvent.clientX - startX
        if (which === 'rail') {
          controller.setWidths({ railW: clamp(start + delta, RAIL_MIN, Math.min(RAIL_MAX, total - 520)) })
        } else {
          controller.setWidths({ listW: clamp(start + delta, LIST_MIN, Math.min(LIST_MAX, total - rail - 340)) })
        }
      }
      function up() {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (which === 'rail') setDragging(false)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }
  }

  return { dragging: dragging, startResize: startResize }
}

/**
 * What each control would say if its label is collapsed away: the verb, and the
 * state that makes it the one worth pressing. The hint always names the object,
 * because the bar has two: Refresh reads the feeds, Pull and Sync reads move the
 * git-backed archive.
 */
function tipsOf(state: ClientState, t: Translate): { pullTip: string; fetchTip: string; syncTip: string } {
  const pullTip = state.git && state.git.behind
    ? `${t('action.pull')} · ${t('status.behind', { n: state.git.behind })}`
    : t('action.pullHint')
  const fetchTip = state.busy.fetch ? t('status.running') : t('action.fetchHint')
  const syncTip = state.git && state.git.dirty
    ? `${t('action.sync')} · ${t('status.dirty')}`
    : t('action.syncHint')
  return { pullTip: pullTip, fetchTip: fetchTip, syncTip: syncTip }
}

/** The page bar: the filters and search in reach, and the jobs on the right. */
function PageToolbar({ state, controller, t, searchRef, prefsRef, prefsOpen, onPrefsToggle, fetchTip, pullTip, syncTip }: {
  state: ClientState
  controller: Controller
  t: Translate
  searchRef: RefObject<HTMLInputElement>
  prefsRef: RefObject<HTMLDivElement>
  prefsOpen: boolean
  onPrefsToggle: () => void
  fetchTip: string
  pullTip: string
  syncTip: string
}) {
  return (
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
              onClick={onPrefsToggle}
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
        {/* Reading the feeds and moving the archive are two different jobs;
            the divider is where the bar says so, not only the words. */}
        <span className="gf-actionsep" role="separator" aria-orientation="vertical" />
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
  )
}

/** The whole snapshot: one list, one article pane, one source list. */
const wholeState = function (state: ClientState) { return state }

/**
 * How long the folded rail's content fades before it leaves the DOM. The pane's
 * own track eases for `--ds-transition-duration-slow` (300ms); this is the half
 * the app's sidebar spends fading out before its rail layout takes over, and
 * the spine arrives when it is done.
 */
const FOLD_SETTLE_MS = 150

export function GitfeedPage({ controller, t, useReader }: GitfeedPageProps) {
  const state = useReader(wholeState)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const prefsRef = useRef<HTMLDivElement>(null)
  const spineRef = useRef<HTMLDivElement>(null)
  useMount(controller)
  useKeyboard(controller, searchRef, rootRef)
  useOutsideClose(prefsRef, prefsOpen, function () { setPrefsOpen(false) })

  const foldSettled = useFold(state, spineRef)

  const { dragging, startResize } = usePaneResize(state, controller, rootRef)

  const { pullTip, fetchTip, syncTip } = tipsOf(state, t)

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
      data-dragging={dragging || undefined}
    >
      <PageToolbar
        state={state}
        controller={controller}
        t={t}
        searchRef={searchRef}
        prefsRef={prefsRef}
        prefsOpen={prefsOpen}
        onPrefsToggle={function () { setPrefsOpen(!prefsOpen) }}
        fetchTip={fetchTip}
        pullTip={pullTip}
        syncTip={syncTip}
      />
      {state.loadError
        ? <div className="gf-banner">{t('status.banner', { error: state.loadError })}</div>
        : null}
      <PageBody
        state={state}
        controller={controller}
        t={t}
        foldSettled={foldSettled}
        spineRef={spineRef}
        startResize={startResize}
      />
      <Toasts toast={state.toast} controller={controller} t={t} />
    </div>
  )
}
