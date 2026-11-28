// The reader's Host state machine: committed items plus the local refresh
// cache, read/star state, subscriptions, git actions, and the job runner.

import crypto from 'node:crypto'
import { stat } from 'node:fs/promises'
import { readFeeds } from './feeds.js'
import { readGitInfo } from './git.js'
import { readRepoConfig } from './settings.js'
import { kindOf } from './custom.js'
import { interestOf, seedFromStars } from './interest.js'
import type { LiveSnapshot } from './live.js'
import { listShards, readJson, readNdjson } from './store.js'
import type { ReaderStateData, RepoConfig } from './types.js'
import type { FeedDefinition } from './types.js'
import type { GitInfo, Feed, Item, SourceKind } from '../shared/types.js'
import type { StreamFrame } from '../shared/stream.js'
import { PROBE_MS, PROTOCOL } from '../shared/stream.js'
import { messageOf } from '../shared/errors.js'


import { GIT_FACTS_MS, SEARCH_CHUNK } from './service-core.js'
import type { MetaEntry, ServiceRecord, StateResponse } from './service-core.js'
import { compareItems, plainText } from './service-core.js'


export function serialize<T>(rec: ServiceRecord, task: () => Promise<T>): Promise<T> {
  const run = rec.writeQueue.then(task, task)
  // The queue only decides what runs next; a failed task is answered to the
  // caller that asked for it, so its outcome is not the chain's to carry.
  rec.writeQueue = run.then(chainStep, chainStep)
  return run
}

export function touch(rec: ServiceRecord) {
  rec.runner.touch()
}

export function invalidateItems(rec: ServiceRecord) {
  rec.itemsCache = { version: null, items: null }
}

export function invalidate(rec: ServiceRecord) {
  invalidateItems(rec)
  invalidateGit(rec)
}

export function invalidateGit(rec: ServiceRecord) {
  rec.gitCache = { at: 0, value: null }
  rec.gitFacts = null
}

function chainStep(): void { /* the outcome is not the queue's */ }

async function readSnapshot(
  rec: ServiceRecord, cfg: RepoConfig, recomputeGit: boolean, signal?: AbortSignal,
): Promise<LiveSnapshot> {
  signal?.throwIfAborted()
  const version = await fileVersion(rec)
  signal?.throwIfAborted()
  const model = await buildItems(rec)
  const data = await buildSnapshot(rec, cfg, model.items)
  return {
    version: version,
    itemsVersion: digestVersion(rec, model.version, data.feeds),
    items: data.items,
    read: data.read,
    starred: data.starred,
    feeds: data.feeds,
    reader: data.reader,
    interest: data.interest,
    git: await currentGit(rec, recomputeGit),
    schedule: await rec.runner.status(),
    repo: rec.root,
    allowGit: rec.allowGit,
  }
}

export async function refresh(rec: ServiceRecord, options?: { force?: boolean; git?: boolean }): Promise<void> {
  return serialize(rec, async function () {
    if (rec.disposed) return
    try {
      const held = rec.live.info()
      // A cheap look decides whether a rebuild is worth it at all; the
      // snapshot itself measures the version it actually read.
      if (!options?.force && held && held.version === await fileVersion(rec)) return
      const next = await readSnapshot(rec, settings(rec), options?.git === true || held === null)
      rec.live.apply(next)
    } catch (err) {
      rec.logger.warn(`gitfeed: could not refresh the reader: ${messageOf(err)}`)
    }
  })
}

function armProbe(rec: ServiceRecord): void {
  if (rec.probeWaker || rec.disposed || rec.attached === 0) return
  rec.probeWaker = rec.timers.timeout(function () {
    rec.probeWaker = null
    void probe(rec).finally(function () { armProbe(rec) })
  }, PROBE_MS)
}

export function disarmProbe(rec: ServiceRecord): void {
  if (!rec.probeWaker) return
  rec.probeWaker()
  rec.probeWaker = null
}

