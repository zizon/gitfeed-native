// The page's own chrome, rendered: the source list is a panel *of the page*, so
// the toolbar's toggle collapses it and the rows take the width. jsdom has no
// layout, so what this holds is the structure the geometry follows — with the
// panel hidden, the rail and its splitter are not rendered at all — and the
// control that brings them back. The preference that remembers the choice is
// covered by the controller and prefs-store suites.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { esbuildBin, finish, ok, repoRoot, skip } from './harness.mjs'

const esbuild = esbuildBin()
const checkout = process.env.DSH_CHECKOUT || path.join(os.homedir(), 'deepseek-harness')
const reactDir = path.join(checkout, 'node_modules', '.pnpm', 'react@18.3.1', 'node_modules', 'react')
const domDir = path.join(checkout, 'node_modules', '.pnpm', 'react-dom@18.3.1_react@18.3.1', 'node_modules', 'react-dom')
const jsdomEntry = path.join(checkout, 'node_modules', 'jsdom', 'lib', 'api.js')

/** The shared atoms the page and its panes import, as renderable stand-ins. */
function primitivesStub() {
  const glyphs = {
    IconSearchOutlineRegular: 'search',
    IconCheckOutlineRegular: 'check',
    IconCloseOutlineRegular: 'close',
    IconChevronRightOutlineRegular: 'right',
    IconChevronLeftOutlineRegular: 'left',
    IconChevronDownOutlineRegular: 'down',
    IconPlusOutlineRegular: 'plus',
    IconRefreshOutlineRegular: 'refresh',
    IconDownloadOutlineRegular: 'download',
    IconEllipsisOutlineRegular: 'ellipsis',
    IconWarningOutlineRegular: 'warning',
    IconRightUpOutlineRegular: 'up',
    IconBranchOutlineRegular: 'branch',
    IconSlidersTwoOutlineRegular: 'sliders',
    IconPanelLeftOutlineRegular: 'panel',
  }
  return [
    "import * as React from 'react'",
    'const button = (props) => React.createElement(\'button\', {',
    "  type: props.type || 'button', className: props.className, disabled: props.disabled,",
    "  title: props.title, 'aria-label': props['aria-label'], 'aria-pressed': props['aria-pressed'],",
    "  'aria-haspopup': props['aria-haspopup'], 'aria-expanded': props['aria-expanded'], onClick: props.onClick,",
    '}, props.children)',
    'export const Button = button',
    'export const MenuItemButton = button',
    'export const Pill = button',
    'export const Input = React.forwardRef((props, ref) => React.createElement(\'input\', {',
    "  ref: ref, className: props.className, type: props.type, value: props.value,",
    "  placeholder: props.placeholder, onChange: props.onChange, disabled: props.disabled,",
    "  'aria-label': props['aria-label'], autoComplete: props.autoComplete,",
    '}))',
    'export const Switch = (props) => React.createElement(\'input\', {',
    "  type: 'checkbox', checked: !!props.checked, disabled: props.disabled,",
    "  'aria-label': props.label, onChange: (event) => props.onChange && props.onChange(event.target.checked),",
    '})',
    'export const Menu = (props) => (props.open',
    "  ? React.createElement('div', { className: props.className }, props.children)",
    '  : (props.anchor || null))',
    'export const MenuSurface = (props) => React.createElement(\'div\', { className: props.className }, props.children)',
    'export const Tooltip = (props) => React.createElement(React.Fragment, null, props.children)',
    'export const Toast = () => null',
    ...Object.entries(glyphs).map(([name, key]) => (
      `export const ${name} = () => React.createElement('svg', { 'data-glyph': ${JSON.stringify(key)} })`
    )),
    '',
  ].join('\n')
}

