// The reader's command surface, driven headlessly: the published snapshot, the
// list cache, the retained rows, and the request the transport sends. These are
// the rules the components rely on and the only place the client half had no
// test at all — every fix to it so far was reasoned about, not exercised.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { esbuildBin, finish, ok, repoRoot, skip, storeEngine } from './harness.mjs'

const engine = storeEngine()
const esbuild = esbuildBin()

if (engine === undefined || esbuild === undefined) {
  skip('the client state layer', 'no DSH checkout with the shared store engine')
} else {
  const out = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-controller-'))
  const entry = path.join(out, 'entry.ts')
  const bundle = path.join(out, 'controller.mjs')
  try {
    // One bundle for the three modules under test, so they share one engine.
    writeFileSync(entry, [
      `export { createController } from ${JSON.stringify(path.join(repoRoot, 'src/client/controller.ts'))}`,
      `export { createPrefs } from ${JSON.stringify(path.join(repoRoot, 'src/client/prefs.ts'))}`,
      '',
    ].join('\n'))
    execFileSync(esbuild, [
      entry,
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--alias:@deepseek-ai/dsh-client-store=${engine}`,
      `--outfile=${bundle}`,
      '--log-level=warning',
    ])

    // The browser pieces the client half touches, reduced to what it reads.
    const storage = new Map()
    globalThis.localStorage = {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: (key) => { storage.delete(key) },
    }
    globalThis.DOMParser = class {
      parseFromString(html) {
        return { body: { textContent: String(html).replace(/<[^>]*>/g, ' ') } }
      }
    }
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    }

    // The stream the reader opens, driven by the test: the only path its state
    // arrives on now.
    class FakeEventSource {
      constructor(url) {
        this.url = url
        this.closed = false
        this.listeners = new Map()
      }
      addEventListener(name, listener) {
        const list = this.listeners.get(name) || []
        list.push(listener)
        this.listeners.set(name, list)
      }
      close() { this.closed = true }
      fire(name, data) {
        const event = { data: data === undefined ? undefined : (typeof data === 'string' ? data : JSON.stringify(data)) }
        for (const listener of this.listeners.get(name) || []) listener(event)
      }
    }
    let lastSource = null
    globalThis.EventSource = class extends FakeEventSource {
      constructor(url) {
        super(url)
        lastSource = this
      }
    }

    // One Host: it records the commands it receives, and the test tells its
    // surfaces what changed.
    const host = {
      items: [],
      read: [],
      starred: [],
      marks: [],
      stars: [],
      queries: [],
      searchSignals: [],
    }
    const feed = { id: 'f1', title: 'Feed one', folder: 'News', siteUrl: null, url: null, error: null, checkedAt: null }
    globalThis.fetch = async function (url, init) {
      const target = String(url)
      const body = init && init.body ? JSON.parse(init.body) : {}
      if (target.indexOf('/search') !== -1) {
        host.queries.push(body.query)
        host.searchSignals.push(init && init.signal)
        const needle = String(body.query || '').trim().toLowerCase()
        const ids = host.items
          .filter((row) => `${row.title} ${String(row.summary).replace(/<[^>]*>/g, ' ')}`.toLowerCase().includes(needle))
          .map((row) => row.id)
        return { ok: true, status: 200, json: async function () { return { ok: true, ids } } }
      }
      if (target.indexOf('/mark') !== -1) {
        host.marks.push({ ids: body.ids, read: body.read })
        if (body.read) for (const id of body.ids) if (host.read.indexOf(id) === -1) host.read.push(id)
        else host.read = host.read.filter((id) => body.ids.indexOf(id) === -1)
        return { ok: true, status: 200, json: async function () { return { ok: true, changed: body.ids.length } } }
      }
      if (target.indexOf('/star') !== -1) {
        host.stars.push({ ids: body.ids, star: body.star })
        for (const id of body.ids) {
          if (body.star) { if (host.starred.indexOf(id) === -1) host.starred.push(id) }
          else host.starred = host.starred.filter((kept) => kept !== id)
        }
        return { ok: true, status: 200, json: async function () { return { ok: true, changed: body.ids.length } } }
      }
      return { ok: true, status: 200, json: async function () { return { ok: true } } }
    }

    const { createController: createReader, createPrefs } = await import(pathToFileURL(bundle).href)
    const t = function (key, params) { return params ? `${key}:${JSON.stringify(params)}` : key }
    const item = (id, title) => ({
      id: id, feed: 'f1', title: title, link: `https://example.com/${id}`,
      date: new Date().toISOString(), author: '', summary: `<p>${title} body</p>`,
    })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const ids = (controller) => controller.getList().map((row) => row.id)
    /** Every surface the test opened, and the stream it opened it on. */
    const streams = new Map()
    function createController(t, prefs) {
      const controller = createReader(t, prefs)
      controller.mount()
      streams.set(controller, lastSource)
      return controller
    }
    // The whole state, as the Host would announce it to a surface that holds
    // no revision it can extend.
    function welcome() {
      return {
        t: 'welcome',
        protocol: 1,
        rev: Date.now(),
        version: `v${host.items.length}-${host.read.length}`,
        itemsVersion: `m${host.items.length}`,
        items: host.items,
        feeds: [feed],
        read: host.read.slice(),
        starred: host.starred.slice(),
        reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
        repo: '/tmp/gitfeed-root',
        allowGit: false,
        git: null,
        schedule: [],
      }
    }
    const loaded = async function (controller) {
      const source = streams.get(controller)
      source.fire('open')
      source.fire('welcome', welcome())
      await sleep(0)
      return controller
    }

    // --- a stored pane width is not narrowed on the way in ---
    storage.set('gitfeed.prefs', JSON.stringify({
      groupBy: null, hideEmpty: null, markOnScroll: null, showDigest: null,
      folderOpen: {}, railW: 220, listW: 900,
    }))
    const wide = createController(t, createPrefs())
    ok(wide.get().listW === 900, 'a stored width comes back as it was stored', wide.get().listW)
    wide.setWidths({ listW: 5000 })
    ok(wide.get().listW === 900, 'and a wider request is clamped to the range the constant names', wide.get().listW)
    wide.setWidths({ listW: 100 })
    ok(wide.get().listW === 260 && wide.get().railW === 220, 'as is a narrower one, without touching the other pane', wide.get().listW)
    wide.dispose()
    storage.clear()

    // --- retained rows, the band trim, and the two scope changes ---
    const controller = createController(t, createPrefs())
    host.items = [item('a', 'Alpha'), item('b', 'Beta')]
    host.read = []
    await loaded(controller)
    ok(ids(controller).join(',') === 'a,b', 'the list is the loaded rows', ids(controller))

    // A row marked by scrolling is retained, and a rebuild does not drop it.
    controller.mark(['a'], true, true)
    host.read = ['a']
    host.items = [item('c', 'Gamma'), item('a', 'Alpha'), item('b', 'Beta')]
    await loaded(controller)
    ok(ids(controller).includes('a'), 'a retained row survives a rebuild', ids(controller))
    controller.trimSticky(['a'])
    ok(!ids(controller).includes('a'), 'and the band trim lets it go', ids(controller))

    // Escape is a scope change: it clears what the old scope was holding.
    controller.setQuery('beta')
    await sleep(0)
    ok(ids(controller).join(',') === 'b', 'a search narrows the list', ids(controller))
    controller.mark(['b'], true, true)
    host.read = ['a', 'b']
    ok(ids(controller).includes('b'), 'a retained row stays listed under the search', ids(controller))
    controller.escape()
    ok(!ids(controller).includes('b'), 'Escape lets the retained rows go with the query', ids(controller))

    // Opening an article retains its row; marking it unread puts it back.
    host.items = [item('e', 'Epsilon')].concat(host.items)
    await loaded(controller)
    controller.select('e')
    ok(ids(controller).includes('e'), 'opening an article keeps its row listed', ids(controller))
    controller.toggleRead()
    ok(ids(controller).includes('e'), 'marking it unread keeps it listed', ids(controller))
    controller.toggleRead()
    host.read = host.read.concat(['e'])
    host.items = [item('f', 'Zeta')].concat(host.items)
    await loaded(controller)
    ok(ids(controller).includes('e'), 'marking it read again retains it across a rebuild', ids(controller))

    // --- starring a row without opening it ---
    // The list is the only surface with the archive in front of it, so its star
    // acts on the row it sits on rather than on whatever article is open.
    host.items = [item('s1', 'Star one'), item('s2', 'Star two')]
    host.read = []
    host.starred = []
    const starring = createController(t, createPrefs())
    await loaded(starring)
    ok(starring.get().current === null, 'no article is open when a row is starred')
    starring.toggleStar('s2')
    ok(starring.get().starred.has('s2'), 'the row is starred at once', [...starring.get().starred])
    await sleep(20)
    ok(host.stars.length && host.stars.at(-1).ids.join() === 's2' && host.stars.at(-1).star === true,
      'and the Host is asked for that row', host.stars)
    ok(host.marks.filter((mark) => mark.ids.includes('s2')).length === 0, 'starring a row does not mark it read')
    starring.setFilter('starred')
    ok(ids(starring).join(',') === 's2', 'the Starred filter lists it', ids(starring))
    starring.toggleStar('s2')
    ok(!ids(starring).includes('s2'), 'unstarring it in the Starred view drops the row at once', ids(starring))
    ok(starring.get().starred.size === 0, 'and the mark is gone', [...starring.get().starred])
    starring.dispose()

    // --- a refresh that lands under the reader moves no rows ---
    // A fetch brings rows older than the newest ones on screen, so they land
    // inside the band being read: inserting them there pushed every row below
    // them down, and the fade meant to soften that read as the page blinking.
    host.items = [item('r1', 'Row one'), item('r2', 'Row two'), item('r3', 'Row three')]
    host.read = []
    host.starred = []
    const still = createController(t, createPrefs())
    await loaded(still)
    ok(still.getList().length === 3, 'the list starts with the archive as loaded', still.getList().length)

    // The reader is scrolled into the list when the refresh lands.
    still.setScrolled(true)
    const added = item('r4', 'Row four')
    host.items = [host.items[0], host.items[1], added, host.items[2]]
    await loaded(still)
    ok(!ids(still).includes('r4'), 'a row that arrived under the reader is held back', ids(still))
    ok(still.getList().length === 3, 'and the rows being read do not move', still.getList().length)
    ok(still.countInView() === 4, 'the header still counts it as something to read', still.countInView())

    // Coming back to the top is where new rows belong.
    still.setScrolled(false)
    still.releaseHeld()
    ok(ids(still).includes('r4'), 'at the top the held row lands', ids(still))
    ok(still.getList().length === 4, 'and the list is whole again', still.getList().length)

    // A scope change is the other way out: the reader moved the list themselves.
    still.setScrolled(true)
    host.items = [item('r5', 'Row five')].concat(host.items)
    await loaded(still)
    ok(!ids(still).includes('r5'), 'another arrival is held while reading', ids(still))
    still.setQuery('row')
    await sleep(0)
    ok(ids(still).includes('r5'), 'a search lets the held row go with the old scope', ids(still))
    still.escape()

    // With nothing scrolled, a refresh lands as it always did.
    const arriving = createController(t, createPrefs())
    host.items = [item('n1', 'New one')]
    host.read = []
    await loaded(arriving)
    host.items = [item('n2', 'New two')].concat(host.items)
    await loaded(arriving)
    ok(ids(arriving).join(',') === 'n2,n1', 'an unread arrival at the top is listed at once', ids(arriving))
    arriving.dispose()
    still.dispose()

    // --- marking while scrolling does not reload the list under the pointer ---
    // Every mark used to be followed by a full /state load, which rebuilt the
    // rows, the count, and the digest text several times a second: the list
    // that flashed while it was being read.
    host.items = [item('m1', 'Mark one'), item('m2', 'Mark two')]
    host.read = []
    host.starred = []
    const marker = createController(t, createPrefs())
    await loaded(marker)
    const rowsBefore = marker.getList().length
    ok(rowsBefore === 2, 'the list starts with both rows', rowsBefore)
    marker.mark(['m1'], true, true)
    await sleep(500)
    ok(host.marks.some((mark) => mark.ids.includes('m1')), 'the mark reaches the Host', host.marks)
    ok(marker.getList().length === rowsBefore, 'and the rows the reader was on stay as they were', marker.getList().length)
    marker.dispose()

    // --- a query the reader replaced is cancelled, not just ignored ---
    // The Host's index build is the expensive part; a query nobody waits for
    // should stop where it is.
    host.queries = []
    host.searchSignals = []
    const searching = createController(t, createPrefs())
    host.items = [item('q1', 'Tides one')]
    host.read = []
    await loaded(searching)
    searching.setQuery('tides')
    searching.setQuery('one')
    await sleep(20)
    ok(host.searchSignals.length >= 2, 'both queries reached the Host', host.searchSignals.length)
    ok(host.searchSignals[0].aborted === true, 'and the replaced one was aborted', host.searchSignals.map((signal) => signal.aborted))
    ok(ids(searching).join(',') === 'q1', 'the newest answer is the one applied', ids(searching))
    searching.dispose()

    // --- a mark resolves when the Host has it ---
    const marking = createController(t, createPrefs())
    host.items = [item('k1', 'K one')]
    host.read = []
    await loaded(marking)
    await marking.mark(['k1'], true, true)
    ok(host.marks.some((mark) => mark.ids.includes('k1')), 'a settled mark promise means the Host has it', host.marks.length)
    marking.dispose()

    // --- a 200 that says ok:false is a failure, decided in one place ---
    // A fetch that ran and failed answers `ok: false` under a 200: an answer,
    // not a status. The transport is where that becomes a rejection; three
    // commands used to re-check the field, and the fourth check sat two lines
    // above the catch that already handled the same failure.
    const originalFetch = globalThis.fetch
    globalThis.fetch = async function (url) {
      const target = String(url)
      if (target.indexOf('/feeds') !== -1) {
        return { ok: true, status: 200, json: async function () { return { ok: false, error: 'no feed at that URL' } } }
      }
      return { ok: true, status: 200, json: async function () { return { ok: false, output: 'two feeds failed' } } }
    }
    const refusing = createController(t, createPrefs())
    host.items = []
    host.read = []
    await loaded(refusing)
    const refusedAdd = await refusing.addFeed('https://example.com/none', 'News')
    ok(refusedAdd === false, 'a refused add answers false for the form', refusedAdd)
    ok(!!refusing.get().toast && refusing.get().toast.error === true && refusing.get().toast.text.includes('no feed at that URL'),
      'and the reason the Host gave is the one shown', refusing.get().toast)
    await refusing.runAction('fetch')
    ok(!!refusing.get().toast && refusing.get().toast.error === true && refusing.get().toast.text.includes('two feeds failed'),
      'a failed fetch is reported once, through the same path', refusing.get().toast)
    refusing.dispose()
    globalThis.fetch = originalFetch

    // --- a queued mark is sent before the surface goes ---
    const before = host.marks.length
    controller.mark(['d'], true, true)
    controller.dispose()
    await sleep(20)
    ok(host.marks.length > before, 'a mark queued at dispose time still reaches the Host', host.marks.length - before)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

finish()
