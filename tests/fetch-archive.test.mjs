// What a fetch run still has to read. Two options let the reader hand the run
// what it already knows: the ids the archive holds (`known`) and the fact that
// an unsubscribe already removed its own rows (`pruneOrphans`). Both are about
// not reading twenty-odd megabytes to discover nothing changed.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { appendItem, makeDataRoot, removeRoot } from './fixtures.mjs'
import { finish, lib, ok } from './harness.mjs'

const { runFetch } = await import(lib('host', 'fetch.js'))

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Alpha Notes</title>
  <link>https://example.com/</link>
  <item>
    <title>One post</title>
    <link>https://example.com/one</link>
    <guid>post-1</guid>
    <pubDate>Wed, 05 Nov 2026 10:00:00 GMT</pubDate>
    <description>a body</description>
  </item>
</channel></rss>`

globalThis.fetch = async function () {
  return new Response(FEED, { status: 200, headers: { 'content-type': 'application/xml' } })
}

function rows(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ndjson')) continue
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (line) out.push(JSON.parse(line))
    }
  }
  return out
}

const root = makeDataRoot({
  feeds: [{ id: 'feed-a', url: 'https://example.com/a.xml', title: 'Alpha Notes', folder: 'Daily' }],
})
const items = path.join(root, '.local', 'items')

try {
  // The first run archives the row; it has nothing to compare against yet.
  const first = await runFetch({ root, dataDir: '.local' })
  ok(first.fresh === 1, 'the first run archives the row it found', first.fresh)
  const archived = rows(items)
  ok(archived.length === 1 && archived[0].feed === 'feed-a', 'and writes it to the local cache', archived.length)

  // A caller that holds the merged model passes it instead of letting the run
  // read every shard. The same row must not be archived a second time.
  const known = new Map(archived.map((row) => [row.id, (row.summary || '').length]))
  const again = await runFetch({ root, dataDir: '.local', known })
  ok(again.fresh === 0, 'a run seeded with what it holds finds nothing new', again.fresh)
  ok(rows(items).length === 1, 'and appends no duplicate', rows(items).length)

  // ...and the seeded map is the caller's: a run does not write through it.
  ok(known.size === 1, 'the caller keeps its own map', known.size)

  // An orphan row — a feed that is no longer subscribed — is what the sweep is
  // for. It lives in the store this run writes, which is the one it sweeps. A
  // caller that removed its rows itself turns the sweep off.
  appendItem(items, {
    id: 'orphan-1',
    feed: 'gone',
    title: 'A row from a feed that no longer exists',
    link: 'https://example.com/gone',
    date: '2026-11-01T10:00:00.000Z',
    author: '',
    summary: 'still here',
  })
  await runFetch({ root, dataDir: '.local', known, pruneOrphans: false })
  ok(rows(items).some((row) => row.id === 'orphan-1'),
    'with the sweep off, an orphan row is left alone', rows(items).length)

  // A standalone caller — the CLI, or anyone without a sweep of its own — still
  // gets the archive cleaned up.
  await runFetch({ root, dataDir: '.local' })
  ok(!rows(items).some((row) => row.id === 'orphan-1'),
    'and with it on, the row is swept', rows(items).map((row) => row.id))
} finally {
  removeRoot(root)
}

finish()
