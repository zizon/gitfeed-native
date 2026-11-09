// The stream, end to end against the real service: a subscription to the
// events route, the welcome it receives, and the deltas a mark and a landed
// refresh produce. This is the one suite where the Host half, the live copy,
// and the route run together instead of each being driven by a double.
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { finish, lib, nodeTimers, ok } from './harness.mjs'
import { appendItem, makeDataRoot, removeRoot, sampleLibrary } from './fixtures.mjs'

const { createGitfeed } = await import(lib('host', 'service.js'))
const { createEventsHandler } = await import(lib('host', 'events.js'))

const watchdog = setTimeout(function () {
  console.log('FAIL the end-to-end stream suite did not finish')
  process.exit(1)
}, 20000)
watchdog.unref()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quiet = { info() {}, warn() {}, error() {} }

const library = sampleLibrary(2)
const root = makeDataRoot({ feeds: library.feeds, items: library.items })
const service = createGitfeed({
  root: root,
  logger: quiet,
  timers: nodeTimers(),
  refreshMinutes: 0,
  syncMinutes: 0,
  allowGit: false,
})

/** Read a live response, accumulating frames until `needle` appears in the text. */
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
      // The test closes the stream on purpose.
    }
  })()
  return {
    text: function () { return text },
    async until(needle, ms) {
      const deadline = Date.now() + (ms || 5000)
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

/** Every `data:` payload in the text for one event name. */
function framesOf(text, name) {
  const out = []
  const pattern = new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`, 'g')
  let match
  while ((match = pattern.exec(text)) !== null) out.push(JSON.parse(match[1]))
  return out
}

const server = createServer((req, res) => { void createEventsHandler(service, function () { return undefined })(req, res) })
server.on('clientError', () => {})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const controller = new AbortController()

try {
  const res = await fetch(`http://127.0.0.1:${port}/gitfeed/events?rev=0`, { signal: controller.signal })
  ok(res.status === 200, 'the route serves the stream', res.status)
  const stream = streamReader(res)

  const text = await stream.until('event: welcome')
  const welcomes = framesOf(text, 'welcome')
  ok(welcomes.length === 1, 'a surface with no revision gets one welcome', welcomes.length)
  const welcome = welcomes[0]
  ok(welcome.t === 'welcome' && welcome.protocol === 1, 'on the protocol this bundle speaks', welcome && welcome.protocol)
  ok(welcome.items.length === 4, 'with the whole archive', welcome.items.length)
  ok(welcome.items.every((row) => row.summary), 'including the row bodies the article view reads', welcome.items.length)
  ok(welcome.rev > 0, 'and a revision to continue from', welcome.rev)

  // A mark this process makes is one frame of ids, not a rebuilt archive.
  const id = welcome.items[0].id
  await service.mark([id], true)
  const marked = await stream.until(`"rev":${welcome.rev + 1}`)
  const deltas = framesOf(marked, 'delta')
  ok(deltas.length === 1, 'a mark produces one delta', deltas.length)
  ok(deltas[0].read && deltas[0].read.add.includes(id), 'naming the row it marked', deltas[0] && deltas[0].read)
  ok(deltas[0].items === undefined, 'and carrying no rows', deltas[0] && deltas[0].items)

  // A fetch that lands rows is one delta of those rows.
  appendItem(path.join(root, '.local', 'items'), {
    id: 'new-row',
    feed: 'feed-a',
    title: 'A fetched row',
    link: 'https://example.com/new',
    date: '2027-01-05T10:00:00.000Z',
    author: '',
    summary: '<p>fetched</p>',
  })
  await service.refresh({ force: true })
  const landed = await stream.until('new-row')
  const landedDeltas = framesOf(landed, 'delta')
  const arrival = landedDeltas.find(function (frame) { return frame.items && frame.items.added.length })
  ok(arrival && arrival.items.added.length === 1, 'a refresh that lands a row announces it once', arrival && arrival.items.added.length)
  ok(arrival && arrival.items.added[0].id === 'new-row', 'naming the row it landed', arrival && arrival.items.added[0].id)
  ok(arrival.items.removed.length === 0 && arrival.items.updated.length === 0, 'and reporting no phantom changes', arrival.items)

  // A second surface that holds the first revision is caught up from the
  // history instead of being sent the whole archive again.
  const caught = await fetch(`http://127.0.0.1:${port}/gitfeed/events?rev=${welcome.rev}`, { signal: controller.signal })
  const caughtStream = streamReader(caught)
  const caughtText = await caughtStream.until('"new-row"')
  ok(!caughtText.includes('event: welcome'), 'a surface holding a revision is not sent the whole state again', caughtText.slice(0, 40))
  ok(framesOf(caughtText, 'delta').length >= 2, 'it receives the deltas it missed, in order', framesOf(caughtText, 'delta').length)
  await caughtStream.stop()
  await stream.stop()
} finally {
  controller.abort()
  await sleep(20)
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  service.dispose()
  removeRoot(root)
  clearTimeout(watchdog)
}

finish()
