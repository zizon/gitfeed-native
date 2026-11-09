// The split item model: a stable itemsVersion, a payload that omits unchanged
// rows, deterministic ordering, and no reshuffle when a mark lands.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { appendItem, makeDataRoot, removeRoot, sampleLibrary } from './fixtures.mjs'
import { finish, nodeTimers, ok } from './harness.mjs'
import { createGitfeed } from '../lib/host/service.js'

const { feeds, items } = sampleLibrary(32)
// The newest row starts unread, so marking it is a real change.
const root = makeDataRoot({ feeds, items, read: [items[items.length - 1].id] })
const log = { info() {}, warn(...a) { console.log('WARN', ...a) }, error() {} }
const service = createGitfeed({
  root,
  logger: log,
  timers: nodeTimers(),
  allowGit: false,
  refreshMinutes: 0,
  syncMinutes: 0,
})

const full = await service.getState()
ok(Array.isArray(full.items) && full.items.length === items.length, `full payload carries every item (${full.items?.length})`)
ok(typeof full.itemsVersion === 'string' && full.itemsVersion.length > 10, 'full payload names the item model')

let sorted = true
for (let i = 1; i < full.items.length; i++) {
  const a = full.items[i - 1]
  const b = full.items[i]
  if (a.date < b.date || (a.date === b.date && a.id > b.id)) {
    sorted = false
    console.log('  out of order at', i, a.date, a.id, b.date, b.id)
    break
  }
}
ok(sorted, 'items are newest-first and tie-broken by id')

const twins = full.items.filter((item) => item.date === full.items[0].date).map((item) => item.id)
ok(twins.length > 1, 'the fixture has items sharing a timestamp', twins)
ok(JSON.stringify(twins) === JSON.stringify([...twins].sort()), 'equal dates are ordered by id', twins)

const same = await service.getState(full.version)
ok(same.unchanged === true && same.items === undefined, 'known state version short-circuits without rows')

const firstId = full.items[0].id
await service.mark([firstId], true)
const afterMark = await service.getState(full.version, full.itemsVersion)
ok(afterMark.version !== full.version, 'marking read moves the state version')
ok(afterMark.itemsVersion === full.itemsVersion, 'marking read leaves the item model alone')
ok(afterMark.itemsUnchanged === true, 'unchanged model travels as a flag')
ok(afterMark.items === undefined, 'unchanged model travels without rows')
ok(Array.isArray(afterMark.read) && afterMark.read.includes(firstId), 'the mark still arrives')
const payloadFull = JSON.stringify(full).length
const payloadMark = JSON.stringify(afterMark).length
console.log(`     payload: ${(payloadFull / 1e3).toFixed(1)} KB full, ${(payloadMark / 1e3).toFixed(1)} KB for a mark`)
ok(payloadMark * 4 < payloadFull, 'a mark costs far less than a full model')

const again = await service.getState(null, full.itemsVersion)
ok(again.itemsUnchanged === true, 'a second identical ask also omits rows')

appendItem(`${root}/data/items`, {
  id: 'zz-later',
  feed: 'feed-a',
  title: 'An item that arrived later',
  link: 'https://example.com/later',
  date: '2026-02-01T00:00:00.000Z',
  author: '',
  summary: 'fresh row',
})
const freshState = await service.getState(null, full.itemsVersion)
ok(freshState.itemsUnchanged === undefined && Array.isArray(freshState.items), 'a new row ships the model again')
ok(freshState.itemsVersion !== full.itemsVersion, 'a new row moves the item model version')
ok(freshState.items.some((item) => item.id === 'zz-later'), 'the new row is in the model')
ok(freshState.items[0].id === 'zz-later', 'the newest row leads the list', freshState.items[0].date)

// A repair lands in the cache while the committed copy came first, so the two
// stores hold one id twice. The model has to carry the longer body or the
// repair never reaches the reader.
const repairedId = full.items[1].id
appendItem(`${root}/.local/items`, {
  id: repairedId,
  feed: 'feed-a',
  title: 'repaired',
  link: 'https://example.com/repaired',
  date: full.items[1].date,
  author: '',
  summary: `<p>${'the longer body '.repeat(50)}</p>`,
})
const merged = await service.getState(null, null)
const mergedRow = merged.items.find((item) => item.id === repairedId)
ok(
  mergedRow !== undefined && mergedRow.summary.length > 400,
  'a repaired copy in the cache wins over the committed one',
  mergedRow && mergedRow.summary.length,
)

