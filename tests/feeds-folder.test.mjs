// Assigning a subscription to a folder. One field of one entry in feeds.json,
// written through the same queue as every other subscription change and reached
// from three callers that share one implementation: the reader's route, the
// agent's tool, and the service under both. What is checked here is the contract
// they share — the entry keeps everything but its folder, an empty name is still
// a folder, and a feed that is not there is an error rather than a quiet no-op.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { finish, lib, nodeTimers, ok } from './harness.mjs'
import { makeDataRoot, removeRoot, sampleLibrary } from './fixtures.mjs'

const { createGitfeed } = await import(lib('host', 'service.js'))
const { createHandler } = await import(lib('host', 'http.js'))
const { registerTool } = await import(lib('host', 'tool.js'))

const { feeds } = sampleLibrary(4)
// A custom feed rides along: a move must not drop the declaration that makes it
// one, or the next fetch would read the subscription as a plain RSS URL.
feeds.push({
  id: 'papers',
  url: 'https://example.com/pubs',
  title: 'Papers',
  folder: 'Research',
  type: 'custom',
  script: 'sources/papers.mjs',
  options: { page: 2 },
})
// And one entry written by hand, with no folder at all.
feeds.push({ id: 'bare', url: 'https://example.com/bare.xml', title: 'Bare' })

const root = makeDataRoot({ feeds })
const service = createGitfeed({ root: root, timers: nodeTimers(), allowGit: false, refreshMinutes: 0 })
const feedsFile = path.join(root, 'feeds.json')
const stored = () => JSON.parse(readFileSync(feedsFile, 'utf8')).feeds
const entryOf = (id) => stored().find((entry) => entry.id === id)
const raw = () => readFileSync(feedsFile, 'utf8')

// --- one entry moves, and only its folder changes ---
const before = JSON.parse(JSON.stringify(entryOf('feed-a')))
const moved = await service.setFeedFolder('feed-a', ' Papers ')
ok(moved.folder === 'Papers', 'the move answers with the entry as written', moved.folder)
ok(entryOf('feed-a').folder === 'Papers', 'and feeds.json carries the new folder', entryOf('feed-a'))
ok(JSON.stringify(Object.assign({}, entryOf('feed-a'), { folder: before.folder })) === JSON.stringify(before),
  'every other field of that entry is untouched', entryOf('feed-a'))
ok(entryOf('feed-b').folder === 'Weekly', 'the feed that was not moved stays where it was', entryOf('feed-b'))
ok(stored().length === feeds.length, 'a move adds and removes nothing', stored().length)

// The client reads the folder from the state payload, so that is the same fact.
const state = await service.getState()
const shown = state.feeds.find((feed) => feed.id === 'feed-a')
ok(shown && shown.folder === 'Papers', '/state reports the folder the reader groups by', shown && shown.folder)

// --- an empty name is a folder, not a hole ---
await service.setFeedFolder('feed-a', '   ')
ok(entryOf('feed-a').folder === 'Uncategorized', 'an emptied folder is written as Uncategorized', entryOf('feed-a'))
await service.setFeedFolder('bare', '')
ok(entryOf('bare').folder === 'Uncategorized', 'and so is a move of an entry that had no folder', entryOf('bare'))

// --- a custom feed keeps its declaration ---
await service.setFeedFolder('papers', 'Reading')
const custom = entryOf('papers')
ok(custom.folder === 'Reading' && custom.type === 'custom' && custom.script === 'sources/papers.mjs',
  'a moved custom feed stays a custom feed', custom)
ok(JSON.stringify(custom.options) === JSON.stringify({ page: 2 }), 'with the options it was declared with', custom.options)

// --- the same folder twice writes nothing ---
const settled = raw()
const again = await service.setFeedFolder('feed-a', 'Uncategorized')
ok(again.folder === 'Uncategorized' && raw() === settled, 'moving a feed where it already is rewrites nothing', raw().length)

// --- an id that is not there is an error, not a no-op ---
let missing = ''
try {
  await service.setFeedFolder('nope', 'Papers')
} catch (err) {
  missing = String(err.message || err)
}
ok(missing === 'no such feed', 'moving a feed that is not subscribed fails loudly', missing)
let noId = ''
try {
  await service.setFeedFolder('', 'Papers')
} catch (err) {
  noId = String(err.message || err)
}
ok(noId === 'feed id is required', 'as does a request with no id', noId)

// --- the route the page posts to ---
const handler = createHandler(service)
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

const posted = await post('/feeds/folder', { id: 'feed-b', folder: 'Clippings' })
ok(posted.status === 200 && posted.body.ok === true, 'POST /feeds/folder answers ok', posted)
ok(posted.body.feed && posted.body.feed.folder === 'Clippings', 'with the entry it wrote', posted.body.feed)
ok(entryOf('feed-b').folder === 'Clippings', 'and the file agrees with the answer', entryOf('feed-b').folder)
const refused = await post('/feeds/folder', { id: 'nope', folder: 'Clippings' })
ok(refused.status === 400 && refused.body.ok === false && /no such feed/.test(refused.body.error),
  'the route reports a missing feed as the caller\'s error, with a message the page can toast', refused)

// --- the tool the agent calls ---
const definitions = []
const ctx = { tools: { register(definition) { definitions.push(definition); return function () {} } } }
registerTool(ctx, service)
const tool = definitions.find((definition) => definition.name === 'gitfeed')
ok(tool && /folder/.test(tool.parameters.properties.action.enum.join(' ')), 'the tool advertises the folder action',
  tool && tool.parameters.properties.action.enum)

const byTool = await tool.execute({ action: 'folder', id: 'feed-a', folder: 'From agent' })
ok(byTool.ok === true && byTool.feed.folder === 'From agent', 'the tool moves the feed the page would', byTool)
ok(entryOf('feed-a').folder === 'From agent', 'through the same write', entryOf('feed-a').folder)
let toolNoId = ''
try {
  await tool.execute({ action: 'folder', folder: 'Papers' })
} catch (err) {
  toolNoId = String(err.message || err)
}
ok(toolNoId === 'id is required for folder', 'the tool asks for the id it needs', toolNoId)

// A caller with no datalist to pick from needs the names in use, not a guess.
const status = await tool.execute({ action: 'status' })
const folders = new Map((status.folders || []).map((row) => [row.name, row.feeds]))
ok(folders.get('From agent') === 1 && folders.get('Reading') === 1 && folders.get('Clippings') === 1,
  'status lists the folder names in use with how many feeds each holds', status.folders)
ok(!folders.has(undefined) && !folders.has(''), 'and never an unnamed one', status.folders)

service.dispose()
removeRoot(root)
finish()
