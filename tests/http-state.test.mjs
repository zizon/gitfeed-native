// The /state protocol through the real plugin entry: a payload without rows is
// only valid when it names the item model the caller already holds.
import http from 'node:http'
import { makeDataRoot, removeRoot, sampleLibrary } from './fixtures.mjs'
import { finish, nodeTimers, ok } from './harness.mjs'

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

const server = http.createServer((req, res) => route.handler(req, res))
await new Promise((resolve) => server.listen(7797, '127.0.0.1', resolve))

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

server.close()
for (const fn of disposers) {
  try { fn() } catch { /* already disposed */ }
}
removeRoot(root)
finish()
