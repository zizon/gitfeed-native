// The reader's Host state machine: committed items plus the local refresh
// cache, read/star state, subscriptions, git actions, and the job runner.

import crypto from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { feedIdFor, normalizeUrl, readFeeds, resolveFeed, sourceUrl, writeFeeds } from './feeds.js'
import { loadRuntimeFeeds, runFetch } from './fetch.js'
import { pull as pullRemote, readGitInfo, sync as syncRemote } from './git.js'
import { createFetchJob, createSyncJob } from './jobs.js'
import { createJobRunner } from './runner.js'
import type { JobRunner, JobTimers } from './runner.js'
import { pathsFor, readRepoConfig } from './settings.js'
import { declarationOf, kindOf, scriptFile } from './custom.js'
import { appendNdjson, listShards, readJson, readNdjson, updateNdjson } from './store.js'
import type { FetchResult, GitActionResult, Logger, ReaderStateData, ReadyState, RepoConfig } from './types.js'
import type { FeedDefinition } from './types.js'
import type { GitInfo, Feed, Item, SourceKind } from '../shared/types.js'
import { messageOf } from '../shared/errors.js'
import { decodeEntities } from './xml.js'

/** A local mark is pushed after this much quiet, so scrolling marks coalesce. */
const AUTO_SYNC_DEBOUNCE_MS = 20000
/** Longest a continuously marking reader waits before a sync. */
const AUTO_SYNC_MAX_WAIT_MS = 5 * 60000

export type StateResponse = Omit<ReadyState, keyof ReaderStateData> & Partial<ReaderStateData>

export interface GitfeedOptions {
  root: string
  logger?: Logger
  /** Where the jobs' wake-ups come from: the Host's timer service. */
  timers: JobTimers
  refreshMinutes?: number
  idleMinutes?: number
  allowGit?: boolean
  adaptive?: boolean
  maxIntervalMinutes?: number
  /** Minutes between read-state syncs; 0 disables auto-sync. */
  syncMinutes?: number
  /** Ceiling of the sync backoff. */
  syncMaxMinutes?: number
}

interface MetaEntry {
  title?: string | null
  folder?: string | null
  siteUrl?: string | null
  url?: string | null
  lastError?: string | null
  checkedAt?: string | null
}

interface ListToolInput {
  query?: unknown
  feed?: unknown
  feedId?: unknown
  unreadOnly?: unknown
  starredOnly?: unknown
  limit?: unknown
}

/** A feed body as plain text, stripped first and decoded with the parser's own
 * table: the agent's search then finds the same `&mdash;` and numeric
 * references the reader's search does. */
function plainText(html: string | null | undefined): string {
  return decodeEntities((html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function checkedIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const clean: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || id.length >= 64) continue
    clean.push(id)
  }
  return clean
}

/**
 * Newest first, with the id as a tie-break: two items that share a timestamp
 * would otherwise keep whatever order the shards happened to read in, and a
 * refresh could swap them under the reader.
 */
function compareItems(a: Item, b: Item): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/**
 * Create the Host-side reader for one checkout.
 * @param {object} options
 * @param {string} options.root absolute gitfeed checkout.
 * @param {{info:Function, warn:Function, error:Function}} [options.logger]
 * @returns {object} reader surface used by the HTTP API and the agent tool.
 */