// A shard that disappears is not a shard any more. Retention prunes months, and
// the parsed copy the model keeps must not resurrect rows the archive deleted.
rmSync(path.join(root, 'data', 'items', '2026-02.ndjson'), { force: true })
const pruned = await service.getState(null, null)
ok(!pruned.items.some((item) => item.id === 'zz-later'), 'a deleted shard takes its rows with it', pruned.items.length)

// The two meta stores describe the same feeds. The one whose check ran last
// wins, because the plugin fetches into the cache: preferring the committed
// copy meant a rename upstream could never reach the sidebar.
const metaDir = path.join(root, '.local')
mkdirSync(metaDir, { recursive: true })
writeFileSync(path.join(root, 'data', 'meta.json'), `${JSON.stringify({
  'feed-a': { title: 'Old name', lastError: 'HTTP 500', checkedAt: '2026-01-01T00:00:00.000Z' },
})}\n`)
writeFileSync(path.join(metaDir, 'meta.json'), `${JSON.stringify({
  'feed-a': { title: 'New name', siteUrl: 'https://new.example/', checkedAt: '2026-02-01T00:00:00.000Z' },
})}\n`)
const named = await service.getState(null, null)
const feedA = named.feeds.find((feed) => feed.id === 'feed-a')
ok(feedA !== undefined && feedA.title === 'New name', 'the store checked last names the feed', feedA && feedA.title)
ok(feedA !== undefined && feedA.siteUrl === 'https://new.example/', 'and brings the fields only it has', feedA && feedA.siteUrl)
ok(feedA !== undefined && feedA.error === null, 'a recovered feed is not painted with the old failure', feedA && feedA.error)

const listed = await service.listForTool({ limit: 3 })
ok(listed.items.length === 3, 'the agent tool still lists rows')

// A marking scope is not silently truncated: the reader sends every unread row
// its list holds, and a request cut at a cap marks only some of them, which
// then reappear on the next load.
{
  const bulkRoot = makeDataRoot({ feeds: [], items: [] })
  const bulk = createGitfeed({
    root: bulkRoot,
    logger: log,
    timers: nodeTimers(),
    allowGit: false,
    refreshMinutes: 0,
    syncMinutes: 0,
  })
  const ids = Array.from({ length: 4200 }, (_, i) => `bulk-${i}`)
  const result = await bulk.mark(ids, true)
  ok(result.changed === 4200, 'a marking scope larger than the old cap is taken whole', result.changed)
  bulk.dispose()
  removeRoot(bulkRoot)
}

// The agent's search decodes with the parser's own table, so a body is findable
// by the character it renders as rather than only by its source bytes.
{
  const entityRoot = makeDataRoot({
    feeds: [{ id: 'feed-entity', url: 'https://example.com/e.xml', title: 'Entity' }],
    items: [{
      id: 'entity-1',
      feed: 'feed-entity',
      title: 'Dash',
      link: 'https://example.com/e/1',
      date: '2026-11-01T00:00:00.000Z',
      author: '',
      summary: '<p>a &mdash; b &amp; c</p>',
    }],
  })
  const entityService = createGitfeed({
    root: entityRoot,
    logger: log,
    timers: nodeTimers(),
    allowGit: false,
    refreshMinutes: 0,
    syncMinutes: 0,
  })
  const hits = await entityService.listForTool({ query: 'a \u2014 b' })
  ok(hits.items.length === 1, 'the agent search finds a body by the character it renders as', hits.items.length)
  const one = await entityService.getForTool('entity-1')
  ok(one.summary === 'a \u2014 b & c', 'and the excerpt is the text, decoded', one.summary)
  entityService.dispose()
  removeRoot(entityRoot)
}

// A state build nobody is waiting for stops at its first await.
{
  const cancelled = new AbortController()
  cancelled.abort()
  let refused = false
  await service.getState(null, null, cancelled.signal).catch(function () { refused = true })
  ok(refused, 'a cancelled state build does not read the model', refused)
}

service.dispose()
removeRoot(root)
finish()
