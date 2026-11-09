// The live copy and its deltas: what the stream sends, and the merge a surface
// applies to it. The invariant these exercise is the one the transport rests
// on — a surface that follows every delta ends up with exactly the rows and
// marks a full load would have produced, and nothing gets a second revision.
import { finish, lib, ok } from './harness.mjs'

const { createLiveState } = await import(lib('host', 'live.js'))
const { mergeItems, orderItems, HISTORY } = await import(lib('shared', 'stream.js'))

const feeds = [
  { id: 'feed-a', title: 'Alpha', folder: 'Daily', siteUrl: null, url: null, error: null, checkedAt: null },
  { id: 'feed-b', title: 'Beta', folder: 'Weekly', siteUrl: null, url: null, error: null, checkedAt: null },
]

function item(id, date, summary) {
  return {
    id: id,
    feed: 'feed-a',
    title: `Row ${id}`,
    link: `https://example.com/${id}`,
    date: date,
    author: '',
    summary: summary || `<p>${id}</p>`,
  }
}

function snapshot(overrides) {
  const base = {
    version: 'v1',
    itemsVersion: 'm1',
    items: [],
    read: [],
    starred: [],
    feeds: feeds,
    reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
    git: null,
    schedule: [],
    repo: '/tmp/gitfeed-root',
    allowGit: false,
  }
  return Object.assign({}, base, overrides)
}

// --- no state, no frames ---
const empty = createLiveState()
ok(empty.info() === null, 'a live copy starts with no state')
ok(empty.welcome() === null, 'and has nothing to welcome a surface with')
ok(empty.framesAfter(0).length === 0, 'and sends no frames')
ok(empty.mark(['a'], true) === null, 'a mark before the first read is not a frame')

// --- the first read installs the state, and is not itself a delta ---
const live = createLiveState()
const first = snapshot({
  items: [item('a', '2026-11-02T10:00:00.000Z'), item('b', '2026-11-01T10:00:00.000Z')],
  read: ['b'],
  starred: ['a'],
})
ok(live.apply(first) === null, 'the first read installs the state without a delta')
ok(live.info().rev === 1 && live.info().version === 'v1', 'as revision one, so a reconnect can continue from it', live.info())

const welcome = live.framesAfter(0)
ok(welcome.length === 1 && welcome[0].t === 'welcome', 'a surface with no revision gets the whole state', welcome.map((frame) => frame.t))
ok(welcome[0].items.length === 2 && welcome[0].read.join() === 'b', 'with the rows and marks it needs', welcome[0].read)

// --- a read that finds nothing new is not a revision ---
ok(live.apply(first) === null, 're-reading the same state sends nothing')
ok(live.info().rev === 1, 'and does not spend a revision', live.info().rev)

// --- a fetch that lands rows ---
const added = snapshot({
  version: 'v2',
  itemsVersion: 'm2',
  items: [item('c', '2026-11-03T10:00:00.000Z')].concat(first.items),
  read: ['b'],
  starred: ['a'],
})
const addFrame = live.apply(added)
ok(addFrame && addFrame.rev === 2, 'a new row gets the next revision', addFrame)
ok(addFrame.items.added.length === 1 && addFrame.items.added[0].id === 'c', 'and travels as an added row', addFrame.items)
ok(!addFrame.items.removed.length, 'nothing is reported removed', addFrame.items)
ok(addFrame.read === undefined && addFrame.starred === undefined, 'and the marks that did not move stay out of the frame')

// --- a repaired body travels as an update, in place ---
const repaired = snapshot({
  version: 'v3',
  itemsVersion: 'm3',
  items: [item('c', '2026-11-03T10:00:00.000Z'), item('a', '2026-11-02T10:00:00.000Z', '<p>grown body</p>'), item('b', '2026-11-01T10:00:00.000Z')],
  read: ['b'],
  starred: ['a'],
})
const repairFrame = live.apply(repaired)
ok(repairFrame.items.updated.length === 1 && repairFrame.items.updated[0].id === 'a', 'a longer body is an updated row', repairFrame.items)
ok(!repairFrame.items.added.length && !repairFrame.items.removed.length, 'and is not reported as an arrival or a removal', repairFrame.items)

