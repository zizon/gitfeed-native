// Unsubscribing stops following a source; it does not delete what the source
// already delivered. The rows stay in both stores — the archive is the reader's
// past — and the digest simply stops drawing sources that are not followed, so
// the list and search lose them while the disk keeps them. Subscribing again
// puts them back, with their read state, because the digest is a view over the
// stores rather than a copy.
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { appendItem, makeDataRoot, removeRoot, sampleLibrary } from './fixtures.mjs'
import { finish, lib, nodeTimers, ok } from './harness.mjs'

const { createGitfeed } = await import(lib('host', 'service.js'))
const { createHandler } = await import(lib('host', 'http.js'))
const { registerTool } = await import(lib('host', 'tool.js'))

const { feeds, items } = sampleLibrary(3)
// A source that is not subscribed at all: only its rows remain, in the
// committed archive and in the local cache.
const orphan = function (id, month, feed) {
  return {
    id: id,
    feed: feed,
    title: `Leftover ${id}`,
    link: `https://example.com/leftover/${id}`,
    date: `2026-${month}-21T10:00:00.000Z`,
    author: 'Leftover',
    summary: '<p>left behind</p>',
  }
}
const unsubscribed = 'ghost-source'
const root = makeDataRoot({
  feeds,
  items: items.concat([orphan('ghost-1', '01', unsubscribed), orphan('ghost-2', '02', unsubscribed)]),
  read: ['feed-a-000'],
})
const localItems = path.join(root, '.local', 'items')
mkdirSync(localItems, { recursive: true })
appendItem(localItems, orphan('ghost-3', '03', unsubscribed))

const service = createGitfeed({ root: root, timers: nodeTimers(), allowGit: false, refreshMinutes: 0, syncMinutes: 0 })
const handler = createHandler(service)
const feedsFile = path.join(root, 'feeds.json')
const stored = function () { return JSON.parse(readFileSync(feedsFile, 'utf8')).feeds }
const state = function () { return service.getState() }

function post(route, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    url: `/gitfeed/api${route}`,
    method: 'POST',
    headers: { host: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield* payload },
  }
  return new Promise(function (resolve) {
    const res = {
      status: 0,
      headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true },
      end(text) {
        let parsed = null
        try { parsed = JSON.parse(text || '') } catch { /* not json */ }
        resolve({ status: this.status, body: parsed })
      },
    }
    void handler(req, res)
  })
}

// --- a row whose source is not followed is not on the shelf ---
const before = await state()
ok(before.feeds.length === 2, 'the subscription list is the two feeds', before.feeds.map((feed) => feed.id))
ok(!before.items.some((item) => item.feed === unsubscribed),
  'rows of a source that is not followed are not in the digest', before.items.length)
ok(before.items.some((item) => item.id === 'feed-a-000'), 'the followed sources keep theirs', before.items.length)

// --- unsubscribing removes the entry, not the rows ---
const removed = await post('/feeds/remove', { id: 'feed-a' })
ok(removed.status === 200 && removed.body.ok === true && removed.body.removed === 'feed-a',
  'POST /feeds/remove answers with the id it stopped following', removed.body)
ok(stored().length === 1 && stored()[0].id === 'feed-b', 'feeds.json keeps only the other source', stored())
const after = await state()
ok(!after.items.some((item) => item.feed === 'feed-a'),
  'the digest stops drawing the source that is no longer followed', after.items.length)
ok(after.items.some((item) => item.feed === 'feed-b'), 'and keeps drawing the one that is',
  after.items.filter((item) => item.feed === 'feed-b').length)
const shard = readFileSync(path.join(root, 'data', 'items', '2026-01.ndjson'), 'utf8')
ok(shard.includes('"feed":"feed-a"'), 'the rows themselves are still in the committed archive', shard.length)
ok(after.read.includes('feed-a-000'), 'and the read state is untouched', after.read.length)

// --- the item model version follows the subscription list ---
// A surface holding the old digest must be sent the rows again: the visible
// list changed without a shard being written.
ok(before.itemsVersion !== after.itemsVersion, 'the digest version moved with the subscription list',
  [before.itemsVersion, after.itemsVersion])
const caughtUp = await service.getState(before.version, before.itemsVersion)
ok(caughtUp.items !== undefined, 'a surface holding the old version is sent the rows, not told they are unchanged')
const current = await service.getState(undefined, after.itemsVersion)
ok(current.itemsUnchanged === true, 'and one holding the current version is told they are unchanged', current.itemsUnchanged)

// --- an id that is not subscribed is still nobody's ---
const twice = await post('/feeds/remove', { id: 'feed-a' })
ok(twice.status === 400 && /no such feed/.test(twice.body.error),
  'a second call finds no subscription and is the caller\'s error', twice)
const ghost = await post('/feeds/remove', { id: unsubscribed })
ok(ghost.status === 400 && /no such feed/.test(ghost.body.error),
  'a source that was never subscribed is refused the same way — its rows are not for the API to sweep', ghost)
const empty = await post('/feeds/remove', {})
ok(empty.status === 400 && /feed id is required/.test(empty.body.error),
  'and an empty id is refused before anything is read', empty)

// --- subscribing again brings the rows back ---
const restoredList = JSON.parse(readFileSync(feedsFile, 'utf8'))
restoredList.feeds.push(feeds.find((feed) => feed.id === 'feed-a'))
const { writeFileSync } = await import('node:fs')
writeFileSync(feedsFile, `${JSON.stringify(restoredList, null, 2)}\n`)
const restored = await state()
ok(restored.items.some((item) => item.id === 'feed-a-000'),
  'a source that is followed again has its rows back', restored.items.length)
ok(restored.read.includes('feed-a-000'), 'and they are still read', restored.read.length)

// --- the agent's tool goes through the same call ---
const definitions = []
const ctx = { tools: { register(definition) { definitions.push(definition); return function () {} } } }
registerTool(ctx, service)
const tool = definitions.find((definition) => definition.name === 'gitfeed')
const byTool = await tool.execute({ action: 'unsubscribe', id: 'feed-b' })
ok(byTool.ok === true && byTool.removed === 'feed-b', 'the tool unsubscribes the same way', byTool)
ok(stored().length === 1, 'and the list keeps only what is still followed', stored())
const keptRows = readFileSync(path.join(root, 'data', 'items', '2026-01.ndjson'), 'utf8')
ok(keptRows.includes('"feed":"feed-b"'), 'whose rows the tool left in the store as well', keptRows.length)
const toolAgain = await tool.execute({ action: 'unsubscribe', id: 'feed-b' }).then(
  function () { return null },
  function (err) { return String((err && err.message) || err) },
)
ok(toolAgain === 'no such feed', 'the tool reports the repeat as the same error the route answers', toolAgain)

service.dispose()
removeRoot(root)
finish()
