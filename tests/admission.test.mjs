// Admission on the stream route, against both Harness generations the plugin
// can be installed into.
//
// The reader's only state path is this stream. It used to admit a request
// through Connection's `requestRejection`; DSH 0.2.2 moved admission into the
// web server — every route is authenticated before its handler is called — and
// removed that method. Calling it blindly threw before the response's first
// byte, and the reader showed an empty page: no feeds, no rows, no error.
//
// So the route is driven through the real plugin entry, with the Connection
// service shaped the way each generation actually shapes it.
import { createServer } from 'node:http'
import { finish, lib, nodeTimers, ok } from './harness.mjs'
import { makeDataRoot, removeRoot, sampleLibrary } from './fixtures.mjs'

const library = sampleLibrary(2)
const root = makeDataRoot({ feeds: library.feeds, items: library.items })
const timers = nodeTimers()
const quiet = { info() {}, warn() {}, error() {} }

/** What `ctx.get('connection')` answers; the test sets it per case. */
let connection

const routes = []
const disposers = []
const ctx = {
  logger: quiet,
  effect(fn) {
    const value = fn()
    if (typeof value === 'function') disposers.push(value)
    return value
  },
  inject() {},
  get(name) { return name === 'connection' ? connection : undefined },
  timeout: timers.timeout,
  webServer: { getOrigin: () => 'http://127.0.0.1:7797', register(route) { routes.push(route); return () => {} } },
}

const plugin = await import('../lib/index.js')
plugin.apply(ctx, { repo: root, allowGit: false, refreshMinutes: 0, syncMinutes: 0 })

const streamRoute = routes.find(function (route) { return route.path === '/gitfeed/events' })
ok(!!streamRoute && streamRoute.kind === 'exact', 'the plugin registers the stream route', routes.map(function (route) { return route.path }))

const server = createServer(function (req, res) {
  void streamRoute.handler(req, res).catch(function (err) {
    if (res.headersSent) res.destroy()
    else {
      res.writeHead(400)
      res.end(String(err && err.message ? err.message : err))
    }
  })
})
server.on('clientError', function () {})
await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port

const sleep = (ms) => new Promise(function (resolve) { setTimeout(resolve, ms) })
const controller = new AbortController()
process.on('exit', function () { controller.abort() })

/** Open the stream; resolves with the response as the route answered it. */
function open(headers) {
  return fetch(`http://127.0.0.1:${port}/gitfeed/events?rev=0`, {
    headers: Object.assign({ accept: 'text/event-stream' }, headers || {}),
    signal: controller.signal,
  })
}

/** Read from a stream until `needle` appears in the text, or give up. */
async function until(response, needle, ms) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + (ms || 5000)
  try {
    while (!text.includes(needle) && Date.now() < deadline) {
      const step = await reader.read()
      if (step.done) break
      text += decoder.decode(step.value, { stream: true })
    }
  } catch {
    // The test cancels the stream on purpose.
  }
  await reader.cancel().catch(function () { /* already closed */ })
  return text
}

try {
  // --- the Harness this plugin is installed into now: admission upstream ---
  // Exactly the members the running Host reports. There is no
  // `requestRejection` to call, and the route must still serve.
  connection = {
    rpc: {},
    fetch: {},
    browserPeer: { id: 'browser' },
    allowsRemoteAuthorities: false,
    authentication: {},
    admit: function () { return { rejection: 401 } },
    createPeer: function () { return null },
    createSharedFetchHandler: function () { return null },
  }
  const fresh = await open()
  ok(fresh.status === 200, 'a Connection without requestRejection still admits the stream', fresh.status)
  const text = await until(fresh, 'event: welcome')
  ok(text.includes('event: welcome'), 'and the surface gets the state it renders', text.slice(0, 40))
  ok(text.includes('"feeds":[') || text.includes('"items":['), 'with rows and sources in it', text.length)

  const refusedHere = await open({ origin: 'https://elsewhere.example' })
  ok(refusedHere.status === 403, 'while the origin fence still refuses another site', refusedHere.status)
  await refusedHere.body?.cancel().catch(function () { /* no body to drain */ })

  // --- an older Harness: its own check is still the one that runs ---
  connection = { requestRejection: function () { return 401 } }
  const refused = await open()
  ok(refused.status === 401, 'a Harness that carries the old check has it obeyed', refused.status)
  await refused.body?.cancel().catch(function () { /* no body to drain */ })

  connection = {
    requestRejection: function (req) {
      return req.headers.origin === undefined ? undefined : 403
    },
  }
  const allowed = await open()
  ok(allowed.status === 200, 'and its admission of the request is what serves the stream', allowed.status)
  await allowed.body?.cancel().catch(function () { /* no body to drain */ })

  // --- no Connection service at all: the origin fence is the admission ---
  connection = undefined
  const bare = await open()
  ok(bare.status === 200, 'a Harness with no Connection service admits on the fence', bare.status)
  await bare.body?.cancel().catch(function () { /* no body to drain */ })
  const bareCross = await open({ origin: 'https://elsewhere.example' })
  ok(bareCross.status === 403, 'and refuses another origin', bareCross.status)
  await bareCross.body?.cancel().catch(function () { /* no body to drain */ })
} finally {
  controller.abort()
  await sleep(20)
  server.close()
  for (const dispose of disposers) {
    try {
      const value = dispose()
      if (value && typeof value.then === 'function') await value
    } catch {
      // A teardown that failed is not this suite's subject.
    }
  }
  removeRoot(root)
}

finish()
