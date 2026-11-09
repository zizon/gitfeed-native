// The event stream route: the frames a surface receives, the admission it is
// held to, and the detach that runs when the surface goes. The handler is
// driven over a real HTTP listener, because the thing under test is a held-open
// response, not a request/response shape a mock would reproduce.
import { createServer } from 'node:http'
import { finish, lib, ok } from './harness.mjs'

const { createEventsHandler } = await import(lib('host', 'events.js'))

// A held-open response keeps its socket, so a hung assertion would hang the
// whole run. The watchdog turns that into a failure.
const watchdog = setTimeout(function () {
  console.log('FAIL the stream suite did not finish')
  process.exit(1)
}, 20000)
watchdog.unref()

const welcome = {
  t: 'welcome',
  protocol: 1,
  rev: 4,
  version: 'v4',
  itemsVersion: 'm4',
  items: [{ id: 'a', feed: 'feed-a', title: 'Row a', link: '', date: '2026-11-01T10:00:00.000Z', author: '', summary: '' }],
  read: [],
  starred: [],
  feeds: [],
  reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
  git: null,
  schedule: [],
  repo: '/tmp/gitfeed-root',
  allowGit: false,
}
const delta = {
  t: 'delta',
  protocol: 1,
  rev: 5,
  version: 'v5',
  itemsVersion: 'm5',
  read: { add: ['a'], remove: [] },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One listener with one handler; answers the port and a close that cannot hang. */
async function listen(handler) {
  const server = createServer((req, res) => { void handler(req, res) })
  server.on('clientError', () => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** One reader over a live response, accumulating text as the frames arrive. */
function streamReader(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let done = false
  void (async function pump() {
    try {
      while (!done) {
        const step = await reader.read()
        if (step.done) break
        text += decoder.decode(step.value, { stream: true })
      }
    } catch {
      // The test ends the stream on purpose; a cancelled read is not a failure.
    }
  })()
  return {
    text: function () { return text },
    /** Wait until the accumulated text carries `needle`. */
    async until(needle, ms) {
      const deadline = Date.now() + (ms || 3000)
      while (!text.includes(needle) && Date.now() < deadline) await sleep(10)
      return text
    },
    async stop() {
      done = true
      try {
        await reader.cancel()
      } catch {
        // already closed
      }
    },
  }
}

// --- the frames carry the revision the surface asked from ---
{
  const senders = []
  let detached = 0
  const source = {
    attach: async function (rev, send) {
      senders.push({ rev: rev, send: send })
      send(welcome)
      return function () { detached += 1 }
    },
  }
  const handler = createEventsHandler(source, function () { return undefined })
  const listener = await listen(handler)
  const controller = new AbortController()
  const res = await fetch(`http://127.0.0.1:${listener.port}/gitfeed/events?rev=3`, { signal: controller.signal })
  ok(res.status === 200, 'the stream answers 200', res.status)
  ok(res.headers.get('content-type').startsWith('text/event-stream'), 'as an event stream', res.headers.get('content-type'))
  ok(senders.length === 1 && senders[0].rev === 3, 'the revision in the query is the one it attaches at', senders.map((entry) => entry.rev))

  const stream = streamReader(res)
  const first = await stream.until('event: welcome')
  ok(first.includes('event: welcome'), 'the whole state arrives as a welcome event', first.slice(0, 60))
  ok(first.includes('"rev":4') && first.includes('"id":"a"'), 'with the rows and the revision in the payload', first.slice(0, 120))

  senders[0].send(delta)
  const rest = await stream.until('event: delta')
  ok(rest.includes('event: delta') && rest.includes('"rev":5'), 'a later change arrives as a delta', rest.slice(0, 80))

  await stream.stop()
  controller.abort()
  await sleep(50)
  ok(detached === 1, 'aborting the request detaches the surface', detached)
  await listener.close()
}

// --- admission: a refused surface never receives frames ---
{
  let attached = 0
  const source = {
    attach: async function () {
      attached += 1
      return function () {}
    },
  }
  const handler = createEventsHandler(source, function () { return 401 })
  const listener = await listen(handler)
  const res = await fetch(`http://127.0.0.1:${listener.port}/gitfeed/events`)
  ok(res.status === 401, 'a refused request is answered with its status', res.status)
  ok(attached === 0, 'and nothing is attached for it', attached)
  await res.text().catch(function () {})
  await listener.close()
}

// --- the first frame is the whole archive, and a large one must arrive ---
// A backpressure guard that fires right after writing a big frame drops the
// connection on the very first load: the frame is queued, not stalled, and the
// surface sees a broken stream instead of its state.
{
  const body = 'x'.repeat(6 * 1024 * 1024)
  const large = {
    t: 'welcome',
    protocol: 1,
    rev: 1,
    version: 'v1',
    itemsVersion: 'm1',
    items: [{ id: 'big-1', feed: 'feed-a', title: 'A long body', link: '', date: '2026-11-01T10:00:00.000Z', author: '', summary: body }],
    read: [],
    starred: [],
    feeds: [],
    reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
    git: null,
    schedule: [],
    repo: '/tmp/gitfeed-root',
    allowGit: false,
  }
  const controller = new AbortController()
  const source = {
    attach: async function (rev, send) {
      send(large)
      return function () {}
    },
  }
  const handler = createEventsHandler(source, function () { return undefined })
  const listener = await listen(handler)
  const res = await fetch(`http://127.0.0.1:${listener.port}/gitfeed/events?rev=0`, { signal: controller.signal })
  const stream = streamReader(res)
  const text = await stream.until('"big-1"', 8000)
  ok(text.includes('event: welcome') && text.includes('"big-1"'), 'a frame larger than a socket buffer arrives whole', text.length)
  await stream.stop()
  controller.abort()
  await sleep(20)
  await listener.close()
}

// --- a reader that cannot open its data root hears why ---
{
  const controller = new AbortController()
  const source = {
    attach: async function (rev, send) {
      send({ t: 'error', protocol: 1, message: 'gitfeed: no feeds.json' })
      return function () {}
    },
  }
  const handler = createEventsHandler(source, function () { return undefined })
  const listener = await listen(handler)
  const res = await fetch(`http://127.0.0.1:${listener.port}/gitfeed/events`, { signal: controller.signal })
  const stream = streamReader(res)
  const text = await stream.until('event: error')
  ok(text.includes('event: error') && text.includes('no feeds.json'), 'a failure is a frame, not a dropped connection', text.slice(0, 120))
  await stream.stop()
  controller.abort()
  await sleep(20)
  await listener.close()
}

clearTimeout(watchdog)
finish()