export function createGitfeed(options: GitfeedOptions) {
  const root = options.root
  const logger = options.logger || console
  const paths = pathsFor(root)
  const refreshMinutes = Number.isFinite(Number(options.refreshMinutes)) ? Math.max(0, Number(options.refreshMinutes)) : 0
  const idleMinutes = Number(options.idleMinutes) > 0 ? Number(options.idleMinutes) : 15
  const allowGit = options.allowGit !== false
  const adaptive = options.adaptive !== false
  const maxIntervalMinutes = Number.isFinite(Number(options.maxIntervalMinutes))
    ? Math.max(1, Number(options.maxIntervalMinutes))
    : 1440
  const syncMinutes = Number.isFinite(Number(options.syncMinutes)) ? Math.max(0, Number(options.syncMinutes)) : 10
  const syncMaxMinutes = Number.isFinite(Number(options.syncMaxMinutes))
    ? Math.max(1, Number(options.syncMaxMinutes))
    : 60

  /**
   * The item model has its own version: read and star marks bump the state
   * version without touching the items, and re-reading, re-sorting, and
   * re-sending thousands of rows because a mark landed is what made polling
   * expensive. The client sends this back, so an unchanged model travels as a
   * flag instead of a payload.
   */
  let itemsCache: { version: string | null; items: Item[] | null } = { version: null, items: null }
  let gitCache: { at: number; value: GitInfo | null } = { at: 0, value: null }
  let writeQueue = Promise.resolve()
  let disposed = false

  function touch() {
    runner.touch()
  }

  /** Drop what a fetch, a subscription change, or a git action invalidates. */
  function invalidate() {
    itemsCache = { version: null, items: null }
    gitCache = { at: 0, value: null }
  }

  /**
   * Drop only what a mark can move. Read and star ids are not part of the item
   * model — that is what the separate itemsVersion is for — so a mark must not
   * make the next payload re-read, re-filter, and re-sort every shard.
   */
  function invalidateGit() {
    gitCache = { at: 0, value: null }
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(task, task)
    writeQueue = run.then(function () { }, function () { })
    return run
  }

  function settings(): RepoConfig {
    return readRepoConfig(root)
  }

  /** A stable fingerprint of the named files, by size and modification time. */
  async function statVersion(files: string[]): Promise<string> {
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

  /** Item shards in a fixed order: committed data first, then the local cache. */
  async function itemShards(): Promise<string[]> {
    return (await listShards(paths.items)).concat(await listShards(paths.localItems))
  }

  async function fileVersion(): Promise<string> {
    const files = [paths.config, paths.feeds, paths.meta, paths.read, paths.starred, paths.localMeta]
    let feedsExists = true
    try {
      await stat(paths.feeds)
    } catch {
      feedsExists = false
    }
    if (!feedsExists) return 'uninitialized'
    files.push(...await itemShards())
    return statVersion(files)
  }

  function snapshotFeed(f: FeedDefinition, m: MetaEntry): Feed {
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

  /** The item model, read from disk only when its own fingerprints moved. */
  async function buildItems(): Promise<{ version: string; items: Item[] }> {
    const shards = await itemShards()
    const version = await statVersion(shards)
    if (itemsCache.version === version && itemsCache.items) return { version: version, items: itemsCache.items }

    const items: Item[] = []
    /** id -> index in `items`, so a later copy can replace an earlier one. */
    const at = new Map<string, number>()
    for (const file of shards) {
      const rows = await readNdjson<Item | null>(file)
      for (const row of rows) {
        if (!row || !row.id || !row.date) continue
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
    items.sort(compareItems)
    itemsCache = { version: version, items: items }
    return { version: version, items: items }
  }

  async function gitInfo(): Promise<GitInfo> {
    if (gitCache.value && Date.now() - gitCache.at < 3000) return gitCache.value
    const value = await readGitInfo(root)
    gitCache = { at: Date.now(), value: value }
    return value
  }

  async function buildSnapshot(cfg: RepoConfig, items: Item[]): Promise<ReaderStateData> {
    const read: string[] = []
    for (const row of await readNdjson<{ id: string } | null>(paths.read)) if (row && row.id) read.push(row.id)
    const starred: string[] = []
    for (const row of await readNdjson<{ id: string } | null>(paths.starred)) if (row && row.id) starred.push(row.id)

    const dataMeta = await readJson<Record<string, MetaEntry | undefined>>(paths.meta, {})
    const localMeta = await readJson<Record<string, MetaEntry | undefined>>(paths.localMeta, {})
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

    const subscribed = await readFeeds(root)
    const feeds = subscribed.map(function (f) { return snapshotFeed(f, meta[f.id] || {}) })

    const data: ReaderStateData = {
      items: items,
      read: read,
      starred: starred,
      feeds: feeds,
      reader: cfg.reader,
      repo: root,
      allowGit: allowGit,
    }
    return data
  }

  /**
   * Read the complete reader state, or only its volatile facts when the caller
   * already holds this version, or the item model when the caller already holds
   * that model's version.
   * @param {string} [knownVersion] state version the caller rendered last.
   * @param {string} [knownItemsVersion] item-model version the caller holds.
   * @returns {Promise<object>} state payload.
   */
  async function getState(knownVersion?: string, knownItemsVersion?: string): Promise<StateResponse> {
    touch()
    const version = await fileVersion()
    let cfg
    try {
      cfg = settings()
    } catch (err) {
      return {
        version: version,
        error: messageOf(err),
        items: [], read: [], starred: [], feeds: [],
        reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
        git: await gitInfo(),
        schedule: await runner.status(),
        repo: root,
        allowGit: allowGit,
        generatedAt: new Date().toISOString(),
      }
    }
    const base = {
      version: version,
      git: await gitInfo(),
      schedule: await runner.status(),
      repo: root,
      allowGit: allowGit,
      generatedAt: new Date().toISOString(),
    }
    if (version === 'uninitialized') {
      return Object.assign({}, base, {
        error: `gitfeed: no feeds.json in ${root} — point config.repo at a gitfeed data root, or let the bundle seed an empty directory`,
        items: [], read: [], starred: [], feeds: [], reader: cfg.reader,
      })
    }
    if (knownVersion && knownVersion === version) return Object.assign({ unchanged: true }, base)
    const model = await buildItems()
    const data = await buildSnapshot(cfg, model.items)
    if (knownItemsVersion && knownItemsVersion === model.version) {
      // The reader already holds this item model: send the marks and feeds that
      // moved, and a flag instead of thousands of unchanged rows.
      return Object.assign({}, base, data, {
        itemsVersion: model.version,
        itemsUnchanged: true,
        items: undefined,
      })
    }
    return Object.assign({}, base, data, { itemsVersion: model.version })
  }

  async function setState(file: string, ids: unknown, value: boolean): Promise<number> {
    return serialize(async function () {
      const clean = checkedIds(ids)
      if (clean.length === 0) return 0
      if (value) {
        // Additive, and the append is ordered behind any rewrite of this file:
        // a row already there is not written twice.
        const have = new Set((await readNdjson<{ id: string }>(file)).map(function (r) { return r.id }))
        const add: Array<{ id: string }> = []
        for (const id of clean) {
          if (have.has(id)) continue
          have.add(id)
          add.push({ id: id })
        }
        await appendNdjson(file, add)
        return add.length
      }
      // Removing filters the rows it reads, so the whole step holds the file's
      // write queue: a fetch appending between the read and the write would
      // lose that row.
      const drop = new Set(clean)
      let changed = 0
      await updateNdjson<{ id: string }>(file, function (rows) {
        const kept = rows.filter(function (r) { return !drop.has(r.id) })
        changed = rows.length - kept.length
        return changed === 0 ? null : kept
      })
      return changed
    })
  }

  /**
   * Mark items read or unread.
   * @param {string[]} ids item ids.
   * @param {boolean} read target state.
   * @returns {Promise<{ok:boolean, changed:number, version:string}>} settled result.
   */
  async function mark(ids: unknown, read: boolean): Promise<{ ok: boolean; changed: number; version: string }> {
    touch()
    const changed = await setState(paths.read, ids, read)
    invalidateGit()
    if (changed > 0) syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
    return { ok: true, changed: changed, version: await fileVersion() }
  }

  /**
   * Star or unstar items.
   * @param {string[]} ids item ids.
   * @param {boolean} starred target state.
   * @returns {Promise<{ok:boolean, changed:number, version:string}>} settled result.
   */
  async function star(ids: unknown, starred: boolean): Promise<{ ok: boolean; changed: number; version: string }> {
    touch()
    const changed = await setState(paths.starred, ids, starred)
    invalidateGit()
    if (changed > 0) syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
    return { ok: true, changed: changed, version: await fileVersion() }
  }

  async function ensureLocalMeta(): Promise<void> {
    await mkdir(paths.localItems, { recursive: true })
    try {
      await stat(paths.localMeta)
    } catch {
      try {
        await copyFile(paths.meta, paths.localMeta)
      } catch {
        // no committed meta yet; the first run just takes longer
      }
    }
  }

  // The runner owns every periodic run: the fetch job's per-feed clocks
  // and the sync job's push/pull debounce both live here, not in a timer.
  const runner: JobRunner = createJobRunner({
    root: root,
    logger: logger,
    idleMinutes: idleMinutes,
    timers: options.timers,
    onRun: invalidate,
  })

  const refreshJob = runner.add(createFetchJob({
    refreshMinutes: refreshMinutes,
    maxIntervalMinutes: maxIntervalMinutes,
    adaptive: adaptive,
    idleMinutes: idleMinutes,
    loadFeeds: function () { return loadRuntimeFeeds(root) },
    fetch: async function (scope) {
      if (disposed) throw new Error('gitfeed is unloading')
      await ensureLocalMeta()
      return runFetch({ root: root, dataDir: '.local', only: scope.only, feeds: scope.feeds })
    },
  }))

  const syncJob = runner.add(createSyncJob({
    allowGit: allowGit,
    syncMinutes: syncMinutes,
    maxIntervalMinutes: syncMaxMinutes,
    gitInfo: gitInfo,
    pull: function () { return pullRemote(root) },
    sync: function () { return syncRemote(root) },
    version: fileVersion,
  }))

  /**
   * Run the fetcher into the gitignored `.local/` cache.
   * @param {{only?: string, feeds?: string[], all?: boolean}} [opts] restrict the run; the default is every feed.
   * @returns {Promise<object>} fetcher result.
   */
  async function runLocalFetch(opts?: { only?: string; feeds?: string[]; all?: boolean }): Promise<FetchResult> {
    touch()
    const run = await refreshJob.runNow(opts || { all: true })
    if (run.value) return run.value as FetchResult
    throw new Error(run.outcome.summary || 'fetch failed')
  }

  /**
   * Subscribe to a feed URL, or to a site URL whose feed is discovered.
   *
   * With a `source` declaration the URL is taken as given: the spec is the
   * recipe, so there is no page to look for a feed tag on, and validation here
   * is what discovery would have been.
   * @param {{url?: string, folder?: string, title?: string, source?: unknown}} input subscription request.
   * @returns {Promise<object>} the new feed entry.
   */
  async function addFeed(
    input: {
      url?: string
      folder?: string
      title?: string
      type?: string
      script?: string
      options?: unknown
    } | null | undefined,
  ): Promise<FeedDefinition> {
    touch()
    const raw = (input?.url || '').trim()
    if (!raw) throw new Error('a feed or site URL is required')
    // A custom feed is its own recipe: validating the declaration is what
    // discovery would have been, and the URL is taken as given.
    const declared = declarationOf({ type: input?.type, script: input?.script, options: input?.options })
    const resolved = declared === null
      ? await resolveFeed(raw)
      : { url: sourceUrl(raw), title: (input?.title || '').trim() || null, items: 0 }
    // Resolved before the subscription exists: a missing script is a rejected
    // add, not a red row the user has to unsubscribe from.
    if (declared !== null) await scriptFile(root, declared.script)

    // The subscription list is read-modify-write, so the whole step queues
    // behind every other one: two subscribes at once would otherwise both read
    // the same list and the second would drop the first. Discovery is done
    // above, outside the queue, so a slow site does not hold it.
    const entry = await serialize(async function () {
      const feeds = await readFeeds(root)
      const key = normalizeUrl(resolved.url)
      for (const f of feeds) {
        if (normalizeUrl(f.url) === key) throw new Error(`already subscribed to ${resolved.url}`)
      }

      let id = feedIdFor(resolved.url)
      const used = new Set(feeds.map(function (f) { return f.id }))
      const base = id
      let n = 2
      while (used.has(id)) id = `${base}-${n++}`

      const folder = (input?.folder || '').trim() || 'Uncategorized'
      const added: FeedDefinition = { id: id, url: resolved.url, title: resolved.title || id, folder: folder }
      // Stored as written: it stays readable in feeds.json, and the script is
      // the user's, so it is never copied into the package.
      if (declared !== null) {
        added.type = 'custom'
        added.script = declared.script
        if (declared.options !== undefined) added.options = declared.options
      }
      feeds.push(added)
      await writeFeeds(root, feeds)
      return added
    })
    invalidate()
    syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)

    // Pull this one feed into the local cache so it appears immediately. A
    // failure here still leaves the subscription in place.
    try {
      await runLocalFetch({ only: entry.id })
    } catch (err) {
      logger.warn(`gitfeed: initial fetch for ${entry.id} failed: ${messageOf(err)}`)
    }
    return entry
  }

  /**
   * Unsubscribe and remove that feed's items from both stores.
   * @param {string} id feed id.
   * @returns {Promise<{ok:boolean, removed:string}>} settled result.
   */
  async function removeFeed(id: string | undefined): Promise<{ ok: boolean; removed: string }> {
    touch()
    const key = id || ''
    if (!key) throw new Error('feed id is required')
    // One queue for every subscription mutation and every mark, so the list and
    // the shards it rewrites cannot interleave with another one.
    await serialize(async function () {
      const feeds = await readFeeds(root)
      const next = feeds.filter(function (f) { return f.id !== key })
      if (next.length === feeds.length) throw new Error('no such feed')
      await writeFeeds(root, next)

      for (const dir of [paths.items, paths.localItems]) {
        for (const file of await listShards(dir)) {
          await updateNdjson<{ feed: string } | null>(file, function (rows) {
            const kept = rows.filter(function (row) { return row && row.feed !== key })
            return kept.length === rows.length ? null : kept
          })
        }
      }
    })
    invalidate()
    syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
    return { ok: true, removed: key }
  }

  async function gitAction(name: string): Promise<GitActionResult> {
    touch()
    if (!allowGit) throw new Error('git actions are disabled by the gitfeed plugin config (allowGit)')
    const info = await readGitInfo(root)
    if (!info.repo) {
      const localCopy = `gitfeed: ${root} is a local copy, not a git working tree`
      throw new Error(`${localCopy} — clone your own repository there (or point config.repo at one) to ${name}`)
    }
    if (name === 'sync' && (info.remotes || []).indexOf('origin') === -1) {
      throw new Error(`gitfeed: ${root} has no \`origin\` remote — add one with \`git remote add origin <url>\` and try Sync again`)
    }
    const run = await syncJob.runNow({ action: name })
    invalidate()
    const value = run.value
    if (value && typeof value === 'object') return value as GitActionResult
    return { ok: false, action: name, error: run.outcome.summary || 'git action failed' }
  }

  async function snapshotNow(): Promise<{ cfg: RepoConfig; version: string; data: ReaderStateData }> {
    const version = await fileVersion()
    if (version === 'uninitialized') throw new Error(`gitfeed: no feeds.json in ${root}`)
    const cfg = settings()
    const model = await buildItems()
    return { cfg: cfg, version: version, data: await buildSnapshot(cfg, model.items) }
  }

  async function listForTool(input: ListToolInput | null | undefined) {
    const opts: ListToolInput = input || {}
    const { data } = await snapshotNow()
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

  async function getForTool(id: string) {
    const { data } = await snapshotNow()
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

  async function statusForTool() {
    const { data, version } = await snapshotNow()
    const readSet = new Set(data.read)
    const unread = data.items.reduce(function (n, item) { return readSet.has(item.id) ? n : n + 1 }, 0)
    return {
      repo: root,
      version: version,
      feeds: data.feeds.length,
      items: data.items.length,
      unread: unread,
      starred: data.starred.length,
      failingFeeds: data.feeds.filter(function (f) { return !!f.error }).length,
      git: await gitInfo(),
      schedule: await runner.status(),
      allowGit: allowGit,
    }
  }

  function dispose(): void {
    disposed = true
    runner.dispose()
    invalidate()
  }

  return {
    root: root,
    getState: getState,
    mark: mark,
    star: star,
    addFeed: addFeed,
    removeFeed: removeFeed,
    runLocalFetch: runLocalFetch,
    pull: function () { return gitAction('pull') },
    sync: function () { return gitAction('sync') },
    settings: settings,
    listForTool: listForTool,
    getForTool: getForTool,
    statusForTool: statusForTool,
    dispose: dispose,
  }
}

export type GitfeedService = ReturnType<typeof createGitfeed>
