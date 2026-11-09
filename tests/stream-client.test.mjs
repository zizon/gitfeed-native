// The reader over its stream: a welcome lands the whole state, a delta lands
// what changed, and nothing is asked over HTTP while the stream is up. The
// EventSource is a stub the test drives, which is what lets the frames arrive
// on demand instead of from a Host.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { esbuildBin, finish, ok, repoRoot, skip, storeEngine } from './harness.mjs'

const engine = storeEngine()
const esbuild = esbuildBin()

if (engine === undefined || esbuild === undefined) {
  skip('the reader over its stream', 'no DSH checkout with the shared store engine')
} else {
  const out = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-stream-client-'))
  const entry = path.join(out, 'entry.ts')
  const bundle = path.join(out, 'controller.mjs')
  try {
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

    // The stream the reader opens, driven by the test.
    class FakeEventSource {
      constructor(url) {
        this.url = url
        this.closed = false
        this.listeners = new Map()
        FakeEventSource.instances.push(this)
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
    FakeEventSource.instances = []
    globalThis.EventSource = FakeEventSource

    // The HTTP path, counted: while the stream is up it must not be used.
    const http = { states: 0, marks: [], stars: [] }
    globalThis.fetch = async function (url, init) {
      const target = String(url)
      const body = init && init.body ? JSON.parse(init.body) : {}
      if (target.indexOf('/state') !== -1) {
        http.states += 1
        return { ok: true, status: 200, json: async function () { return { version: 'http', itemsVersion: 'http', items: [], feeds: [], read: [], starred: [], reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' }, repo: '/tmp/root', allowGit: false, git: null, schedule: [] } } }
      }
      if (target.indexOf('/mark') !== -1) {
        http.marks.push({ ids: body.ids, read: body.read })
        return { ok: true, status: 200, json: async function () { return { ok: true } } }
      }
      if (target.indexOf('/star') !== -1) {
        http.stars.push({ ids: body.ids, star: body.star })
        return { ok: true, status: 200, json: async function () { return { ok: true } } }
      }
      return { ok: true, status: 200, json: async function () { return { ok: true } } }
    }

    const { createController, createPrefs } = await import(pathToFileURL(bundle).href)
    const t = function (key, params) { return params ? `${key}:${JSON.stringify(params)}` : key }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const ids = (controller) => controller.getList().map((row) => row.id)
    const item = (id, date, title) => ({
      id: id,
      feed: 'f1',
      title: title || `Row ${id}`,
      link: `https://example.com/${id}`,
      date: date,
      author: '',
      summary: `<p>${id} body</p>`,
    })
    const feed = { id: 'f1', title: 'Feed one', folder: 'News', siteUrl: null, url: null, error: null, checkedAt: null }
    const reader = { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' }
    const welcome = (rev, items, read, starred) => ({
      t: 'welcome', protocol: 1, rev: rev, version: `v${rev}`, itemsVersion: `m${rev}`,
      items: items, read: read || [], starred: starred || [], feeds: [feed], reader: reader,
      git: null, schedule: [], repo: '/tmp/gitfeed-root', allowGit: false,
    })
    const delta = (rev, patch) => Object.assign({ t: 'delta', protocol: 1, rev: rev, version: `v${rev}`, itemsVersion: `m${rev}` }, patch)

    // --- mount opens one stream and asks the Host for nothing ---
    const controller = createController(t, createPrefs())
    controller.mount()
    await sleep(0)
    ok(FakeEventSource.instances.length === 1, 'mount opens one stream', FakeEventSource.instances.length)
    ok(FakeEventSource.instances[0].url === '/gitfeed/events?rev=0', 'at the revision it holds', FakeEventSource.instances[0].url)
    ok(http.states === 0, 'and does not fall back to HTTP while the stream opens', http.states)

    // --- the welcome is the whole state ---
    const stream = FakeEventSource.instances[0]
    stream.fire('open')
    stream.fire('welcome', welcome(7, [
      item('a', '2026-11-03T10:00:00.000Z'),
      item('b', '2026-11-02T10:00:00.000Z'),
      item('c', '2026-11-01T10:00:00.000Z'),
    ]))
    await sleep(0)
    ok(ids(controller).join() === 'a,b,c', 'the welcome lands its rows in archive order', ids(controller))
    ok(controller.get().loadedOnce === true && controller.get().status === 'ready', 'and the reader is ready', controller.get().status)
    ok(controller.get().version === 'v7', 'holding the revision the Host named', controller.get().version)
    ok(http.states === 0, 'without a single HTTP state request', http.states)

    // --- a delta lands what changed ---
    stream.fire('delta', delta(8, { items: { added: [item('d', '2026-11-04T10:00:00.000Z')], updated: [], removed: [] } }))
    await sleep(0)
    ok(ids(controller).join() === 'd,a,b,c', 'an arriving row lands by its date', ids(controller))
    ok(controller.get().version === 'v8', 'and the revision moves with it', controller.get().version)
    ok(ids(controller).length === 4, 'the other rows are still there', ids(controller).length)

    // The same frame twice is the same state: revisions are a cursor.
    stream.fire('delta', delta(8, { items: { added: [item('d', '2026-11-04T10:00:00.000Z')], updated: [], removed: [] } }))
    await sleep(0)
    ok(ids(controller).length === 4, 'a repeated revision changes nothing', ids(controller).length)

    // An old revision is dropped, not replayed.
    stream.fire('delta', delta(6, { items: { added: [item('z', '2026-11-05T10:00:00.000Z')], updated: [], removed: [] } }))
    await sleep(0)
    ok(!ids(controller).includes('z'), 'a frame older than the surface is ignored', ids(controller))

    // --- a mark from another surface is a frame of ids ---
    stream.fire('delta', delta(9, { read: { add: ['b'], remove: [] } }))
    await sleep(0)
    ok(!ids(controller).includes('b'), 'a row read elsewhere leaves the unread list', ids(controller))
    ok(controller.countInView() === 3, 'and the count follows it', controller.countInView())

    // --- a removal leaves the list and the star ---
    stream.fire('delta', delta(10, { items: { added: [], updated: [], removed: ['a'] }, starred: { add: [], remove: ['a'] } }))
    await sleep(0)
    ok(!ids(controller).includes('a'), 'a removed row is gone', ids(controller))

    // --- a star from another surface follows ---
    stream.fire('delta', delta(11, { starred: { add: ['c'], remove: [] } }))
    await sleep(0)
    ok(controller.get().starred.has('c'), 'a star made elsewhere is held', [...controller.get().starred])
    controller.setFilter('starred')
    ok(ids(controller).join() === 'c', 'and the Starred view lists it', ids(controller))
    controller.setFilter('unread')

    // --- a row that arrives under the reader is held, exactly as over HTTP ---
    const still = createController(t, createPrefs())
    still.mount()
    const stillStream = FakeEventSource.instances[FakeEventSource.instances.length - 1]
    stillStream.fire('open')
    stillStream.fire('welcome', welcome(3, [
      item('r1', '2026-11-03T10:00:00.000Z'),
      item('r2', '2026-11-02T10:00:00.000Z'),
      item('r3', '2026-11-01T10:00:00.000Z'),
    ]))
    await sleep(0)
    still.setScrolled(true)
    stillStream.fire('delta', delta(4, { items: { added: [item('r4', '2026-11-02T12:00:00.000Z')], updated: [], removed: [] } }))
    await sleep(0)
    ok(!ids(still).includes('r4'), 'a row that arrives under the reader is held back', ids(still))
    ok(still.getList().length === 3, 'and the rows being read do not move', still.getList().length)
    ok(still.countInView() === 4, 'the header still counts it', still.countInView())
    still.setScrolled(false)
    still.releaseHeld()
    ok(ids(still).includes('r4'), 'at the top the held row lands', ids(still))

    // --- the surface going closes the stream ---
    still.unmount()
    await sleep(0)
    ok(stillStream.closed === true, 'unmounting closes the stream', stillStream.closed)

    // A stream error is reported and the HTTP path takes over.
    const errors = []
    const originalToast = controller.get().toast
    stream.fire('error', JSON.stringify({ t: 'error', protocol: 1, message: 'gitfeed: no feeds.json' }))
    await sleep(0)
    const toast = controller.get().toast
    ok(!!toast && toast.error === true && toast.text.includes('no feeds.json'), 'a stream error reaches the reader', toast && toast.text)
    ok(controller.get().toast !== originalToast, 'and is not the banner that was there', originalToast)

    // A transport failure is not hidden behind a second path any more: the
    // reader keeps what it holds, and says the Host cannot be reached.
    const heldRows = ids(controller).length
    stream.fire('error', undefined)
    await sleep(0)
    ok(http.states === 0, 'a failed stream does not fall back to an HTTP state request', http.states)
    ok(ids(controller).length === heldRows, 'and the rows it already holds stay', ids(controller).length)

    // A Host with no stream at all is not hammered: after a few failures the
    // stream is given up for a while and the reader says why.
    stream.fire('error', undefined)
    stream.fire('error', undefined)
    await sleep(0)
    ok(stream.closed === true, 'the stream is given up after a few failures', stream.closed)
    ok(controller.get().toast !== null && controller.get().toast.error === true,
      'and the reader is told, rather than left with a stale list', controller.get().toast)

    // A surface that never received a frame says so on the empty pane.
    const blank = createController(t, createPrefs())
    blank.mount()
    const blankStream = FakeEventSource.instances[FakeEventSource.instances.length - 1]
    blankStream.fire('error', undefined)
    blankStream.fire('error', undefined)
    blankStream.fire('error', undefined)
    await sleep(0)
    ok(blank.get().status === 'error' && String(blank.get().error).includes('offline'),
      'a surface with no state reports the Host is unreachable', blank.get().status)
    blank.dispose()

    controller.dispose()
    still.dispose()
    await sleep(0)
    ok(stream.closed === true, 'dispose closes the stream too', stream.closed)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

finish()