async function probe(rec: ServiceRecord): Promise<void> {
  if (rec.disposed || rec.attached === 0) return
  touch(rec)
  try {
    const version = await fileVersion(rec)
    const held = rec.live.info()
    if (held && held.version === version) return
    await refresh(rec)
  } catch (err) {
    rec.logger.warn(`gitfeed: could not probe ${rec.root}: ${messageOf(err)}`)
  }
}

export async function* frames(rec: ServiceRecord, rev: number, signal: AbortSignal): AsyncGenerator<StreamFrame> {
  rec.attached += 1
  armProbe(rec)
  try {
    if (!rec.live.info()) await refresh(rec, { force: true, git: true })
    if (!rec.live.info()) {
      yield { t: 'error', protocol: PROTOCOL, message: `gitfeed: ${rec.root} has no readable feeds.json` }
      return
    }
    let cursor = rev
    // A function, not a narrowed `let`: both of these change from outside the
    // generator, and an inlined check would be folded to its first value.
    const stopped = function (): boolean { return rec.disposed || signal.aborted }
    while (!stopped()) {
      const batch = rec.live.framesAfter(cursor)
      if (batch.length === 0) {
        await rec.live.changed(cursor, signal)
        continue
      }
      for (const frame of batch) {
        if (stopped()) return
        if (frame.t !== 'error') cursor = frame.rev
        yield frame
      }
    }
  } finally {
    rec.attached -= 1
    if (rec.attached === 0) disarmProbe(rec)
  }
}

export function settings(rec: ServiceRecord): RepoConfig {
  return readRepoConfig(rec.root)
}

async function statVersion(rec: ServiceRecord, files: string[]): Promise<string> {
  const hash = crypto.createHash('sha1')
  for (const file of files) {
    try {
      const info = await stat(file)
      hash.update(`${file}:${info.size}:${info.mtimeMs}\n`)
    } catch {
      hash.update(`${file}:missing\n`)
    }
  }
  return hash.digest('hex')
}

async function itemShards(rec: ServiceRecord): Promise<string[]> {
  return (await listShards(rec.paths.items)).concat(await listShards(rec.paths.localItems))
}

export async function fileVersion(rec: ServiceRecord): Promise<string> {
  const files = [rec.paths.config, rec.paths.feeds, rec.paths.meta, rec.paths.read, rec.paths.starred, rec.paths.localMeta]
  let feedsExists = true
  try {
    await stat(rec.paths.feeds)
  } catch {
    feedsExists = false
  }
  if (!feedsExists) return 'uninitialized'
  files.push(...await itemShards(rec))
  return statVersion(rec, files)
}

function snapshotFeed(rec: ServiceRecord, f: FeedDefinition, m: MetaEntry): Feed {
  let kind: SourceKind = 'rss'
  try {
    kind = kindOf(f)
  } catch {
    // A declaration this version cannot read is that feed's error to report,
    // not the reader's: the fetch writes the complaint into meta.lastError and
    // the row renders with it, instead of every /state call failing.
    kind = 'rss'
  }
  return {
    id: f.id,
    title: m.title || f.title || f.id,
    folder: f.folder || m.folder || null,
    siteUrl: m.siteUrl || null,
    url: f.url || m.url || null,
    error: m.lastError || null,
    checkedAt: m.checkedAt || null,
    kind: kind,
  }
}

async function shardStamp(rec: ServiceRecord, file: string): Promise<string> {
  try {
    const info = await stat(file)
    return `${info.size}:${info.mtimeMs}`
  } catch {
    return 'missing'
  }
}

export async function archivedLengths(rec: ServiceRecord): Promise<Map<string, number>> {
  const { items } = await buildItems(rec)
  const known = new Map<string, number>()
  for (const item of items) known.set(item.id, (item.summary || '').length)
  return known
}

