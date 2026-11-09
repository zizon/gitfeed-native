// The event stream route: the frames a surface receives, the admission it is
// held to, and the pause a slow surface imposes on the pull. The handler is
// driven over a real HTTP listener where the transport matters, and over a fake
// response where the callback is what the test wants to control.
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

/**
 * A frame source the test pushes into: the handler pulls whatever is queued,
 * exactly as it pulls from the live state.
 */
function frameSource(initial) {
  const queued = []
  let waiting = null
  let closed = false
  let settled = 0
  const wake = function () {
    if (!waiting) return
    const resolve = waiting
    waiting = null
    resolve()
  }
  return {
    push(frame) {
      queued.push(frame)
      wake()
    },
    close() {
      closed = true
      wake()
    },
    get stopped() { return settled },
    async *frames(rev, signal) {
      try {
        for (const frame of initial || []) yield frame
        while (!closed && !signal.aborted) {
          if (queued.length === 0) {
            await new Promise(function (resolve) {
              waiting = resolve
              signal.addEventListener('abort', resolve, { once: true })
            })
            continue
          }
          yield queued.shift()
        }
      } finally {
        settled += 1
      }
    },
  }
}

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

function fakeRequest() {
  return { method: 'GET', url: '/gitfeed/events?rev=0', headers: {}, setTimeout() {}, on() {} }
}

/**
 * A response whose `write` callback the test releases: holding it is what a
 * surface that is not reading looks like to the handler.
 */
function fakeResponse() {
  const listeners = new Map()
  const state = { written: [], held: null, heldWrite: null, ended: false }
  const res = {
    writeHead() {},
    write(text, callback) {
      state.written.push(text)
      if (!state.held) {
        if (callback) callback()
        return true
      }
      state.heldWrite = callback
      return false
    },
    end() { state.ended = true },
    on(event, listener) {
      const list = listeners.get(event) || []
      list.push(listener)
      listeners.set(event, list)
      return res
    },
    emit(event) { for (const listener of listeners.get(event) || []) listener() },
  }
  return {
    res: res,
    state: state,
    hold() { state.held = true },
    release() {
      state.held = false
      const callback = state.heldWrite
      state.heldWrite = null
      if (callback) callback()
    },
  }
}

// --- frames arrive in order, from the revision the surface asked ---
{
  const source = frameSource([welcome])
  const handler = createEventsHandler(source, function () { return undefined })
  const listener = await listen(handler)
  const controller = new AbortController()
  const res = await fetch(`http://127.0.0.1:${listener.port}/gitfeed/events?rev=3`, { signal: controller.signal })
  ok(res.status === 200, 'the stream answers 200', res.status)
  ok(res.headers.get('content-type').startsWith('text/event-stream'), 'as an event stream', res.headers.get('content-type'))

  const stream = streamReader(res)
  const first = await stream.until('event: welcome')
  ok(first.includes('event: welcome'), 'the whole state arrives as a welcome event', first.slice(0, 60))
  ok(first.includes('"rev":4') && first.includes('"id":"a"'), 'with the rows and the revision in the payload', first.slice(0, 120))

  source.push(delta)
  const rest = await stream.until('event: delta')
  ok(rest.includes('event: delta') && rest.includes('"rev":5'), 'a later change arrives as a delta', rest.slice(0, 80))

  await stream.stop()
  controller.abort()
  await sleep(50)
  ok(source.stopped === 1, 'closing the response stops the pull', source.stopped)
  await listener.close()
}

// --- a surface that is not reading pauses the pull ---
// The handler awaits each write, so a response that accepts a chunk but never
// reports it complete keeps the next frame from even being asked for.
{
  const source = frameSource([welcome])
  const handler = createEventsHandler(source, function () { return undefined })
  const { res, state, hold, release } = fakeResponse()
  const done = handler(fakeRequest(), res)
  await sleep(10)
  ok(state.written.length === 2, 'the retry hint and the first frame are written', state.written.length)

  hold()
  source.push(delta)
  source.push(Object.assign({}, delta, { rev: 6, version: 'v6' }))
  await sleep(20)
  ok(state.written.length === 3, 'a chunk the response did not accept stops the next frame', state.written.length)

  release()
  await sleep(20)
  ok(state.written.length === 4, 'and releasing it lets the pull continue', state.written.length)

  release()
  await sleep(20)
  ok(state.written.length === 4, 'with nothing else queued the pull waits', state.written.length)

  source.close()
  await done
  ok(state.ended === true, 'and the response ends when the source does', state.ended)
}

// --- the first frame is the whole archive, and a large one must arrive ---
{
  const body = 'x'.repeat(6 * 1024 * 1024)
  const large = Object.assign({}, welcome, {
    items: [{ id: 'big-1', feed: 'feed-a', title: 'A long body', link: '', date: '2026-11-01T10:00:00.000Z', author: '', summary: body }],
  })
  const controller = new AbortController()
  const listener = await listen(createEventsHandler(frameSource([large]), function () { return undefined }))
  const res = await fetch(`http://127.0.0.1:${listener.port}/gitfeed/events?rev=0`, { signal: controller.signal })
  const stream = streamReader(res)
  const text = await stream.until('"big-1"', 8000)
  ok(text.includes('event: welcome') && text.includes('"big-1"'), 'a frame larger than a socket buffer arrives whole', text.length)
  await stream.stop()
  controller.abort()
  await sleep(20)
  await listener.close()
}

// --- admission: a refused surface never receives frames ---
{
  let pulled = 0
  const source = {
    frames() {
      pulled += 1
      return (async function* () { yield welcome })()
    },
  }
  const handler = createEventsHandler(source, function () { return 401 })
  const listener = await listen(handler)
  const res = await fetch(`http://127.0.0.1:${listener.port}/gitfeed/events`)
  ok(res.status === 401, 'a refused request is answered with its status', res.status)
  ok(pulled === 0, 'and the reader is not asked for frames', pulled)
  await res.text().catch(function () {})
  await listener.close()
}

// --- a reader that cannot open its data root hears why ---
{
  const controller = new AbortController()
  const source = {
    frames() {
      return (async function* () {
        yield { t: 'error', protocol: 1, message: 'gitfeed: no feeds.json' }
      })()
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
