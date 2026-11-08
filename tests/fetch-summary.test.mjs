// What the fetcher archives for one item's body: whole by default, capped when
// configured, and repaired in place once a feed re-serves a longer copy than
// the archive holds (the migration path after raising or lifting the cap).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { lib, ok, finish } from './harness.mjs'
import { appendItem, makeDataRoot, removeRoot } from './fixtures.mjs'

const { runFetch } = await import(lib('host', 'fetch.js'))

const BODY = '<p>' + 'complete sentence. '.repeat(1200) + '</p>'

function rss(summary) {
  const date = new Date().toUTCString()
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Alpha Notes</title>
  <link>https://example.com/</link>
  <item>
    <title>One post</title>
    <link>https://example.com/one</link>
    <guid>post-1</guid>
    <pubDate>${date}</pubDate>
    <description>${summary.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</description>
  </item>
</channel></rss>`
}

/** Answer every request with one fixed feed body. */
function stubFetch(body) {
  const calls = []
  globalThis.fetch = async function (url) {
    calls.push(String(url))
    return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } })
  }
  return calls
}

function shardFile(root) {
  const rows = []
  const dir = path.join(root, 'data', 'items')
  const name = `${new Date().toISOString().slice(0, 7)}.ndjson`
  return { file: path.join(dir, name), rows }
}

function readRows(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function root(extra = {}) {
  return makeDataRoot({
    feeds: [{ id: 'feed-a', url: 'https://example.com/a.xml', title: 'Alpha Notes' }],
    ...extra,
  })
}

// 1. No cap by default: the whole body lands in the archive.
{
  const dir = root()
  stubFetch(rss(BODY))
  const result = await runFetch({ root: dir })
  const rows = readRows(shardFile(dir).file)
  const item = rows.find((row) => row.id !== undefined)
  ok(result.fresh === 1, 'a new item is archived', result.summary)
  ok(item && item.summary.length > 20000, 'the body is stored whole by default', item && item.summary.length)
  removeRoot(dir)
}

// 2. A configured cap still applies.
{
  const dir = root()
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ fetch: { maxSummaryChars: 500 } }) + '\n')
  stubFetch(rss(BODY))
  await runFetch({ root: dir })
  const item = readRows(shardFile(dir).file).find((row) => row.id !== undefined)
  ok(item && item.summary.length === 500, 'fetch.maxSummaryChars still caps the body', item && item.summary.length)
  removeRoot(dir)
}

// 3. A feed re-serving a longer body repairs the archived copy in place.
{
  const dir = root()
  const file = shardFile(dir).file
  // The id the fetcher derives for guid `post-1`, with a body cut short the way
  // an older 2500-character cap left it.
  const { createHash } = await import('node:crypto')
  const id = createHash('sha1').update('feed-a|post-1').digest('hex').slice(0, 16)
  appendItem(path.join(dir, 'data', 'items'), {
    id: id,
    feed: 'feed-a',
    title: 'One post',
    link: 'https://example.com/one',
    date: new Date().toISOString(),
    summary: '<p>cut short</p>',
  })
  stubFetch(rss(BODY))
  const first = await runFetch({ root: dir })
  const repaired = readRows(file).find((row) => row.id === id)
  ok(first.fresh === 0, 'the known item is not added twice', first.summary)
  ok(first.repaired === 1, 'the fetch reports the repaired item', first.repaired)
  ok(repaired && repaired.summary.length > 20000, 'the archived body is replaced by the longer one', repaired && repaired.summary.length)

  const second = await runFetch({ root: dir })
  ok(second.repaired === 0, 'a second pass has nothing left to repair', second.repaired)
  ok(readRows(file).length === 1, 'repairing rewrites rather than appends', readRows(file).length)
  removeRoot(dir)
}

// 4. A row the committed archive already holds is not new again.
// The refresh writes the cache, but the reader merges `data/` first: a dedupe
// that only knew the cache treated the whole committed archive as missing and
// re-appended it to `.local/items` on every run.
{
  const dir = root()
  stubFetch(rss('<p>plain body</p>'))
  const first = await runFetch({ root: dir, dataDir: '.local' })
  ok(first.fresh === 1, 'a first refresh lands its row in the cache', first.summary)
  const month = new Date().toISOString().slice(0, 7)
  const cached = path.join(dir, '.local', 'items', `${month}.ndjson`)
  const row = readRows(cached)[0]
  // Promote that row into the committed archive, the way a CLI run would.
  mkdirSync(path.join(dir, 'data', 'items'), { recursive: true })
  writeFileSync(path.join(dir, 'data', 'items', `${month}.ndjson`), `${JSON.stringify(row)}\n`)
  rmSync(cached)

  const second = await runFetch({ root: dir, dataDir: '.local' })
  ok(second.fresh === 0, 'a row the committed archive holds is not new again', second.summary)
  ok(!existsSync(cached), 'the cache keeps no second copy of it')
  removeRoot(dir)
}

// 5. A feed that answers 304 has recovered, so the old failure goes with it.
{
  const dir = root()
  const metaFile = path.join(dir, 'data', 'meta.json')
  writeFileSync(metaFile, `${JSON.stringify({
    'feed-a': {
      url: 'https://example.com/a.xml',
      etag: 'v1',
      lastError: 'HTTP 500',
      checkedAt: '2026-01-01T00:00:00.000Z',
    },
  }, null, 2)}\n`)
  globalThis.fetch = async function () { return new Response(null, { status: 304 }) }
  const result = await runFetch({ root: dir })
  const after304 = JSON.parse(readFileSync(metaFile, 'utf8'))['feed-a']
  ok(result.unchanged === 1, 'a 304 counts as unchanged', result.summary)
  ok(after304.lastError === null, 'a 304 clears the failure it recovers from', after304)
  ok(after304.etag === 'v1', 'the validators survive the 304', after304)
  removeRoot(dir)
}

// 6. A disabled feed is still subscribed: it is fetched by nobody and its
// archive must not be mistaken for orphans of a deleted subscription.
{
  const dir = makeDataRoot({
    feeds: [
      { id: 'feed-a', url: 'https://example.com/a.xml', title: 'Alpha Notes' },
      { id: 'feed-b', url: 'https://example.com/b.xml', title: 'Beta Notes', disabled: true },
    ],
  })
  const keptDate = new Date().toISOString()
  appendItem(path.join(dir, 'data', 'items'), {
    id: 'kept-b',
    feed: 'feed-b',
    title: 'Kept',
    link: 'https://example.com/b/kept',
    date: keptDate,
    author: '',
    summary: '<p>body</p>',
  })
  const calls = stubFetch(rss('<p>plain body</p>'))
  const result = await runFetch({ root: dir })
  const kept = readRows(path.join(dir, 'data', 'items', `${keptDate.slice(0, 7)}.ndjson`)).map((row) => row.id)
  ok(result.feeds === 1, 'a disabled feed is not fetched', result.feeds)
  ok(calls.length === 1, 'only the runnable feed is asked for', calls)
  ok(kept.includes('kept-b'), 'a disabled feed keeps the rows it already has', kept)
  removeRoot(dir)
}

finish()
