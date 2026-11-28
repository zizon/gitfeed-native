// The reader's Host state machine: committed items plus the local refresh
// cache, read/star state, subscriptions, git actions, and the job runner.



import type { ListToolInput, ServiceRecord } from './service-core.js'
import { plainText } from './service-core.js'
import { currentGit, snapshotNow } from './service-snapshot.js'


export async function listForTool(rec: ServiceRecord, input: ListToolInput | null | undefined) {
  const opts: ListToolInput = input || {}
  const { data } = await snapshotNow(rec)
  const query = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : ''
  const feedId = typeof opts.feed === 'string' ? opts.feed.trim() : typeof opts.feedId === 'string' ? opts.feedId.trim() : ''
  const unreadOnly = opts.unreadOnly === true
  const starredOnly = opts.starredOnly === true
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 30))
  const readSet = new Set(data.read)
  const starredSet = new Set(data.starred)
  const feedNames = new Map<string, string>(data.feeds.map(function (f): [string, string] { return [f.id, f.title] }))
  const hits = []
  for (const item of data.items) {
    if (feedId && item.feed !== feedId) continue
    if (unreadOnly && readSet.has(item.id)) continue
    if (starredOnly && !starredSet.has(item.id)) continue
    if (query) {
      const hay = (`${item.title} ${plainText(item.summary)} ${feedNames.get(item.feed) || item.feed}`).toLowerCase()
      if (hay.indexOf(query) === -1) continue
    }
    hits.push({
      id: item.id,
      title: item.title,
      feed: item.feed,
      feedTitle: feedNames.get(item.feed) || item.feed,
      date: item.date,
      link: item.link || null,
      unread: !readSet.has(item.id),
      starred: starredSet.has(item.id),
      summary: plainText(item.summary).slice(0, 240),
    })
    if (hits.length >= limit) break
  }
  return {
    returned: hits.length,
    unread: data.items.reduce(function (n, item) { return readSet.has(item.id) ? n : n + 1 }, 0),
    feeds: data.feeds.length,
    items: hits,
  }
}

export async function getForTool(rec: ServiceRecord, id: string) {
  const { data } = await snapshotNow(rec)
  const item = data.items.find(function (candidate) { return candidate.id === id })
  if (!item) throw new Error(`no item with id ${id}`)
  const readSet = new Set(data.read)
  const starredSet = new Set(data.starred)
  return {
    id: item.id,
    title: item.title,
    feed: item.feed,
    date: item.date,
    link: item.link || null,
    author: item.author || null,
    unread: !readSet.has(item.id),
    starred: starredSet.has(item.id),
    summary: plainText(item.summary).slice(0, 12000),
  }
}

export async function statusForTool(rec: ServiceRecord) {
  const { data, version } = await snapshotNow(rec)
  const readSet = new Set(data.read)
  const unread = data.items.reduce(function (n, item) { return readSet.has(item.id) ? n : n + 1 }, 0)
  // The folder names travel with the counts: a caller that moves a feed has
  // no datalist to pick from, so the names it could move it to are the ones
  // already in use rather than a spelling of its own.
  const folders = new Map<string, number>()
  for (const feed of data.feeds) {
    const name = feed.folder || 'Uncategorized'
    folders.set(name, (folders.get(name) || 0) + 1)
  }
  return {
    repo: rec.root,
    version: version,
    feeds: data.feeds.length,
    folders: Array.from(folders.entries())
      .sort(function (a, b) { return a[0].localeCompare(b[0]) })
      .map(function (entry) { return { name: entry[0], feeds: entry[1] } }),
    items: data.items.length,
    unread: unread,
    starred: data.starred.length,
    failingFeeds: data.feeds.filter(function (f) { return !!f.error }).length,
    git: await currentGit(rec, true),
    schedule: await rec.runner.status(),
    allowGit: rec.allowGit,
  }
}
