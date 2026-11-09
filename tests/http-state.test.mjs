// The /state protocol through the real plugin entry: a payload without rows is
// only valid when it names the item model the caller already holds.
import http from 'node:http'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { makeDataRoot, removeRoot, sampleLibrary } from './fixtures.mjs'
import { finish, lib, nodeTimers, ok } from './harness.mjs'

const { feeds, items } = sampleLibrary(16)
const root = makeDataRoot({ feeds, items })
const timers = nodeTimers()

const routes = []
const disposers = []
const ctx = {
  logger: { info() {}, warn() {}, error(...a) { console.error('log', ...a) } },
  effect(fn) {
    const value = fn()
    if (typeof value === 'function') disposers.push(value)
    return value
  },
  inject() {},
  timeout: timers.timeout,
  webServer: { getOrigin: () => 'http://127.0.0.1:7797', register(route) { routes.push(route); return () => {} } },
}

const plugin = await import('../lib/index.js')
await plugin.apply(ctx, { repo: root, allowGit: false, refreshMinutes: 0, syncMinutes: 0 })

const route = routes[0]
ok(route && route.path === '/gitfeed/api' && route.kind === 'prefix', 'the plugin mounts its API prefix', route && route.path)

// A feed to subscribe to, served by the same server the plugin answers on, so
// discovery and the initial fetch are real HTTP round trips.
function feed(title) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>${title}</title>
  <link>http://127.0.0.1:7797/</link>
  <item>
    <title>${title} item</title>
    <link>http://127.0.0.1:7797/${title}</link>
    <guid>${title}-1</guid>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <description>body</description>
  </item>
</channel></rss>`
}
const FEEDS = { '/feed-a.xml': feed('alpha'), '/feed-b.xml': feed('beta') }

const server = http.createServer((req, res) => {
  const body = FEEDS[req.url]
  if (body !== undefined) {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(body)
    return
  }
  route.handler(req, res)
})
await new Promise((resolve) => server.listen(7797, '127.0.0.1', resolve))

async function post(url, body) {
  const res = await fetch(`http://127.0.0.1:7797${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body: parsed }
}

async function get(url) {
  const res = await fetch(`http://127.0.0.1:7797${url}`, { headers: { 'content-type': 'application/json' } })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body, bytes: Buffer.byteLength(text) }
}

const full = await get('/gitfeed/api/state')
ok(full.status === 200 && Array.isArray(full.body.items), 'GET /state returns the reader plus rows')
ok(typeof full.body.itemsVersion === 'string', 'the payload names the item model')

const known = await get(`/gitfeed/api/state?version=${full.body.version}`)
ok(known.body.unchanged === true && !known.body.items, 'a known state version returns a short payload')

await fetch('http://127.0.0.1:7797/gitfeed/api/mark', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ids: [full.body.items[0].id], read: true }),
})
const marked = await get(`/gitfeed/api/state?version=${full.body.version}&itemsVersion=${full.body.itemsVersion}`)
ok(marked.status === 200, 'GET /state with an itemsVersion answers')
ok(marked.body.itemsUnchanged === true, 'an unchanged item model is flagged')
ok(!marked.body.items, 'an unchanged item model sends no rows')
ok(Array.isArray(marked.body.read) && marked.body.read.length > 0, 'the read set still arrives')
console.log(`     ${(full.bytes / 1e3).toFixed(1)} KB with rows, ${(marked.bytes / 1e3).toFixed(1)} KB without`)
ok(marked.bytes < full.bytes, 'the rowless payload is smaller')

const stale = await get('/gitfeed/api/state?version=nope&itemsVersion=some-older-model')
ok(Array.isArray(stale.body.items), 'a stale item model always gets rows back')

// Two subscribes at once: the subscription list is a read-modify-write, so
// without a queue both reads see the same list and the second write drops the
// first subscription.
const [subA, subB] = await Promise.all([
  post('/gitfeed/api/feeds', { url: 'http://127.0.0.1:7797/feed-a.xml', folder: 'News' }),
  post('/gitfeed/api/feeds', { url: 'http://127.0.0.1:7797/feed-b.xml', folder: 'News' }),
])
const subscribed = JSON.parse(readFileSync(path.join(root, 'feeds.json'), 'utf8')).feeds
const added = subscribed.filter((entry) => /feed-[ab]\.xml$/.test(entry.url))
ok(subA.status === 200 && subB.status === 200, 'two subscribes at once both answer ok', [subA.status, subB.status, subA.body, subB.body])
ok(added.length === 2, 'two subscribes at once both land in the list', added.map((entry) => entry.id))

// A request the caller got wrong is 400, not 500. The status used to be chosen
// by matching the message against a regular expression, so a reworded sentence
// changed the code and any new message answered 500.
const noUrl = await post('/gitfeed/api/feeds', {})
ok(noUrl.status === 400 && /URL is required/.test(noUrl.body.error), 'an add with no URL is the caller\'s error', [noUrl.status, noUrl.body])
const duplicate = await post('/gitfeed/api/feeds', { url: 'http://127.0.0.1:7797/feed-a.xml' })
ok(duplicate.status === 400 && /already subscribed/.test(duplicate.body.error), 'so is a subscription that already exists', [duplicate.status, duplicate.body])
const broken = await fetch('http://127.0.0.1:7797/gitfeed/api/mark', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{not json',
})
ok(broken.status === 400, 'and a body that is not JSON', broken.status)

// The data root: GITFEED_REPO answers before the row's `repo`, which is what
// lets one machine read another checkout without editing the profile.
const { resolveRoot } = await import(lib('host', 'settings.js'))
process.env.GITFEED_REPO = '/tmp/gitfeed-env-root'
ok(resolveRoot('/tmp/gitfeed-row-root') === '/tmp/gitfeed-env-root', 'GITFEED_REPO answers before the row')
delete process.env.GITFEED_REPO
ok(resolveRoot('/tmp/gitfeed-row-root') === '/tmp/gitfeed-row-root', 'without it the row answers')
ok(resolveRoot('') === path.join(os.homedir(), 'gitfeed'), 'with neither, the default is ~/gitfeed', resolveRoot(''))

server.close()
for (const fn of disposers) {
  try { fn() } catch { /* already disposed */ }
}
removeRoot(root)
finish()
