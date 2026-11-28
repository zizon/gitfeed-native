// Reading a URL as a document: one request, one classifier, three kinds of
// answer. Both readers of a URL sit on this layer — `resolveFeed` turns an
// add-time URL (feed or site) into a subscription, and the poller reads a known
// feed conditionally — so what the classifier calls a feed is the same question
// for both. The case that motivates it: an HTML page may legally contain a
// `<channel>` element, which a scanning test reads as a feed.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { makeDataRoot, removeRoot } from './fixtures.mjs'
import { finish, lib, ok } from './harness.mjs'

const { classifyDocument, readDocument } = await import(lib('host', 'document.js'))
const { resolveFeed } = await import(lib('host', 'feeds.js'))
const { runFetch } = await import(lib('host', 'fetch.js'))

const feed = function (title) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel>
  <title>${title}</title>
  <link>https://example.com/</link>
  <item>
    <title>One post</title>
    <link>https://example.com/one</link>
    <guid>post-1</guid>
    <pubDate>Wed, 05 Nov 2026 10:00:00 GMT</pubDate>
    <description>a body</description>
  </item>
</channel></rss>`
}

// --- the classifier ---
ok(classifyDocument('application/rss+xml', feed('Classified')) === 'feed',
  'a feed whose body opens with rss is a feed')
ok(classifyDocument(null, '\uFEFF<?xml version="1.0"?><!-- generated --><rss version="2.0"></rss>') === 'feed',
  'the BOM, the prolog, and a leading comment are skipped before the question is asked')
ok(classifyDocument('application/xhtml+xml', '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><channel>not a feed</channel></body></html>') === 'page',
  'an HTML page that happens to contain a channel element is a page, not a feed')
ok(classifyDocument('text/html', '<html><body><channel></channel></body></html>') === 'page',
  'and so is a page without a doctype, because the body opens with html')
ok(classifyDocument('application/json', '{"error":"bad gateway"}') === 'other',
  'a body that is neither leaves the question open')
ok(classifyDocument('application/rss+xml', 'not markup at all') === 'feed',
  'and then the content-type answers: a feed served without markup is still a feed')
ok(classifyDocument(null, '<rss-feed>') === 'other',
  'a tag that merely starts with rss is not one')

// --- one request, one shape ---
const routes = {
  '/feed': { type: 'application/rss+xml', body: feed('Shared'), etag: '"v1"' },
  '/page': {
    type: 'text/html',
    body: '<!DOCTYPE html><html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body></body></html>',
  },
  '/page-empty': { type: 'text/html', body: '<!DOCTYPE html><html><body>no feed here</body></html>' },
  '/html-as-feed': { type: 'text/html', body: '<!DOCTYPE html><html><body>not a feed</body></html>' },
  '/loop': {
    type: 'text/html',
    body: '<html><head><link rel="alternate" type="application/rss+xml" href="/loop"></head></html>',
  },
}
const server = http.createServer(function (req, res) {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/feed' })
    res.end()
    return
  }
  if (req.url === '/missing') {
    res.writeHead(500)
    res.end('boom')
    return
  }
  const route = routes[req.url]
  if (!route) {
    res.writeHead(404)
    res.end()
    return
  }
  const headers = { 'content-type': route.type }
  if (route.etag) headers.etag = route.etag
  const conditional = req.headers['if-none-match']
  if (route.etag && conditional === route.etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  res.writeHead(200, headers)
  res.end(route.body)
})
await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}`
const read = function (url, headers) {
  return readDocument(url, { headers: headers || {}, signal: AbortSignal.timeout(5000) })
}

const doc = await read(`${origin}/feed`)
ok(doc.status === 200 && doc.body.includes('<rss') && doc.finalUrl === `${origin}/feed`,
  'readDocument returns the body and where it came from', [doc.status, doc.finalUrl])
const redirected = await read(`${origin}/redirect`)
ok(redirected.finalUrl === `${origin}/feed`, 'and a redirect reports the URL it landed on', redirected.finalUrl)
const unchanged = await read(`${origin}/feed`, { 'if-none-match': '"v1"' })
ok(unchanged.status === 304 && unchanged.body === '',
  'a 304 is a response the caller judges, not an exception', [unchanged.status, unchanged.body])

// --- the add-time resolver on top of it ---
const resolved = await resolveFeed(`${origin}/page`)
ok(resolved.url === `${origin}/feed` && resolved.title === 'Shared' && resolved.items === 1,
  'a site URL resolves to the feed it links, with its title and count', resolved)
const direct = await resolveFeed(`${origin}/feed`)
ok(direct.url === `${origin}/feed` && direct.items === 1, 'and a feed URL resolves to itself', direct)

const failure = async function (url) {
  try {
    await resolveFeed(url)
  } catch (err) {
    return String((err && err.message) || err)
  }
  return ''
}
ok(/no RSS\/Atom feed found/.test(await failure(`${origin}/page-empty`)),
  'a page with no feed link is refused with the message the form shows')
ok(await failure(`${origin}/missing`) === 'HTTP 500', 'an HTTP failure keeps its status', await failure(`${origin}/missing`))
ok(await failure(`${origin}/loop`) === 'feed discovery loop',
  'a page that links to itself stops at the hop limit', await failure(`${origin}/loop`))

// --- the poller on top of it, through a real run ---
const root = makeDataRoot({
  feeds: [
    { id: 'feed', url: `${origin}/feed`, title: 'Feed' },
    { id: 'page', url: `${origin}/html-as-feed`, title: 'Page' },
  ],
})
const run = await runFetch({ root, dataDir: '.local' })
ok(run.failed === 1 && run.fresh === 1, 'a run reads the feed and refuses the page', [run.failed, run.fresh])
const meta = JSON.parse(readFileSync(path.join(root, '.local', 'meta.json'), 'utf8'))
ok(meta.page && meta.page.lastError === 'response is not an XML feed',
  'the page is recorded as that feed\'s error, with the classifier\'s own words', meta.page && meta.page.lastError)
ok(meta.feed && !meta.feed.lastError && meta.feed.etag === '"v1"',
  'while the feed keeps its validators for the next conditional read', meta.feed)

server.close()
removeRoot(root)
finish()
