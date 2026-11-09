// The Host answering a text query. A body lives whole only on the Host, so the
// query is answered there and travels back as ids: the case a list that carries
// a digest of a row could never decide.
import { createServer } from 'node:http'
import { appendItem, makeDataRoot, removeRoot } from './fixtures.mjs'
import { finish, lib, nodeTimers, ok } from './harness.mjs'

const { createGitfeed } = await import(lib('host', 'service.js'))
const { createHandler } = await import(lib('host', 'http.js'))

const quiet = { info() {}, warn() {}, error() {} }
const longBody = '<p>' + 'filler sentence. '.repeat(40) + 'a deep tide table lives past the digest</p>'
const root = makeDataRoot({
  feeds: [
    { id: 'feed-a', url: 'https://example.com/a.xml', title: 'Alpha Notes', folder: 'Daily' },
    { id: 'feed-b', url: 'https://example.com/b.xml', title: 'Beta Notes', folder: 'Weekly' },
  ],
  items: [
    {
      id: 'row-long',
      feed: 'feed-a',
      title: 'A long post',
      link: 'https://example.com/long',
      date: '2026-11-02T10:00:00.000Z',
      author: '',
      summary: longBody,
    },
    {
      id: 'row-short',
      feed: 'feed-b',
      title: 'Weather',
      link: 'https://example.com/weather',
      date: '2026-11-01T10:00:00.000Z',
      author: '',
      summary: '<p>about the weather</p>',
    },
  ],
})
const service = createGitfeed({
  root: root,
  logger: quiet,
  timers: nodeTimers(),
  allowGit: false,
  refreshMinutes: 0,
  syncMinutes: 0,
})

try {
  const deep = await service.search('tide table')
  ok(deep.ids.join() === 'row-long', 'a body match past the digest is found', deep.ids)

  const upper = await service.search('  WEATHER ')
  ok(upper.ids.join() === 'row-short', 'the query is trimmed and case-insensitive', upper.ids)

  const source = await service.search('beta notes')
  ok(source.ids.join() === 'row-short', 'a source name is part of the searchable text', source.ids)

  const nothing = await service.search('no such words here')
  ok(nothing.ids.length === 0, 'a query with no match finds nothing', nothing.ids)

  const blank = await service.search('   ')
  ok(blank.ids.length === 0, 'a blank query matches nothing, and asks for nothing')

  // A row that arrives after the Host answered once is searchable at once: the
  // index is keyed on the data root, not on the first answer.
  appendItem(`${root}/.local/items`, {
    id: 'row-new',
    feed: 'feed-b',
    title: 'A fresh row',
    link: 'https://example.com/fresh',
    date: '2026-11-03T10:00:00.000Z',
    author: '',
    summary: '<p>a fresh tide table</p>',
  })
  const afterWrite = await service.search('tide table')
  ok(afterWrite.ids.sort().join() === 'row-long,row-new', 'a newly written row is found without a restart', afterWrite.ids)

  // The route: the same question over the API the surface uses.
  const handler = createHandler(service)
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const response = await fetch(`http://127.0.0.1:${port}/gitfeed/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'weather' }),
  })
  const payload = await response.json()
  ok(response.status === 200 && payload.ids.join() === 'row-short', 'the query is answered over the API route', payload.ids)
  const foreign = await fetch(`http://127.0.0.1:${port}/gitfeed/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify({ query: 'weather' }),
  })
  ok(foreign.status === 403, 'a cross-origin query is refused like every other route', foreign.status)
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
} finally {
  service.dispose()
  removeRoot(root)
}

finish()
