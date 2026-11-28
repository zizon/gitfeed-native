// When a run judges a feed: the moment it lands, not after the whole set. A
// verdict needs one result and the run's constants, so the progress line and the
// count can exist while other feeds are still being read; the one decision that
// needs everyone — whether the run reached anything at all — is a post-pass.
// Writing is still one transaction after the last feed, which is why the write
// line comes after both feeds' lines here.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { makeDataRoot, removeRoot } from './fixtures.mjs'
import { finish, lib, ok } from './harness.mjs'

const { runFetch } = await import(lib('host', 'fetch.js'))

const feed = function (title) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>
  <item><title>${title} one</title><link>https://example.com/${title}/1</link><guid>${title}-1</guid>
  <pubDate>Wed, 05 Nov 2026 10:00:00 GMT</pubDate><description>a body</description></item>
</channel></rss>`
}

const server = http.createServer(function (req, res) {
  const send = function () {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(feed(req.url === '/slow' ? 'Slow' : 'Fast'))
  }
  if (req.url === '/slow') setTimeout(send, 150)
  else send()
})
await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
const origin = `http://127.0.0.1:${server.address().port}`
// The slow feed is listed first: if the order of the lines is the feed order,
// the run is still judging after the batch.
const root = makeDataRoot({
  feeds: [
    { id: 'slow', url: `${origin}/slow`, title: 'Slow' },
    { id: 'fast', url: `${origin}/fast`, title: 'Fast' },
  ],
})
const lines = []
const result = await runFetch({ root: root, dataDir: '.local', onLog: function (line) { lines.push(line) } })

const at = function (needle) { return lines.findIndex((line) => line.includes(needle)) }
const fast = at('ok   fast')
const slow = at('ok   slow')
const write = at('write .local/items/')
ok(fast !== -1 && slow !== -1, 'both feeds report as they are judged', lines)
ok(fast < slow, 'the feed that answered first is judged first, not in file order', { fast, slow, lines })
ok(fast < write && slow < write, 'and both verdicts exist before the one write', { slow, write, lines })
ok(write !== -1, 'the run writes once for the month, not once per feed', lines.filter((line) => line.includes('write ')))

const month = new Date().toISOString().slice(0, 7)
const rows = readFileSync(path.join(root, '.local', 'items', `${month}.ndjson`), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line))
ok(rows.length === 2, 'the single append carries both feeds\' rows', rows.length)
ok(rows.every((row) => row.id && row.feed), 'and each row names the feed it came from')
ok(result.fresh === 2 && result.feeds === 2 && result.failed === 0,
  'the report counts what the per-feed judgments counted', result)

server.close()
removeRoot(root)
finish()