async function buildItems(rec: ServiceRecord): Promise<{ version: string; items: Item[] }> {
  const shards = await itemShards(rec)
  // The same fingerprint the state version uses, computed in the one pass that
  // also decides which shards still need parsing.
  const hash = crypto.createHash('sha1')
  const stamps = new Map<string, string>()
  for (const file of shards) {
    const stamp = await shardStamp(rec, file)
    stamps.set(file, stamp)
    hash.update(`${file}:${stamp}\n`)
  }
  const version = hash.digest('hex')
  if (rec.itemsCache.version === version && rec.itemsCache.items) return { version: version, items: rec.itemsCache.items }

  const items: Item[] = []
  /** id -> index in `items`, so a later copy can replace an earlier one. */
  const at = new Map<string, number>()
  for (const file of shards) {
    const stamp = stamps.get(file) || 'missing'
    let parsed = rec.shardRows.get(file)
    if (!parsed || parsed.stamp !== stamp) {
      const rows: Item[] = []
      for (const row of await readNdjson<Item | null>(file)) {
        if (!row || !row.id || !row.date) continue
        rows.push(row)
      }
      parsed = { stamp: stamp, rows: rows }
      rec.shardRows.set(file, parsed)
    }
    for (const row of parsed.rows) {
      const index = at.get(row.id)
      if (index === undefined) {
        at.set(row.id, items.length)
        items.push(row)
        continue
      }
      // Both stores can hold the same id: a repair lengthens the copy in the
      // cache while the committed one came first, and a repair only ever
      // grows a summary, so the longer copy is the one that was repaired.
      if ((row.summary || '').length > (items[index].summary || '').length) items[index] = row
    }
  }
  // A shard that is gone — pruned by retention, or a cache file removed — is
  // not a shard any more; keeping its rows would resurrect deleted items.
  const live = new Set(shards)
  for (const file of Array.from(rec.shardRows.keys())) if (!live.has(file)) rec.shardRows.delete(file)
  items.sort(compareItems)
  rec.itemsCache = { version: version, items: items }
  return { version: version, items: items }
}

export async function gitInfo(rec: ServiceRecord): Promise<GitInfo> {
  if (rec.gitCache.value && Date.now() - rec.gitCache.at < 30000) return rec.gitCache.value
  const value = await readGitInfo(rec.root)
  rec.gitCache = { at: Date.now(), value: value }
  return value
}

export async function currentGit(rec: ServiceRecord, recompute: boolean): Promise<GitInfo | null> {
  const recent = rec.gitFacts !== null && Date.now() - rec.gitFacts.at < GIT_FACTS_MS
  if (!recompute && recent && rec.gitFacts) return rec.gitFacts.value
  const value = await gitInfo(rec)
  rec.gitFacts = { at: Date.now(), value: value }
  return value
}

function digestVersion(rec: ServiceRecord, modelVersion: string, feeds: Feed[]): string {
  const hash = crypto.createHash('sha1')
  hash.update(modelVersion)
  for (const id of feeds.map(function (feed) { return feed.id }).sort()) hash.update(`\u0000${id}`)
  return hash.digest('hex')
}

function titlesSignature(rec: ServiceRecord, titles: Map<string, string>): string {
  const hash = crypto.createHash('sha1')
  for (const id of Array.from(titles.keys()).sort()) hash.update(`${id}\u0000${titles.get(id) || ''}\n`)
  return hash.digest('hex')
}

function yieldToLoop(rec: ServiceRecord): Promise<void> {
  return new Promise(function (resolve) {
    rec.timers.timeout(function () { resolve() }, 0)
  })
}