// --- an unsubscribe removes the rows it wrote ---
const trimmed = snapshot({
  version: 'v4',
  itemsVersion: 'm4',
  items: [item('c', '2026-11-03T10:00:00.000Z'), item('a', '2026-11-02T10:00:00.000Z', '<p>grown body</p>')],
  read: ['b'],
  starred: [],
  feeds: [feeds[0]],
})
const trimFrame = live.apply(trimmed)
ok(trimFrame.items.removed.join() === 'b', 'a row the archive dropped is a removal', trimFrame.items)
ok(trimFrame.starred.remove.join() === 'a', 'and the star it held goes with it', trimFrame.starred)
ok(trimFrame.feeds.length === 1, 'the source list travels with it', trimFrame.feeds.length)

// --- a mark this process wrote is one frame of ids ---
const beforeMark = live.info().rev
const markFrame = live.mark(['a'], true)
ok(markFrame && markFrame.rev === beforeMark + 1, 'a mark is its own revision', markFrame)
ok(markFrame.read.add.join() === 'a' && !markFrame.read.remove.length, 'and carries only the id that changed', markFrame.read)
ok(markFrame.items === undefined, 'without any rows', markFrame.items)
ok(live.mark(['a'], true) === null, 'marking the same row again is not news')
const unmarkFrame = live.mark(['a'], false)
ok(unmarkFrame.read.remove.join() === 'a', 'unmarking is the other direction', unmarkFrame && unmarkFrame.read)
const starFrame = live.star(['a'], true)
ok(starFrame.starred.add.join() === 'a', 'a star travels the same way', starFrame && starFrame.starred)

// --- a surface that holds a revision gets only what it missed ---
const missed = live.framesAfter(1)
ok(missed.every((frame) => frame.rev > 1), 'a surface gets the frames after its revision', missed.map((frame) => frame.rev))
ok(missed.length > 0 && missed[missed.length - 1].rev === live.info().rev, 'ending at the current revision', missed[missed.length - 1].rev)
ok(live.framesAfter(live.info().rev).length === 0, 'a current surface gets nothing')
ok(live.framesAfter(live.info().rev + 1)[0].t === 'welcome', 'a revision from a Host that restarted is answered with the whole state')
ok(live.framesAfter(-1)[0].t === 'welcome', 'and so is no revision at all')

// The history is bounded: a surface that fell further behind than that gets the
// state instead of a gap it could never fill.
const behind = createLiveState()
behind.apply(first)
for (let i = 0; i < HISTORY + 5; i++) behind.mark([`m${i}`], true)
const far = behind.framesAfter(1)
ok(far.length === 1 && far[0].t === 'welcome', 'a surface behind the history window gets the whole state', far.map((frame) => frame.t))

// --- the merge: a surface following the deltas holds what a full load would ---
const held = mergeItems([], { added: [item('a', '2026-11-02T10:00:00.000Z'), item('b', '2026-11-01T10:00:00.000Z')], updated: [], removed: [] })
ok(held.map((row) => row.id).join() === 'a,b', 'rows are listed newest first', held.map((row) => row.id))
const merged = mergeItems(held, { added: [item('c', '2026-11-03T10:00:00.000Z')], updated: [], removed: [] })
ok(merged.map((row) => row.id).join() === 'c,a,b', 'an arriving row lands by its date', merged.map((row) => row.id))
const replaced = mergeItems(merged, { added: [], updated: [item('b', '2026-11-01T10:00:00.000Z', '<p>repaired</p>')], removed: [] })
ok(replaced.length === 3 && replaced[2].summary === '<p>repaired</p>', 'an updated row keeps its place', replaced[2] && replaced[2].summary)
ok(replaced[0].id === 'c' && replaced[1].id === 'a', 'and the rows around it do not move', replaced.map((row) => row.id))
const dropped = mergeItems(replaced, { added: [], updated: [], removed: ['a'] })
ok(dropped.map((row) => row.id).join() === 'c,b', 'a removed row leaves the list', dropped.map((row) => row.id))
ok(mergeItems(dropped, { added: [item('c', '2026-11-03T10:00:00.000Z')], updated: [], removed: [] }).length === 2,
  'a row already held is not added twice')
