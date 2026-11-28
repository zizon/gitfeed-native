// Feed identity has one owner. The fetcher writes rows, metadata, and its
// scheduler clocks under an id, and the digest decides what to show by looking
// that id up in feeds.json — so a second derivation (slugging a stored id, or
// numbering duplicates from a different list) makes a subscribed source's rows
// invisible. The ordering in the file is the only tie-break a repeated id has;
// what must not happen is two readers breaking the tie differently.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { makeDataRoot, removeRoot } from './fixtures.mjs'
import { finish, lib, nodeTimers, ok } from './harness.mjs'

const { readFeeds, assignFeedIds, feedIdFor } = await import(lib('host', 'feeds.js'))
const { loadRuntimeFeeds } = await import(lib('host', 'fetch.js'))
const { createGitfeed } = await import(lib('host', 'service.js'))

const ALPHA = 'https://example.com/alpha.xml'
const EXOTIC = 'https://example.com/exotic.xml'
const DUP = 'https://example.com/dup.xml'
// A hand-edited list, the way the README invites: one entry with no id, one
// whose id is not in the slug shape the fetcher used to force, and two that
// collide.
const entries = [
  { url: ALPHA, title: 'Alpha' },
  { id: 'Exotic_Feed-', url: EXOTIC, title: 'Exotic' },
  { url: DUP, title: 'Dup one' },
  { url: DUP, title: 'Dup two' },
]
// The row was fetched under the id the URL derives, which is the id the entry
// has to be recognised by.
const root = makeDataRoot({
  feeds: entries,
  items: [{
    id: 'alpha-1', feed: feedIdFor(ALPHA), title: 'Alpha one', link: 'https://example.com/alpha/1',
    date: '2026-01-21T10:00:00.000Z', author: '', summary: '<p>body</p>',
  }],
})

// --- the derivation itself ---
const ids = assignFeedIds(entries)
ok(ids[0] === feedIdFor(ALPHA), 'an entry with no id is keyed by the id its URL derives', ids[0])
ok(ids[1] === 'Exotic_Feed-', 'a stored id is kept verbatim, not slugged into a different key', ids[1])
ok(ids[2] !== ids[3] && ids[3] === `${ids[2]}-2`, 'a repeated id is numbered in file order', ids.slice(2))
ok(assignFeedIds([{ url: DUP }, { url: DUP }]).join() === `${feedIdFor(DUP)},${feedIdFor(DUP)}-2`,
  'and the numbering depends on nothing but the list', assignFeedIds([{ url: DUP }, { url: DUP }]))

// --- both readers of the list agree ---
const stored = await readFeeds(root)
const fetched = await loadRuntimeFeeds(root)
ok(stored.map((feed) => feed.id).join() === fetched.map((feed) => feed.id).join(),
  'the digest and the fetcher assign the same ids to the same list', [stored.map((feed) => feed.id), fetched.map((feed) => feed.id)])
ok(stored.map((feed) => feed.id).join() === ids.join(), 'and both are the one derivation', stored.map((feed) => feed.id))

// --- the digest draws a subscribed source whose entry never carried an id ---
const service = createGitfeed({ root: root, timers: nodeTimers(), allowGit: false, refreshMinutes: 0, syncMinutes: 0 })
const state = await service.getState()
ok(state.feeds.length === entries.length, 'every entry is a source the reader sees', state.feeds.length)
ok(state.items.some((item) => item.id === 'alpha-1'),
  'and rows fetched under a derived id belong to the entry that never named one', state.items.map((item) => item.id))
ok(state.feeds.find((feed) => feed.url === EXOTIC).id === 'Exotic_Feed-',
  'the exotic id reaches the page as written, so its rows stay addressable', state.feeds.map((feed) => feed.id))
const dups = state.feeds.filter((feed) => feed.url === DUP).map((feed) => feed.id)
ok(dups.length === 2 && dups[0] !== dups[1], 'two entries for one URL stay two sources with two ids', dups)

// --- and the id the page holds is the id the service acts on ---
const removed = await service.removeFeed('Exotic_Feed-')
ok(removed.ok === true && removed.removed === 'Exotic_Feed-', 'the stored id addresses its own entry', removed)
const left = await readFeeds(root)
ok(left.length === entries.length - 1 && !left.some((feed) => feed.id === 'Exotic_Feed-'),
  'and removes that entry, not another one', left.map((feed) => feed.id))
const rewritten = JSON.parse(readFileSync(path.join(root, 'feeds.json'), 'utf8')).feeds
ok(rewritten.every((entry) => typeof entry.id === 'string' && entry.id.length > 0),
  'a written list carries the ids the archive is keyed by', rewritten.map((entry) => entry.id))

service.dispose()
removeRoot(root)
finish()