async function searchableTexts(
  rec: ServiceRecord, items: readonly Item[], titles: Map<string, string>, signal?: AbortSignal,
): Promise<Map<string, string>> {
  const signature = titlesSignature(rec, titles)
  const rebuildAll = rec.searchTexts === null || signature !== rec.searchTitles
  if (rebuildAll) {
    rec.searchTexts = new Map()
    rec.searchTitles = signature
  }
  const texts = rec.searchTexts as Map<string, string>
  const todo: Item[] = []
  const live = new Set<string>()
  for (const item of items) {
    live.add(item.id)
    if (rebuildAll || !texts.has(item.id)) todo.push(item)
  }
  if (!rebuildAll) for (const id of texts.keys()) if (!live.has(id)) texts.delete(id)
  for (let i = 0; i < todo.length; i++) {
    signal?.throwIfAborted()
    const item = todo[i]
    texts.set(item.id, `${item.title} ${plainText(item.summary)} ${titles.get(item.feed) || item.feed}`.toLowerCase())
    if (i % SEARCH_CHUNK === SEARCH_CHUNK - 1) await yieldToLoop(rec)
  }
  return texts
}

export async function itemBody(rec: ServiceRecord, id: unknown): Promise<Item | null> {
  const key = typeof id === 'string' ? id : ''
  if (!key) return null
  const { items } = await buildItems(rec)
  return items.find(function (item) { return item.id === key }) || null
}

export async function search(rec: ServiceRecord, query: unknown, signal?: AbortSignal): Promise<{ ids: string[] }> {
  touch(rec)
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!needle) return { ids: [] }
  signal?.throwIfAborted()
  const model = await buildItems(rec)
  signal?.throwIfAborted()
  // The digest is the searchable shelf: a row whose source is no longer
  // followed is in neither, so a hit is always a row the list can show.
  const data = await buildSnapshot(rec, settings(rec), model.items)
  const shown = data.items
  const titles = new Map<string, string>(data.feeds.map(function (feed): [string, string] { return [feed.id, feed.title] }))
  const texts = await searchableTexts(rec, shown, titles, signal)
  signal?.throwIfAborted()
  const ids: string[] = []
  for (const item of shown) {
    const text = texts.get(item.id)
    if (text !== undefined && text.indexOf(needle) !== -1) ids.push(item.id)
  }
  return { ids: ids }
}

async function buildSnapshot(rec: ServiceRecord, cfg: RepoConfig, items: Item[]): Promise<ReaderStateData> {
  // The digest is the archive of the sources the reader follows. A row whose
  // source left the subscription list is still in the stores — an unsubscribe
  // is a statement about future updates, not a deletion — but it is not
  // something the reader is asked to look at, and a section with no entry
  // behind it cannot even be named.
  const subscribed = await readFeeds(rec.root)
  const followed = new Set(subscribed.map(function (feed) { return feed.id }))
  const shown = items.filter(function (item) { return followed.has(item.feed) })
  const read: string[] = []
  for (const row of await readNdjson<{ id: string } | null>(rec.paths.read)) if (row && row.id) read.push(row.id)
  const starred: string[] = []
  for (const row of await readNdjson<{ id: string } | null>(rec.paths.starred)) if (row && row.id) starred.push(row.id)

  const dataMeta = await readJson<Record<string, MetaEntry | undefined>>(rec.paths.meta, {})
  const localMeta = await readJson<Record<string, MetaEntry | undefined>>(rec.paths.localMeta, {})
  const meta: Record<string, MetaEntry | undefined> = {}
  const metaIds = new Set(Object.keys(dataMeta).concat(Object.keys(localMeta)))
  for (const id of metaIds) {
    const d: MetaEntry = dataMeta[id] || {}
    const l: MetaEntry = localMeta[id] || {}
    // The store whose check ran last describes the feed: the plugin fetches
    // into the cache, so preferring the committed copy meant an upstream
    // rename could never reach the sidebar. Fields it cannot fill fall back to
    // the other store, but an absent error stays absent — a later successful
    // check is what clears a failure.
    const localWins = (l.checkedAt || '') > (d.checkedAt || '')
    const newer: MetaEntry = localWins ? l : d
    const older: MetaEntry = localWins ? d : l
    meta[id] = {
      title: newer.title || older.title || null,
      folder: newer.folder || older.folder || null,
      siteUrl: newer.siteUrl || older.siteUrl || null,
      url: newer.url || older.url || null,
      lastError: newer.lastError || null,
      checkedAt: newer.checkedAt || older.checkedAt || null,
    }
  }

  const feeds = subscribed.map(function (f) { return snapshotFeed(rec, f, meta[f.id] || {}) })

  // The acts that say which sources the reader reads, decayed to now. The
  // first build of a root that predates the log seeds it from the stars, which
  // are the one explicit interest the archive already holds.
  const now = Date.now()
  await seedFromStars(rec.paths.interest, starred, shown, now)
  const interest = await interestOf(rec.paths.interest, now)

  const data: ReaderStateData = {
    items: shown,
    read: read,
    starred: starred,
    feeds: feeds,
    reader: cfg.reader,
    interest: interest,
    repo: rec.root,
    allowGit: rec.allowGit,
  }
  return data
}

