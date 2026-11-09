// The reader's command surface, driven headlessly: the published snapshot, the
// list cache, the retained rows, and the request the transport sends. These are
// the rules the components rely on and the only place the client half had no
// test at all — every fix to it so far was reasoned about, not exercised.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { finish, ok, repoRoot, skip } from './harness.mjs'

const checkout = process.env.DSH_CHECKOUT || path.join(os.homedir(), 'deepseek-harness')
const engine = path.join(checkout, 'packages/client/store/lib/index.js')
const esbuild = [
  path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
  path.join(checkout, 'node_modules', '.bin', 'esbuild'),
].find(existsSync)

if (!existsSync(engine) || esbuild === undefined) {
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

    // One Host, answering /state and recording the marks it receives.
    const host = {
      items: [],
      read: [],
      marks: [],
    }
    const feed = { id: 'f1', title: 'Feed one', folder: 'News', siteUrl: null, url: null, error: null, checkedAt: null }
    function payload() {
      return {
        version: `v${host.items.length}-${host.read.length}`,
        itemsVersion: `m${host.items.length}`,
        items: host.items,
        feeds: [feed],
        read: host.read.slice(),
        starred: [],
        reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
        repo: '/tmp/gitfeed-root',
        allowGit: false,
        git: null,
        schedule: [],
        generatedAt: new Date().toISOString(),
      }
    }
    globalThis.fetch = async function (url, init) {
      const target = String(url)
      const body = init && init.body ? JSON.parse(init.body) : {}
      if (target.indexOf('/state') !== -1) {
        return { ok: true, status: 200, json: async function () { return payload() } }
      }
      if (target.indexOf('/mark') !== -1) {
        host.marks.push({ ids: body.ids, read: body.read })
        if (body.read) for (const id of body.ids) if (host.read.indexOf(id) === -1) host.read.push(id)
        else host.read = host.read.filter((id) => body.ids.indexOf(id) === -1)
        return { ok: true, status: 200, json: async function () { return { ok: true, changed: body.ids.length, version: 'vm' } } }
      }
      return { ok: true, status: 200, json: async function () { return { ok: true } } }
    }

    const { createController, createPrefs } = await import(pathToFileURL(bundle).href)
    const t = function (key, params) { return params ? `${key}:${JSON.stringify(params)}` : key }
    const item = (id, title) => ({
      id: id, feed: 'f1', title: title, link: `https://example.com/${id}`,
      date: new Date().toISOString(), author: '', summary: `<p>${title} body</p>`,
    })
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const ids = (controller) => controller.getList().map((row) => row.id)
    const loaded = async function (controller) {
      await controller.load()
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
