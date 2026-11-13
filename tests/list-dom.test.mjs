// The visible window as the DOM sees it: mount the real ItemList against a
// stand-in controller and drive the transitions the review called out — a
// refresh arriving at the top, a rebuild above a live viewport, and a batch of
// read rows released under the reader. The pure rules are in window.test.mjs;
// this is the part that only exists in the component's effects, and it is where
// the flash and the jump lived.
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

if (esbuild === undefined || !existsSync(reactDir) || !existsSync(domDir) || !existsSync(jsdomEntry)) {
  skip('the visible window in a DOM', 'no react-dom and jsdom to render the component with')
} else {
  const out = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-list-dom-'))
  const stub = path.join(out, 'primitives.mjs')
  const bundle = path.join(out, 'list.mjs')
  try {
    // The bundle stays external to React, and the modules are linked where it
    // can resolve them: two copies of React in one page is a hook error, not a
    // render.
    mkdirSync(path.join(out, 'node_modules'), { recursive: true })
    symlinkSync(reactDir, path.join(out, 'node_modules', 'react'), 'dir')
    symlinkSync(domDir, path.join(out, 'node_modules', 'react-dom'), 'dir')
    // The atom set is the shell's: for the list under test it is a control
    // shape and a few glyphs, which is all the stub has to be.
    writeFileSync(stub, [
      "import * as React from 'react'",
      "const button = (props) => React.createElement('button', {",
      "  type: 'button', className: props.className, disabled: props.disabled,",
      "  title: props.title, 'aria-label': props['aria-label'], onClick: props.onClick,",
      "}, props.children)",
      "export const Button = button",
      "export const MenuItemButton = button",
      "export const Menu = (props) => props.open",
      "  ? React.createElement('div', { className: props.className }, props.children)",
      "  : (props.anchor || null)",
      "export const MenuSurface = (props) => React.createElement('div', { className: props.className }, props.children)",
      "export const Tooltip = (props) => React.createElement(React.Fragment, null, props.children)",
      "const glyph = (name) => () => React.createElement('svg', { 'data-glyph': name })",
      "export const IconChevronDownOutlineRegular = glyph('down')",
      "export const IconChevronRightOutlineRegular = glyph('right')",
      "export const IconPlusOutlineRegular = glyph('plus')",
      '',
    ].join('\n'))

    execFileSync(esbuild, [
      path.join(repoRoot, 'src', 'client', 'components', 'ItemList.tsx'),
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
    // Node's own navigator is a getter on the global; React only reads the DOM.
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
    const { ItemList } = await import(pathToFileURL(bundle).href)

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)
    const ROW = 66

    // One controller stand-in: it owns the facts the list reads, applies what
    // the list asks for the way the transport would, and records the rest.
    function fixture(n) {
      const db = {
        items: Array.from({ length: n }, (_, i) => ({
          id: `r${i}`, feed: 'f1', title: `r${i}`, link: `https://example.com/r${i}`,
          date: new Date(Date.UTC(2026, 10, 13, 12, 0, 0) - i * 60000).toISOString(),
          author: '', summary: `<p>r${i}</p>`,
        })),
        read: new Set(),
        sticky: new Set(),
        held: new Set(),
        fresh: new Set(),
        hold: false,
        marked: [],
        trimmed: [],
      }
      // The controller caches the list by what it is made of, like the real
      // one: an unchanged render must hand the component the same array, or
      // every render would look like a rebuild to it.
      let cachedKey = null
      let cachedList = []
      const controller = {
        getList() {
          const key = db.items.length + '|' + db.items.map(function (item) { return item.id }).join(',')
            + '|' + [...db.read].sort().join(',')
            + '|' + [...db.sticky].sort().join(',')
            + '|' + [...db.held].sort().join(',')
          if (key !== cachedKey) {
            cachedKey = key
            cachedList = db.items.filter(function (item) {
              if (db.held.has(item.id)) return false
              if (db.read.has(item.id) && !db.sticky.has(item.id)) return false
              return true
            })
          }
          return cachedList
        },
        heldCount() { return db.held.size },
        releaseHeld() {
          if (!db.held.size) return false
          db.held.clear()
          return true
        },
        setHold(value) { db.hold = value },
        releaseSticky(ids) { for (const id of ids) db.sticky.delete(id) },
        trimSticky(ids) {
          for (const id of ids) db.sticky.delete(id)
          db.trimmed.push(...ids)
        },
        mark(ids, value, keep) {
          db.marked.push({ ids, value, keep })
          for (const id of ids) {
            if (value) {
              db.read.add(id)
              if (keep) db.sticky.add(id)
            } else {
              db.read.delete(id)
              db.sticky.delete(id)
            }
          }
        },
        select(id) { db.selected = id },
        toggleStar() {},
        markGroup() {},
        removeFeed() {},
        setFeedFolder() {},
        markCounts() { return { results: 0, source: 0, folder: 0, all: 0, folderName: null } },
        countInView() {
          return db.items.filter(function (item) {
            return !db.read.has(item.id) && !db.held.has(item.id)
          }).length
        },
        digest() { return '' },
        feedTitle(id) { return id },
        feedFolder() { return 'Uncategorized' },
      }
      function state() {
        const byId = new Map(db.items.map(function (item) { return [item.id, item] }))
        return {
          status: 'ready', error: null, loadError: null, loadedOnce: true,
          items: db.items, byId: byId, itemsVersion: 'm1',
          fresh: new Set(db.fresh), read: new Set(db.read), starred: new Set(),
          feeds: [], feedMap: new Map(),
          reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
          git: null, schedule: [], version: 'v1', repo: '/tmp/gitfeed', allowGit: false,
          filter: 'unread', query: '', searchIds: null, feedId: null, current: null,
          groupBy: 'none', hideEmpty: null, markOnScroll: null, showDigest: true,
          folderOpen: {}, railW: 220, listW: 430, listEpoch: 1, busy: {}, toast: null,
        }
      }
      return { db, controller, state }
    }

    let root = null
    let container = null
    async function mount(env) {
      container = window.document.getElementById('root')
      root = createRoot(container)
      await act(async function () {
        root.render(React.createElement(ItemList, { state: env.state(), controller: env.controller, t: t, wide: false }))
      })
      return scroller()
    }
    async function render(env) {
      await act(async function () {
        root.render(React.createElement(ItemList, { state: env.state(), controller: env.controller, t: t, wide: false }))
      })
    }
    function scroller() { return container.querySelector('.gf-scroll') }
    function titles() {
      return [...container.querySelectorAll('.gf-row .t')].map(function (node) { return node.textContent })
    }
    function scrollTo(top) {
      const el = scroller()
      el.scrollTop = top
      el.dispatchEvent(new window.Event('scroll'))
    }
    /** Let the rAF pass the scroll scheduled run, and React apply what it says. */
    async function settle(env) {
      await act(async function () { await sleep(30) })
      await render(env)
      await act(async function () { await sleep(30) })
    }

    // --- the first paint starts at the top of the list ---
    const first = fixture(100)
    await mount(first)
    ok(titles()[0] === 'r0', 'the list mounts at its first row', titles().slice(0, 3))
    ok(scroller().scrollTop === 0, 'at the top of the scroll', scroller().scrollTop)
    ok(first.db.hold === true, 'and it tells the transport a list is on screen', first.db.hold)

    // --- an arrival at the top is held, counted, and offered ---
    first.db.items.unshift({
      id: 'new0', feed: 'f1', title: 'new0', link: 'https://example.com/new0',
      date: new Date(Date.UTC(2026, 10, 13, 13, 0, 0)).toISOString(), author: '', summary: '<p>new0</p>',
    })
    first.db.held.add('new0')
    await render(first)
    ok(!titles().includes('new0'), 'a row that arrives at the top is not inserted under the reader', titles().slice(0, 3))
    ok(titles()[0] === 'r0', 'the row being read stays where it was', titles()[0])
    ok(container.querySelector('.gf-newitems') !== null, 'the bar offers the row that is waiting')
    ok(container.querySelector('.gf-newitems').textContent.includes('list.newItems'), 'and says how many', container.querySelector('.gf-newitems').textContent)

    await act(async function () {
      container.querySelector('.gf-newitems').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    first.db.fresh.add('new0')
    await render(first)
    ok(titles()[0] === 'new0', 'asking for it lands it at the top', titles().slice(0, 3))
    ok(container.querySelector('.gf-newitems') === null, 'and the offer goes away', container.querySelector('.gf-newitems'))
    ok(container.querySelector('.gf-row .t').closest('.gf-row').className.includes('gf-row-in'),
      'the released row fades in where it belongs')
    await act(async function () { root.unmount() })
    container.replaceChildren()

    // --- a rebuild above the viewport keeps the row under its edge ---
    const edge = fixture(100)
    await mount(edge)
    scrollTo(700)
    await settle(edge)
    const before = titles()
    ok(before.includes('r10'), 'the band covers the row under the scroll offset', before.slice(0, 4))
    // Three rows arrive above the reader and land (they were released, or the
    // list was rebuilt by a mark): every row below them shifts down by their
    // height, and the scroll offset has to carry that.
    edge.db.items.unshift(
      { id: 'a', feed: 'f1', title: 'a', link: '', date: '2026-11-13T13:00:00.000Z', author: '', summary: '' },
      { id: 'b', feed: 'f1', title: 'b', link: '', date: '2026-11-13T12:59:00.000Z', author: '', summary: '' },
      { id: 'c', feed: 'f1', title: 'c', link: '', date: '2026-11-13T12:58:00.000Z', author: '', summary: '' },
    )
    await render(edge)
    ok(scroller().scrollTop === 700 + 3 * ROW, 'the rebuild pays for the three rows above in scroll offset', scroller().scrollTop)
    ok(titles().includes('r10'), 'so the row under the edge is still mounted', titles().slice(0, 4))
    await act(async function () { root.unmount() })
    container.replaceChildren()

    // --- a batch of retained rows released above the edge does not move it ---
    // The reader scrolled past rows that were read and kept; the band trim
    // releases them in one batch. That both shrinks the list above the
    // viewport and replaces every entry under it, which is the rebuild that
    // used to paint one stale frame and then jump.
    const trim = fixture(100)
    await mount(trim)
    for (let i = 0; i < 27; i++) {
      trim.db.read.add(`r${i}`)
      trim.db.sticky.add(`r${i}`)
    }
    await render(trim)
    scrollTo(2100)
    await settle(trim)
    ok(trim.db.trimmed.length === 27, 'a batch of rows above the band is released', trim.db.trimmed.length)
    const kept = titles()
    ok(kept.includes('r31'), 'the band is on the row under the edge', kept.slice(0, 5))
    // The trim already applied to the list the transport holds; the next render
    // is the one that draws without those rows.
    await render(trim)
    await act(async function () { await sleep(30) })
    ok(scroller().scrollTop === 2100 - 27 * ROW, 'the scroll offset gives back the released height', scroller().scrollTop)
    ok(titles().includes('r31'), 'and the row under the edge is still the same row', titles().slice(0, 5))
    const el = scroller()
    const row31 = el.querySelectorAll('.gf-row')[titles().indexOf('r31')]
    ok(row31 !== undefined, 'the row the reader was on is mounted after the rebuild')
    await act(async function () { root.unmount() })
    container.replaceChildren()

    // --- an empty list holds nothing back ---
    // The list that empties is the case that matters: the flag that says a
    // surface has a position must be cleared when the viewport goes away, or an
    // arrival would wait behind a state that is no longer showing rows.
    const empty = fixture(3)
    await mount(empty)
    ok(empty.db.hold === true, 'a list with rows asks to be held still', empty.db.hold)
    for (const item of empty.db.items) empty.db.read.add(item.id)
    await render(empty)
    ok(container.querySelector('.gf-scroll') === null, 'the empty view has no list on screen', container.querySelector('.gf-scroll'))
    ok(empty.db.hold === false, 'so a list with no rows protects nothing', empty.db.hold)
    await act(async function () { root.unmount() })
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

finish()
