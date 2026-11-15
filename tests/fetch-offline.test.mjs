// A period without a connection: what a run tells apart, and what it leaves
// alone. A run that reached nothing is the network, not the subscriptions, so
// it does not write a feed error and does not judge the feeds; a run that
// reached some feeds judged the ones it missed.
//
// Loads the built Host half, so it asserts the shipped rule, not the source.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { lib, finish, ok } from './harness.mjs'
import { makeDataRoot, removeRoot } from './fixtures.mjs'

const { runFetch } = await import(lib('host', 'fetch.js'))

const FEEDS = [
  { id: 'feed-a', url: 'https://example.com/a.xml', title: 'Alpha' },
  { id: 'feed-b', url: 'https://example.com/b.xml', title: 'Beta' },
  { id: 'feed-c', url: 'https://example.com/c.xml', title: 'Gamma' },
]

const RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Alpha</title><link>https://example.com/</link>
<item><title>One</title><link>https://example.com/1</link><guid>post-1</guid>
<pubDate>${new Date().toUTCString()}</pubDate><description>body</description></item>
</channel></rss>`

/** Answer each url according to `plan`: a status code, `offline`, or the feed. */
function stubFetch(plan) {
  globalThis.fetch = async function (url) {
    const mode = plan[String(url)]
    if (mode === 'offline') throw new TypeError('fetch failed')
    if (typeof mode === 'number') return new Response('nope', { status: mode })
    return new Response(RSS, { status: 200, headers: { 'content-type': 'application/xml' } })
  }
}

function meta(root) {
  return JSON.parse(readFileSync(path.join(root, 'data', 'meta.json'), 'utf8'))
}

function root() {
  return makeDataRoot({ feeds: FEEDS })
}

// 1. Every feed missed: the run is the network, and no feed is marked broken.
{
  const dir = root()
  stubFetch({ 'https://example.com/a.xml': 'offline', 'https://example.com/b.xml': 'offline', 'https://example.com/c.xml': 'offline' })
  const result = await runFetch({ root: dir })
  ok(result.offline === true, 'a run that reached no feed is an outage', result.summary)
  ok(result.unreachable === 3 && result.failed === 3, 'every feed counts as unreachable')
  ok(result.code === 1, 'the fetcher still exits non-zero for the CLI and the tool')
  const written = meta(dir)
  ok(FEEDS.every((feed) => !written[feed.id].lastError), 'no feed is marked broken by an outage')
  ok(result.summary.includes('no feed reachable'), 'the summary says what happened', result.summary)
  removeRoot(dir)
}

// 2. Some feeds answered: the ones that missed are judged.
{
  const dir = root()
  stubFetch({ 'https://example.com/b.xml': 'offline' })
  const result = await runFetch({ root: dir })
  ok(result.offline === false, 'a run that reached some feeds is not an outage', result.summary)
  ok(result.unreachable === 1 && result.failed === 1, 'only the missed feed counts as unreachable')
  const written = meta(dir)
  ok(written['feed-b'].lastError === 'fetch failed', 'the missed feed carries its error')
  ok(!written['feed-a'].lastError && !written['feed-c'].lastError, 'the feeds that answered are clean')
  ok(written['feed-a'].status === 200, 'and keep their response facts')
  removeRoot(dir)
}

// 3. Below the fleet floor the run is a broken feed, not an outage: two dead
//    subscriptions are two dead subscriptions.
{
  const dir = makeDataRoot({ feeds: FEEDS.slice(0, 2) })
  stubFetch({ 'https://example.com/a.xml': 'offline', 'https://example.com/b.xml': 'offline' })
  const result = await runFetch({ root: dir })
  ok(result.offline === false, 'two missed feeds are not an outage', result.summary)
  ok(meta(dir)['feed-a'].lastError === 'fetch failed', 'and both keep their error')
  removeRoot(dir)
}

// 4. An HTTP answer is a broken feed even when every feed fails: the network
//    was there, so the sources are what is wrong.
{
  const dir = root()
  stubFetch({ 'https://example.com/a.xml': 500, 'https://example.com/b.xml': 500, 'https://example.com/c.xml': 500 })
  const result = await runFetch({ root: dir })
  ok(result.offline === false, 'all feeds answering HTTP 500 is not an outage', result.summary)
  ok(result.unreachable === 0 && result.failed === 3, 'HTTP failures are reaching the network')
  ok(meta(dir)['feed-a'].lastError === 'HTTP 500', 'the feed carries the server error')
  removeRoot(dir)
}

// 5. An outage does not clear an error that was already there: it did not
//    judge the feed, so it has nothing new to say about it.
{
  const dir = root()
  const seeded = meta(dir)
  seeded['feed-a'] = { url: 'https://example.com/a.xml', title: 'Alpha', lastError: 'HTTP 404', checkedAt: '2026-01-01T00:00:00.000Z' }
  writeFileSync(path.join(dir, 'data', 'meta.json'), JSON.stringify(seeded))
  stubFetch({ 'https://example.com/a.xml': 'offline', 'https://example.com/b.xml': 'offline', 'https://example.com/c.xml': 'offline' })
  const result = await runFetch({ root: dir })
  ok(result.offline === true, 'the run is an outage')
  ok(meta(dir)['feed-a'].lastError === 'HTTP 404', 'the earlier error survives the outage')
  removeRoot(dir)
}

finish('fetch-offline')