if (esbuild === undefined || !existsSync(reactDir) || !existsSync(domDir) || !existsSync(jsdomEntry)) {
  skip('the page hides its source list', 'no react-dom and jsdom to render the page with')
} else {
  const out = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-page-dom-'))
  const stub = path.join(out, 'primitives.mjs')
  const bundle = path.join(out, 'page.mjs')
  try {
    mkdirSync(path.join(out, 'node_modules'), { recursive: true })
    symlinkSync(reactDir, path.join(out, 'node_modules', 'react'), 'dir')
    symlinkSync(domDir, path.join(out, 'node_modules', 'react-dom'), 'dir')
    writeFileSync(stub, primitivesStub())
    execFileSync(esbuild, [
      path.join(repoRoot, 'src', 'client', 'components', 'GitfeedPage.tsx'),
      '--bundle',
      '--format=esm',
      '--platform=node',
      '--jsx=automatic',
      '--external:react',
      '--external:react/jsx-runtime',
      '--external:react-dom',
      `--alias:@deepseek-ai/dsh-client-ui-primitives=${stub}`,
      `--outfile=${bundle}`,
      '--log-level=warning',
    ])

    const { JSDOM } = await import(pathToFileURL(jsdomEntry).href)
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
    const { window } = dom
    globalThis.window = window
    globalThis.document = window.document
    globalThis.HTMLElement = window.HTMLElement
    globalThis.Node = window.Node
    globalThis.Event = window.Event
    globalThis.MouseEvent = window.MouseEvent
    globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true

    const React = (await import(pathToFileURL(path.join(reactDir, 'index.js')).href)).default
    const domClient = await import(pathToFileURL(path.join(domDir, 'client.js')).href)
    const testUtils = await import(pathToFileURL(path.join(domDir, 'test-utils.js')).href)
    const createRoot = domClient.createRoot || domClient.default.createRoot
    const act = testUtils.act || testUtils.default.act
    const { GitfeedPage } = await import(pathToFileURL(bundle).href)

    const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)
    const calls = { railHidden: [], widths: [], feeds: 0, actions: [] }

    // The command surface the page and its panes reach for. Only what they
    // call while a page with no rows is on screen, plus the toggle under test.
    function controller() {
      return {
        get() { return state },
        subscribe() { return function () {} },
        reader: { getSnapshot() { return state }, subscribe() { return function () {} } },
        getList() { return [] },
        reconnect() {},
        mark() { return Promise.resolve() },
        select() {},
        closeArticle() {},
        selectFeed() { calls.feeds += 1 },
        setFilter() {},
        setQuery() {},
        move() {},
        toggleRead() {},
        toggleStar() {},
        openCurrent() {},
        escape() {},
        markAll() {},
        markCounts() { return { results: 0, source: 0, folder: 0, all: 0, folderName: null } },
        markEverything() {},
        undoMark() {},
        dismissToast() {},
        releaseSticky() {},
        trimSticky() {},
        setHold() {},
        heldCount() { return 0 },
        releaseHeld() {},
        countInView() { return 0 },
        markGroup() {},
        markFeed() {},
        markFolder() {},
        setGroupBy() {},
        setHideEmpty() {},
        setMarkOnScroll() {},
        setShowDigest() {},
        setInterestOrder() {},
        digest() { return '' },
        setFolderOpen() {},
        setWidths(patch) { calls.widths.push(patch) },
        setRailHidden(hidden) { calls.railHidden.push(hidden) },
        addFeed() { return Promise.resolve(true) },
        removeFeed() { return Promise.resolve(true) },
        setFeedFolder() { return Promise.resolve(true) },
        runAction(name) { calls.actions.push(name); return Promise.resolve() },
        mount() {},
        unmount() {},
        dispose() {},
        feedTitle(id) { return id },
        feedFolder() { return '' },
        groupKey() { return 'g' },
      }
    }

    const base = {
      status: 'ready', error: null, loadError: null, loadedOnce: true,
      items: [], byId: new Map(), itemsVersion: null,
      fresh: new Set(), read: new Set(), starred: new Set(),
      feeds: [], feedMap: new Map(), ranks: new Map(),
      reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
      git: null, schedule: [], version: null, repo: '/tmp/gitfeed', allowGit: false,
      filter: 'unread', query: '', searchIds: null, feedId: null, current: null,
      groupBy: 'none', hideEmpty: null, markOnScroll: null, showDigest: null,
      interestOrder: null, folderOpen: {}, railW: 220, listW: 430, railHidden: false,
      listEpoch: 1, busy: {}, toast: null,
    }
    let state = base

    const container = window.document.getElementById('root')
    const root = createRoot(container)
    const page = controller()
    const useReader = (selector) => selector(state)
    async function render() {
      await act(async function () {
        root.render(React.createElement(GitfeedPage, { controller: page, t: t, useReader: useReader }))
      })
    }

    await render()
    const shownRail = container.querySelector('.gf-feedrail')
    ok(shownRail !== null, 'the page draws the source list beside the rows')
    ok(container.querySelectorAll('.gf-splitter').length === 1,
      'and one splitter, the rail\'s, with no article open', container.querySelectorAll('.gf-splitter').length)
    // The control is an action like the rail's own, so its label says what
    // pressing it does; there is no separate pressed state to keep in step.
    const toggle = container.querySelector('.gf-toolbar button[aria-label]')
    ok(toggle !== null && toggle.getAttribute('aria-label') === 'action.hideSources',
      'the bar offers to hide the panel', toggle && toggle.getAttribute('aria-label'))
    ok(container.querySelector('.gf-listpane') !== null, 'the rows are drawn next to it')

    // The control collapses the panel: the page is told, not the DOM.
    await act(async function () {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    ok(calls.railHidden.length === 1 && calls.railHidden[0] === true,
      'pressing the toggle asks for the panel to be hidden', calls.railHidden)

    // The state that comes back is the page's, and the rail is simply gone.
    state = Object.assign({}, base, { railHidden: true })
    await render()
    ok(container.querySelector('.gf-feedrail') === null, 'a hidden panel is not rendered at all')
    ok(container.querySelectorAll('.gf-splitter').length === 0,
      'nor is the drag handle that only resizes it', container.querySelectorAll('.gf-splitter').length)
    ok(container.querySelector('.gf-listpane') !== null, 'the rows keep the width it gave up')
    const reopen = container.querySelector('.gf-toolbar button[aria-label]')
    ok(reopen !== null && reopen.getAttribute('aria-label') === 'action.showSources',
      'and the same control now offers to show it', reopen && reopen.getAttribute('aria-label'))

    await act(async function () {
      reopen.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    ok(calls.railHidden.length === 2 && calls.railHidden[1] === false,
      'and brings the panel back', calls.railHidden)

    await act(async function () { root.unmount() })
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

finish()