export async function getState(
  rec: ServiceRecord, knownVersion?: string, knownItemsVersion?: string, signal?: AbortSignal,
): Promise<StateResponse> {
  touch(rec)
  const version = await fileVersion(rec)
  signal?.throwIfAborted()
  let cfg
  try {
    cfg = settings(rec)
  } catch (err) {
    return {
      version: version,
      error: messageOf(err),
      items: [], read: [], starred: [], feeds: [],
      reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
      git: await gitInfo(rec),
      schedule: await rec.runner.status(),
      repo: rec.root,
      allowGit: rec.allowGit,
      generatedAt: new Date().toISOString(),
    }
  }
  const base = {
    version: version,
    // A poll that finds nothing new reuses the facts of the last read; the
    // git subprocesses are not worth running for a status line.
    git: await currentGit(rec, false),
    schedule: await rec.runner.status(),
    repo: rec.root,
    allowGit: rec.allowGit,
    generatedAt: new Date().toISOString(),
  }
  if (version === 'uninitialized') {
    return Object.assign({}, base, {
      error: `gitfeed: no feeds.json in ${rec.root} — point config.repo at a gitfeed data rec.root, or let the bundle seed an empty directory`,
      items: [], read: [], starred: [], feeds: [], reader: cfg.reader,
    })
  }
  if (knownVersion && knownVersion === version) return Object.assign({ unchanged: true }, base)
  signal?.throwIfAborted()
  const model = await buildItems(rec)
  signal?.throwIfAborted()
  const data = await buildSnapshot(rec, cfg, model.items)
  const itemsVersion = digestVersion(rec, model.version, data.feeds)
  // A reader that loaded over HTTP then opens the stream must be caught up
  // from the same copy the stream holds, so this read feeds the live state too.
  rec.live.apply({
    version: version,
    itemsVersion: itemsVersion,
    items: data.items,
    read: data.read,
    starred: data.starred,
    feeds: data.feeds,
    reader: data.reader,
    interest: data.interest,
    git: base.git,
    schedule: base.schedule,
    repo: rec.root,
    allowGit: rec.allowGit,
  })
  if (knownItemsVersion && knownItemsVersion === itemsVersion) {
    // The reader already holds this item model: send the marks and feeds that
    // moved, and a flag instead of thousands of unchanged rows.
    return Object.assign({}, base, data, {
      itemsVersion: itemsVersion,
      itemsUnchanged: true,
      items: undefined,
    })
  }
  return Object.assign({}, base, data, { itemsVersion: itemsVersion })
}

export async function snapshotNow(rec: ServiceRecord): Promise<{ cfg: RepoConfig; version: string; data: ReaderStateData }> {
  const version = await fileVersion(rec)
  if (version === 'uninitialized') throw new Error(`gitfeed: no feeds.json in ${rec.root}`)
  const cfg = settings(rec)
  const model = await buildItems(rec)
  return { cfg: cfg, version: version, data: await buildSnapshot(rec, cfg, model.items) }
}