ok(mergeItems(dropped, { added: [item('a', '2026-11-02T10:00:00.000Z')], updated: [], removed: ['a'] }).length === 2,
  'a row both added and removed never appears')

// Ties: same timestamp, ordered by id, so a refresh cannot swap two rows.
const tied = mergeItems(
  [item('b', '2026-11-01T10:00:00.000Z'), item('d', '2026-11-01T10:00:00.000Z')],
  { added: [item('a', '2026-11-01T10:00:00.000Z'), item('c', '2026-11-01T10:00:00.000Z')], updated: [], removed: [] },
)
ok(tied.map((row) => row.id).join() === 'a,b,c,d', 'rows sharing a timestamp are ordered by id', tied.map((row) => row.id))
ok(orderItems(item('a', '2026-11-01T10:00:00.000Z'), item('b', '2026-11-01T10:00:00.000Z')) < 0, 'the order is a, then b', orderItems({ id: 'a', date: 'x' }, { id: 'b', date: 'x' }))

// A whole feed arriving at once takes the merge path, not n insertions. The
// held rows and the arrivals are in archive order, the way a surface and the
// Host both keep them.
const at = (hoursAgo) => new Date(Date.UTC(2026, 9, 31, 10) - hoursAgo * 3600000).toISOString()
const base = []
for (let i = 0; i < 40; i++) base.push(item(`base-${i}`, at(i + 1)))
const big = []
for (let i = 0; i < 60; i++) big.push(item(`big-${i}`, at(41 + i)))
const bulk = mergeItems(base, { added: big, updated: [], removed: [] })
ok(bulk.length === 100, 'a bulk arrival lands whole', bulk.length)
ok(bulk.every((row, index) => index === 0 || orderItems(bulk[index - 1], row) <= 0), 'and stays in archive order', bulk.length)

// --- a surface waiting for the next frame is woken by one ---
const waiting = createLiveState()
waiting.apply(first)
const gate = new AbortController()
let woke = 0
const next = waiting.changed(waiting.info().rev, gate.signal).then(function () { woke += 1 })
ok(woke === 0, 'a surface at the current revision waits')
waiting.mark(['w1'], true)
await next
ok(woke === 1, 'a change wakes it once', woke)

// A surface already behind does not wait at all.
let immediate = false
await waiting.changed(0, new AbortController().signal).then(function () { immediate = true })
ok(immediate === true, 'a surface behind the state is answered at once')

// A newer state that changes nothing a surface draws does not wake anyone.
let wokeOnSilent = 0
const quiet = new AbortController()
void waiting.changed(waiting.info().rev, quiet.signal).then(function () { wokeOnSilent += 1 })
waiting.apply(Object.assign({}, first, { version: 'v-silent', read: ['b', 'w1'] }))
await new Promise(function (resolve) { setTimeout(resolve, 5) })
ok(wokeOnSilent === 0, 'a silent version move wakes nobody', wokeOnSilent)

// Cancelling the wait resolves it without a frame.
let cancelled = 0
const cancelling = new AbortController()
void waiting.changed(waiting.info().rev, cancelling.signal).then(function () { cancelled += 1 })
cancelling.abort()
await new Promise(function (resolve) { setTimeout(resolve, 5) })
ok(cancelled === 1, 'a cancelled wait resolves without a change', cancelled)

// Disposing the service wakes every waiter; without it a pull could outlive it.
let woken = 0
void waiting.changed(waiting.info().rev, new AbortController().signal).then(function () { woken += 1 })
waiting.wake()
await new Promise(function (resolve) { setTimeout(resolve, 5) })
ok(woken === 1, 'wake resolves every waiting surface', woken)

finish()
