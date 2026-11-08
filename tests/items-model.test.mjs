// The split item model: a stable itemsVersion, a payload that omits unchanged
// rows, deterministic ordering, and no reshuffle when a mark lands.
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

const listed = await service.listForTool({ limit: 3 })
ok(listed.items.length === 3, 'the agent tool still lists rows')

service.dispose()
removeRoot(root)
finish()
