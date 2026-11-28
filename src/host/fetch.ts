// Fetch every feed in feeds.json, append genuinely new items to the date-sharded
// NDJSON log, and update the conditional-GET metadata.
//
// Exported as a function so the Host plugin, the CLI, and a scheduler all run
// the same implementation. `dataDir` selects the committed `data/` tree or the
// gitignored `.local/` refresh cache.

import crypto from 'node:crypto'
import path from 'node:path'
import { readdir, unlink } from 'node:fs/promises'
import { parseFeed } from './xml.js'
import { declarationOf, runCustom, scriptFile } from './custom.js'
import { FEED_ACCEPT, USER_AGENT, classifyDocument, readDocument } from './document.js'
import type { CustomDeclaration } from './custom.js'
import type { ParsedItem } from './xml.js'
import { pathsFor, readRepoConfig } from './settings.js'
import { assignFeedIds } from './feeds.js'
import { appendNdjson, ensureDir, listShards, readJson, readNdjson, updateNdjson, writeJson } from './store.js'
import type { FeedDefinition, FetchFeedOutcome, FetchResult, RepoConfig } from './types.js'
import type { FeedEntry, Item } from '../shared/types.js'
import { looksUnreachable, messageOf } from '../shared/errors.js'

/**
 * How many feeds a run has to attempt before all of them missing means the
 * network, not the subscriptions. One or two broken feeds are a broken feed; a
 * whole run that reached nothing is the way out of the house being down. The
 * floor keeps a run whose due set happens to be one dead host from being read
 * as an outage.
 */
const OFFLINE_MIN_FEEDS = 3

interface FeedMeta {
  title?: string | null
  folder?: string | null
  siteUrl?: string | null
  url?: string
  etag?: string | null
  lastModified?: string | null
  checkedAt?: string | null
  status?: number
  lastError?: string | null
}

function itemId(feedId: string, key: string): string {
  return crypto.createHash('sha1').update(`${feedId}|${key}`).digest('hex').slice(0, 16)
}

function parseDate(raw: string | null | undefined, now: Date): Date | null {
  if (!raw) return null
  const text = raw.trim()
  // An API often publishes a Unix timestamp. Nine or ten digits are seconds,
  // eleven to thirteen are milliseconds; a feed never sends a bare number.
  const d = /^\d{9,13}$/.test(text)
    ? new Date(Number(text) * (text.length <= 10 ? 1000 : 1))
    : new Date(text)
  if (Number.isNaN(d.getTime())) return null
  const t = d.getTime()
  // Clamp nonsense: future timestamps and pre-web dates are treated as
  // "undated" so the shard they land in stays predictable.
  if (t > now.getTime() + 86400000) return null
  if (t < Date.UTC(1995, 0, 1)) return null
  return d
}

/** One subscribed entry, with the id `readFeeds` assigns it to the list. */
interface RuntimeFeed extends FeedDefinition {
  /** Switched off by hand: kept in the list, never fetched. */
  disabled: boolean
}

/**
 * Every subscribed entry, with the id `readFeeds` assigns it. Identity has one
 * owner on purpose: this run writes rows keyed by the id, and the digest decides
 * what to show by looking the same id up in feeds.json. Disabled entries are
 * assigned an id too, because the archive they already have is keyed by it.
 * @param root - data root.
 * @returns the entries in file order.
 */
async function runtimeEntries(root: string): Promise<RuntimeFeed[]> {
  const raw = await readJson<{ feeds?: unknown } | null>(pathsFor(root).feeds, null)
  if (!raw || !Array.isArray(raw.feeds)) {
    throw new Error('feeds.json is missing or has no "feeds" array')
  }
  const entries = raw.feeds as Array<FeedEntry | null>
  const ids = assignFeedIds(entries)
  const feeds: RuntimeFeed[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || !entry.url) continue
    // A URL the fetcher cannot even parse is not a runnable feed, but it keeps
    // its id in the list: the digest still draws the row, with its error.
    try {
      new URL(entry.url)
    } catch {
      continue
    }
    feeds.push({
      id: ids[i],
      url: entry.url,
      title: entry.title || null,
      folder: entry.folder || null,
      type: entry.type,
      script: entry.script,
      options: entry.options,
      disabled: entry.disabled === true,
    })
  }
  return feeds
}

/**
 * The feeds a run would fetch. The scheduler keys its per-feed clocks by these
 * ids, so both sides must agree on them.
 * @param {string} root data root.
 * @returns {Promise<Array<{id:string,url:string,title:string|null,folder:string|null}>>} runnable feeds.
 */
export async function loadRuntimeFeeds(root: string): Promise<FeedDefinition[]> {
  return (await runtimeEntries(root)).filter(function (feed) { return !feed.disabled })
}

/**
 * Every id `feeds.json` subscribes to, disabled entries included. A switched-off
 * feed is still subscribed, so a run keeps the check it cached for it.
 * @param root - data root.
 * @returns the subscribed ids.
 */
export async function subscribedFeedIds(root: string): Promise<Set<string>> {
  return new Set((await runtimeEntries(root)).map(function (feed) { return feed.id }))
}

/**
 * Turn a feed's rows into archive rows: the id, the cascade for undated
 * entries, and the field caps. Both the RSS path and a custom feed's script
 * end here, which is why a script's output behaves like a feed's.
 * @param feed the subscription the rows belong to.
 * @param rows the parsed (or script-produced) entries.
 * @param now the run's clock, for undated entries.
 * @param cap `fetch.maxSummaryChars`; 0 keeps the body whole.
 * @returns the rows to archive, in feed order.
 */
function toItems(feed: FeedDefinition, rows: ParsedItem[], now: Date, cap: number): Item[] {
  const seen = new Set<string>()
  const items: Item[] = []
  for (let i = 0; i < rows.length; i++) {
    const it = rows[i]
    const key = it.guid || it.link || (`${it.title}|${it.date}`)
    if (!key || seen.has(key)) continue
    seen.add(key)
    // Feeds without dates would otherwise all land on the same timestamp.
    // Cascade them by feed position, newest first.
    const date = parseDate(it.date, now) || new Date(now.getTime() - i * 60000)
    items.push({
      id: itemId(feed.id, key),
      feed: feed.id,
      title: (it.title || '(untitled)').slice(0, 300),
      link: it.link || '',
      date: date.toISOString(),
      // Some feeds put a profile URL in <author>; it renders as noise.
      author: (it.author || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 120),
      summary: cap > 0 ? (it.summary || '').slice(0, cap) : (it.summary || ''),
    })
  }
  return items
}

interface FetchOneResult {
  notModified?: boolean
  items?: Item[]
  meta: FeedMeta
}

/** What one feed's read needs beyond the feed and the check it cached. */
interface ReadContext {
  now: Date
  settings: RepoConfig
  /** The data root, for a custom feed's script. */
  root: string
  signal: AbortSignal
}

/**
 * Read an RSS/Atom subscription: the conditional GET, the parse, and the
 * feed-level metadata the response carries.
 */
async function fetchRss(feed: FeedDefinition, prev: FeedMeta | undefined, ctx: ReadContext): Promise<FetchOneResult> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: FEED_ACCEPT,
    'accept-language': 'en;q=0.8, *;q=0.5',
  }
  if (prev && prev.etag) headers['if-none-match'] = prev.etag
  if (prev && prev.lastModified) headers['if-modified-since'] = prev.lastModified

  const res = await readDocument(feed.url, { headers: headers, signal: ctx.signal })

  if (res.status === 304) {
    return {
      notModified: true,
      // A feed that answers 304 has recovered: the previous failure no longer
      // describes it, and leaving it would keep the row red forever.
      meta: Object.assign({}, prev, { checkedAt: ctx.now.toISOString(), status: 304, lastError: null }),
    }
  }
  if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`)
  if (classifyDocument(res.headers.get('content-type'), res.body) !== 'feed') {
    throw new Error('response is not an XML feed')
  }

  const parsed = parseFeed(res.body)
  if (parsed.items.length === 0) throw new Error('no items in feed')
  return {
    items: toItems(feed, parsed.items, ctx.now, ctx.settings.fetch.maxSummaryChars),
    meta: {
      title: parsed.title || feed.title || feed.id,
      folder: feed.folder || null,
      siteUrl: parsed.siteUrl || null,
      etag: res.headers.get('etag') || null,
      lastModified: res.headers.get('last-modified') || null,
      checkedAt: ctx.now.toISOString(),
      status: res.status,
    },
  }
}

/**
 * Read a custom subscription: resolve its script, let it produce a pseudo feed,
 * and hand that feed's rows to the same mapping an RSS feed runs through.
 */
async function fetchCustom(
  feed: FeedDefinition, declaration: CustomDeclaration, prev: FeedMeta | undefined, ctx: ReadContext,
): Promise<FetchOneResult> {
  const file = await scriptFile(ctx.root, declaration.script)
  const pseudo = await runCustom(file, {
    id: feed.id,
    url: feed.url,
    title: feed.title,
    options: declaration.options,
    meta: {
      etag: prev && prev.etag ? prev.etag : null,
      lastModified: prev && prev.lastModified ? prev.lastModified : null,
    },
    fetch: globalThis.fetch,
    signal: ctx.signal,
  })
  return {
    items: toItems(feed, pseudo.items, ctx.now, ctx.settings.fetch.maxSummaryChars),
    meta: {
      title: pseudo.title || feed.title || feed.id,
      folder: feed.folder || null,
      siteUrl: pseudo.siteUrl || null,
      // A script that did not revalidate keeps the validators it was handed;
      // one that reports them stores what it reported.
      etag: pseudo.etag === undefined ? (prev && prev.etag ? prev.etag : null) : pseudo.etag,
      lastModified: pseudo.lastModified === undefined ? (prev && prev.lastModified ? prev.lastModified : null) : pseudo.lastModified,
      checkedAt: ctx.now.toISOString(),
      status: 200,
    },
  }
}

/**
 * Read one subscription: the per-feed deadline, and the choice between a feed
 * and the script that stands in for one.
 *
 * The deadline and the run's stop are combined into the signal the read gets, so
 * either one ends it — a server that answers and then stalls cannot hold the run
 * after the reader has gone. The deadline is a plain `AbortSignal.timeout`
 * because its timer does not keep the process open; there is nothing to clear.
 */
async function fetchOne(
  feed: FeedDefinition, prev: FeedMeta | undefined, now: Date, settings: RepoConfig, root: string,
  signal?: AbortSignal,
): Promise<FetchOneResult> {
  // Validated before anything is requested: a typo in a declaration is this
  // feed's own error on its own row, and the run carries on.
  const declaration: CustomDeclaration | null = declarationOf(feed)
  const deadline = AbortSignal.timeout(settings.fetch.timeoutMs)
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline
  // The deadline spans the body as well as the headers: a server that answers
  // and then stalls must not hold this feed's slot until the socket gives up.
  // A custom feed's script gets the same clock as `signal`.
  const ctx: ReadContext = { now: now, settings: settings, root: root, signal: abort }
  if (declaration !== null) return await fetchCustom(feed, declaration, prev, ctx)
  return await fetchRss(feed, prev, ctx)
}

/**
 * Run `worker` over `list`, at most `limit` at a time.
 *
 * This is not a thread pool: the event loop already does the waiting, and what a
 * run needs is an upper bound on how many requests are in flight — each one is a
 * socket, a TLS session, and a body held in memory, and a remote host sees all
 * of them at once. A worker takes the next index when it finishes, so a slow
 * feed costs one slot rather than a whole batch, and the result lands at the
 * item's own index, so a caller that wants the original order still gets it.
 *
 * A stopped run stops starting feeds too. The check before each item is what
 * makes `signal` end the run rather than only the reads already in flight.
 */
async function pool<T, R>(list: T[], limit: number, worker: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out = new Array<R>(list.length)
  let next = 0
  const runners: Array<Promise<void>> = []
  const size = Math.max(1, Math.min(limit, list.length))
  for (let i = 0; i < size; i++) {
    runners.push((async function () {
      while (true) {
        signal?.throwIfAborted()
        const idx = next++
        if (idx >= list.length) return
        out[idx] = await worker(list[idx], idx)
      }
    })())
  }
  await Promise.all(runners)
  return out
}

/** One feed's outcome, as the judging step takes it. */
type FeedRun = { feed: FeedDefinition; error: string } | ({ feed: FeedDefinition } & FetchOneResult)

function cutoffKey(now: Date, keepMonths: number): string {
  if (!(keepMonths > 0)) return '0000-00'
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - keepMonths, 1))
  return cutoff.toISOString().slice(0, 7)
}

async function prune(itemsDir: string, now: Date, keepMonths: number): Promise<number> {
  if (!(keepMonths > 0)) return 0
  const floor = cutoffKey(now, keepMonths)
  let names
  try {
    names = await readdir(itemsDir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!/^\d{4}-\d{2}\.ndjson$/.test(name)) continue
    if (name.slice(0, 7) >= floor) continue
    await unlink(path.join(itemsDir, name))
    removed++
  }
  return removed
}

/**
 * Fetch one or every feed and write what changed: one linear pass, with the
 * verdict of each feed taken the moment it lands.
 * @param {object} options
 * @param {string} options.root gitfeed checkout.
 * @param {string} [options.dataDir] output directory relative to `root`; defaults to `data`.
 * @param {string} [options.only] fetch exactly one feed id.
 * @param {string[]} [options.feeds] fetch only these feed ids (the scheduler's due set).
 * @param {boolean} [options.dryRun] fetch and report without writing.
 * @param {boolean} [options.refresh] ignore the stored validators.
 * @param {(line: string) => void} [options.onLog] receives every progress line.
 * @param {AbortSignal} [options.signal] stops the run: no feed starts after it
 *   aborts, the reads in flight are cut off, and the result says so instead of
 *   judging feeds a shutdown interrupted.
 * @returns the fetcher report.
 */
export interface FetchOptions {
  root: string
  dataDir?: string
  only?: string
  feeds?: string[]
  dryRun?: boolean
  refresh?: boolean
  /**
   * What the archive already holds: id to the length of the body kept. A caller
   * that keeps the merged model in memory passes it, so a run does not read
   * every shard to answer a question it already knows. Omit it and the run
   * reads the stores, which is what the CLI and a standalone caller do.
   */
  known?: ReadonlyMap<string, number>
  /** Stops the run; the result reports a stop rather than a judgment. */
  signal?: AbortSignal
  onLog?: (line: string) => void
}

/**
 * Run one pass. The four lines that matter are the data flow: what the run is
 * configured with, which feeds it may touch, what the archive already holds, and
 * what the feeds returned. Each step is a named function; nothing is nested, so
 * the work of a step is not hidden in an inline closure of this one.
 * @param options - what to fetch and where.
 * @returns the run's report.
 */
export async function runFetch(options: FetchOptions): Promise<FetchResult> {
  const plan = planRun(options)
  const feeds = await runnableFeeds(plan)
  if (feeds.length === 0) return emptyRun(plan)
  try {
    const archive = await readArchive(plan)
    const tally = await fetchAll(plan, feeds, archive)
    return await finishRun(plan, feeds, archive, tally)
  } catch (err) {
    // Only a stop is answered here; a disk or parser failure is the caller's.
    if (!plan.signal?.aborted) throw err
    return stoppedRun(plan, feeds.length)
  }
}

/** What the run is configured with: where it reads and writes, and how it counts. */
interface RunPlan {
  root: string
  settings: RepoConfig
  /** The store this run writes. */
  itemsDir: string
  /** The committed archive, which a fetch into the cache still counts as held. */
  committedItems: string
  metaFile: string
  only: string
  wanted: Set<string> | null
  restricted: boolean
  dryRun: boolean
  refresh: boolean
  known?: ReadonlyMap<string, number>
  signal?: AbortSignal
  /** The run's clock, and the retention floor it implies. */
  now: Date
  floor: string
  logs: string[]
  log: (line: string) => void
}

function planRun(options: FetchOptions): RunPlan {
  const root = options.root
  const paths = pathsFor(root)
  const dataRoot = options.dataDir ? path.resolve(root, options.dataDir) : paths.data
  const settings = readRepoConfig(root)
  const now = new Date()
  const only = options.only || ''
  const wanted = Array.isArray(options.feeds) ? new Set(options.feeds.map(String)) : null
  const logs: string[] = []
  return {
    root: root,
    settings: settings,
    itemsDir: path.join(dataRoot, 'items'),
    committedItems: paths.items,
    metaFile: path.join(dataRoot, 'meta.json'),
    only: only,
    wanted: wanted,
    restricted: only !== '' || wanted !== null,
    dryRun: options.dryRun === true,
    refresh: options.refresh === true,
    known: options.known,
    signal: options.signal,
    now: now,
    floor: cutoffKey(now, settings.fetch.keepMonths),
    logs: logs,
    log: function (line: string): void {
      logs.push(line)
      if (typeof options.onLog === 'function') options.onLog(line)
    },
  }
}

/** The feeds this run may touch: every subscription, or the scheduler's due set. */
async function runnableFeeds(plan: RunPlan): Promise<FeedDefinition[]> {
  let feeds = await loadRuntimeFeeds(plan.root)
  if (plan.only) feeds = feeds.filter(function (feed) { return feed.id === plan.only })
  if (plan.wanted) feeds = feeds.filter(function (feed) { return plan.wanted?.has(feed.id) === true })
  return feeds
}

/**
 * The report every exit builds, with each count defaulted to nothing.
 * @param plan - the run's plan, whose log buffer the report carries.
 * @param summary - the one line the status shows.
 * @param part - the counts this exit has.
 * @returns the fetcher result.
 */
function report(plan: RunPlan, summary: string, part?: Partial<FetchResult>): FetchResult {
  return Object.assign({
    code: 0, logs: plan.logs, summary: summary, feeds: 0, fresh: 0, unchanged: 0, expired: 0, failed: 0,
    repaired: 0, unreachable: 0, offline: false, perFeed: {},
  }, part)
}

function emptyRun(plan: RunPlan): FetchResult {
  const summary = plan.only ? `no feed with id ${plan.only}` : 'feeds.json contains no usable feeds'
  plan.log(summary)
  return report(plan, summary, { code: 1 })
}

function stoppedRun(plan: RunPlan, feeds: number): FetchResult {
  const summary = 'stopped before the run finished'
  plan.log(summary)
  return report(plan, summary, { feeds: feeds })
}

/** What a run reads before it starts: the cached checks and the archived ids. */
interface ArchiveState {
  meta: Record<string, FeedMeta | undefined>
  /** id -> archived summary length, for the repair pass. */
  known: Map<string, number>
  /** Metadata entries dropped for sources that are no longer subscribed. */
  stale: number
}

/**
 * Read the archive state the run needs: the cached checks in this store, the ids
 * the committed archive and this store already hold, and the cached checks that
 * no longer describe a subscription.
 *
 * A run that writes the cache still counts the committed archive as archived:
 * otherwise every row the reader already holds from `data/` is fetched again as
 * new, and the cache fills with a second copy of the whole library. A caller
 * that keeps the merged model in memory hands the map in and skips the read.
 * @param plan - the run's plan.
 * @returns what the run already holds.
 */
async function readArchive(plan: RunPlan): Promise<ArchiveState> {
  plan.signal?.throwIfAborted()
  await ensureDir(plan.itemsDir)
  const meta = await readJson<Record<string, FeedMeta | undefined>>(plan.metaFile, {})

  let stale = 0
  // A disabled feed is subscribed, so a run keeps its cached check; one that is
  // no longer subscribed has none to keep. A restricted run must not judge every
  // other feed "unsubscribed".
  if (!plan.restricted) {
    const live = await subscribedFeedIds(plan.root)
    for (const key of Object.keys(meta)) {
      if (live.has(key)) continue
      Reflect.deleteProperty(meta, key)
      stale++
    }
  }

  const known = plan.known ? new Map(plan.known) : await readKnown(plan.itemsDir, plan.committedItems)
  return { meta: meta, known: known, stale: stale }
}

/**
 * What the archive already holds: id -> the length of the body kept. A feed that
 * re-serves a longer body than the archive holds can repair a copy an older,
 * smaller cap cut short.
 *
 * A run that writes the cache still counts the committed archive as archived:
 * otherwise every row the reader already holds from `data/` is fetched again as
 * new, and the cache fills with a second copy of the whole library.
 * @param itemsDir - the store this run writes.
 * @param committedItems - the committed archive.
 * @returns the map, which the judging step keeps up to date as it goes.
 */
async function readKnown(itemsDir: string, committedItems: string): Promise<Map<string, number>> {
  const known = new Map<string, number>()
  const files: string[] = []
  for (const dir of itemsDir === committedItems ? [itemsDir] : [committedItems, itemsDir]) {
    files.push(...await listShards(dir))
  }
  for (const file of files) {
    for (const row of await readNdjson<{ id: string; summary?: string } | null>(file)) {
      if (!row || !row.id) continue
      const length = typeof row.summary === 'string' ? row.summary.length : 0
      const previous = known.get(row.id)
      if (previous === undefined || length > previous) known.set(row.id, length)
    }
  }
  return known
}

/** What the run found, feed by feed, and what the archive should keep. */
interface RunTally {
  fresh: Item[]
  repairs: Map<string, { month: string; summary: string }>
  perFeed: Record<string, FetchFeedOutcome>
  /** Failed feeds, with the error each had before this run. */
  missed: Array<{ id: string; error: string; previous: string | null }>
  failed: number
  unchanged: number
  expired: number
  unreachable: number
}

/**
 * Read and judge every feed, one at a time per slot.
 *
 * A feed is judged the moment its read lands: a verdict is that result plus the
 * run's constants, and `judgeOne` never awaits, so the tally cannot be caught
 * mid-update. That is what lets a progress line exist while the next feed is
 * still being read.
 * @param plan - the run's plan.
 * @param feeds - the feeds to read.
 * @param archive - what the run already holds.
 * @returns the tally, including the verdicts.
 */
async function fetchAll(plan: RunPlan, feeds: FeedDefinition[], archive: ArchiveState): Promise<RunTally> {
  const tally: RunTally = {
    fresh: [], repairs: new Map(), perFeed: {}, missed: [], failed: 0, unchanged: 0, expired: 0, unreachable: 0,
  }
  plan.log(`gitfeed ${plan.now.toISOString()}  ${feeds.length} feeds`)
  if (archive.stale) plan.log(`  drop ${archive.stale} stale feed(s) from meta.json`)
  await pool(feeds, plan.settings.fetch.concurrency, function (feed) {
    return fetchOneFeed(plan, feed, archive, tally)
  }, plan.signal)
  // The window between the last feed and the first write: a run stopped here
  // has read what it could, and a shutdown is not a verdict either.
  plan.signal?.throwIfAborted()
  return tally
}

/**
 * One feed, start to verdict: the read, its failure if any, and the judgment.
 * @param plan - the run's plan.
 * @param feed - the subscription to read.
 * @param archive - what the run already holds.
 * @param tally - the run's counts, updated by the verdict.
 */
async function fetchOneFeed(plan: RunPlan, feed: FeedDefinition, archive: ArchiveState, tally: RunTally): Promise<void> {
  let result: FeedRun
  try {
    result = Object.assign({ feed: feed }, await fetchOne(
      feed, plan.refresh ? undefined : archive.meta[feed.id], plan.now, plan.settings, plan.root, plan.signal,
    ))
  } catch (err) {
    result = { feed: feed, error: messageOf(err) }
  }
  judgeOne(plan, result, archive, tally)
}

/**
 * Judge one feed's result: the health it reports, the rows it adds, and the
 * bodies it repairs. Nothing here crosses feeds.
 * @param plan - the run's plan.
 * @param r - the feed's result.
 * @param archive - what the run already holds, updated in place.
 * @param tally - the run's counts, updated in place.
 */
function judgeOne(plan: RunPlan, r: FeedRun, archive: ArchiveState, tally: RunTally): void {
  if ('error' in r) {
    tally.failed++
    if (looksUnreachable(r.error)) tally.unreachable++
    tally.perFeed[r.feed.id] = { added: 0, failed: true, notModified: false }
    plan.log(`  err  ${r.feed.id.padEnd(18)} ${r.error}`)
    const prevMeta = archive.meta[r.feed.id] || {}
    archive.meta[r.feed.id] = Object.assign({}, prevMeta, {
      title: prevMeta.title || r.feed.title || r.feed.id,
      folder: r.feed.folder || prevMeta.folder || null,
      url: r.feed.url,
      checkedAt: plan.now.toISOString(),
    })
    tally.missed.push({ id: r.feed.id, error: r.error, previous: prevMeta.lastError ?? null })
    return
  }
  archive.meta[r.feed.id] = Object.assign({ url: r.feed.url, folder: r.feed.folder || null }, r.meta)
  if (r.notModified) {
    tally.unchanged++
    tally.perFeed[r.feed.id] = { added: 0, failed: false, notModified: true }
    plan.log(`  ok   ${r.feed.id.padEnd(18)} unchanged`)
    return
  }
  const added = absorb(plan, r.items ?? [], archive, tally)
  tally.perFeed[r.feed.id] = { added: added, failed: false, notModified: false }
  plan.log(`  ok   ${r.feed.id.padEnd(18)} +${added} (${(r.items ?? []).length} seen)`)
}

/**
 * Count one feed's rows into the run: the ones to write, the ones a longer body
 * repairs, and the ones past retention. `known` is updated as they go, so a feed
 * that serves the same id twice in one body writes it once.
 * @param plan - the run's plan, for the retention floor.
 * @param items - the rows this feed returned.
 * @param archive - what the run already holds, updated in place.
 * @param tally - the run's counts, updated in place.
 * @returns how many rows are new.
 */
function absorb(plan: RunPlan, items: readonly Item[], archive: ArchiveState, tally: RunTally): number {
  let added = 0
  for (const item of items) {
    const archived = archive.known.get(item.id)
    if (archived !== undefined) {
      // The feed is re-serving a body longer than the archived copy, which means
      // that copy was cut by a smaller maxSummaryChars when it was written.
      // Raising the cap should heal the archive, not only new items.
      if (item.summary.length > archived && item.date.slice(0, 7) >= plan.floor) {
        tally.repairs.set(item.id, { month: item.date.slice(0, 7), summary: item.summary })
        archive.known.set(item.id, item.summary.length)
      }
      continue
    }
    // Older than the retention window: never write it, and let prune() drop any
    // shard already fully out of range.
    if (item.date.slice(0, 7) < plan.floor) {
      archive.known.set(item.id, item.summary.length)
      tally.expired++
      continue
    }
    archive.known.set(item.id, item.summary.length)
    tally.fresh.push(item)
    added++
  }
  return added
}

/**
 * Finish the run: the one decision that needs every result, the one write that
 * commits them, and the report.
 *
 * A run that reached none of its feeds says nothing about any of them: the
 * machine was off the network. Such a run leaves each feed's health as it found
 * it — an error means "this source is broken", and "the train tunnel had no
 * signal" is not that — and the job retries at its base cadence instead of
 * parking the feeds for the morning.
 *
 * Writing waits for the whole set on purpose: one append per month (rows sorted
 * by date), one `meta.json` for every source's health, one retention pass. A
 * stopped run never reaches here, which is what keeps it from writing anything.
 * @param plan - the run's plan.
 * @param feeds - the feeds the run covered.
 * @param archive - what the run read, updated by the verdicts.
 * @param tally - what the run found.
 * @returns the fetcher report.
 */
async function finishRun(plan: RunPlan, feeds: FeedDefinition[], archive: ArchiveState, tally: RunTally): Promise<FetchResult> {
  const offline = feeds.length >= OFFLINE_MIN_FEEDS && tally.failed === feeds.length && tally.unreachable === tally.failed
  for (const miss of tally.missed) {
    const entry = archive.meta[miss.id]
    if (entry) entry.lastError = offline ? miss.previous : miss.error
  }
  if (offline) plan.log(`  the network was unreachable: ${tally.failed} feed(s) not judged`)

  const repaired = plan.dryRun ? 0 : await writeRun(plan, archive, tally)
  const repairedNote = repaired > 0 ? `, ${repaired} repaired` : ''
  const counts = offline
    ? `no feed reachable (${tally.unreachable} unreachable)`
    : `${tally.unchanged} unchanged, ${tally.expired} past retention, ${tally.failed} failed${repairedNote}`
  const summary = `${plan.dryRun ? 'dry-run: ' : ''}${tally.fresh.length} new item(s), ${counts}`
  plan.log(summary)
  return report(plan, summary, {
    code: tally.failed === feeds.length ? 1 : 0,
    feeds: feeds.length,
    fresh: tally.fresh.length,
    unchanged: tally.unchanged,
    expired: tally.expired,
    failed: tally.failed,
    repaired: repaired,
    unreachable: tally.unreachable,
    offline: offline,
    perFeed: tally.perFeed,
  })
}

/**
 * Write the run: new rows, repaired bodies, every source's health, and the
 * retention pruning. Dry runs never get here.
 * @param plan - the run's plan.
 * @param archive - the metadata the verdicts updated.
 * @param tally - the rows and repairs to write.
 * @returns how many bodies were repaired in place.
 */
async function writeRun(plan: RunPlan, archive: ArchiveState, tally: RunTally): Promise<number> {
  if (tally.fresh.length > 0) await writeFresh(plan, tally.fresh)
  const repaired = tally.repairs.size > 0 ? await writeRepairs(plan, tally.repairs) : 0
  const sorted: Record<string, FeedMeta | undefined> = {}
  Object.keys(archive.meta).sort().forEach(function (key) { sorted[key] = archive.meta[key] })
  await writeJson(plan.metaFile, sorted)
  const dropped = await prune(plan.itemsDir, plan.now, plan.settings.fetch.keepMonths)
  if (dropped) plan.log(`  prune ${dropped} shard(s) older than ${plan.settings.fetch.keepMonths} months`)
  return repaired
}

/**
 * Append the run's new rows, one shard per month, oldest first.
 * @param plan - the run's plan.
 * @param fresh - the rows to add.
 */
async function writeFresh(plan: RunPlan, fresh: Item[]): Promise<void> {
  const byMonth = new Map<string, Item[]>()
  for (const item of fresh) {
    const key = item.date.slice(0, 7)
    const bucket = byMonth.get(key)
    if (bucket) bucket.push(item)
    else byMonth.set(key, [item])
  }
  for (const key of Array.from(byMonth.keys()).sort()) {
    const rows = (byMonth.get(key) ?? []).sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    })
    const file = path.join(plan.itemsDir, `${key}.ndjson`)
    await appendNdjson(file, rows)
    plan.log(`  write ${path.relative(plan.root, file)}  +${rows.length}`)
  }
}

/**
 * Rewrite the shards a longer body belongs to, replacing only rows the feed now
 * serves longer. The append pass never touches a known id, so the two cannot see
 * the same row.
 * @param plan - the run's plan.
 * @param repairs - item id -> the month it lives in and the body to keep.
 * @returns how many rows were replaced.
 */
async function writeRepairs(plan: RunPlan, repairs: RunTally['repairs']): Promise<number> {
  const byMonth = new Map<string, Map<string, string>>()
  for (const [id, repair] of repairs) {
    let patch = byMonth.get(repair.month)
    if (!patch) {
      patch = new Map<string, string>()
      byMonth.set(repair.month, patch)
    }
    patch.set(id, repair.summary)
  }
  let repaired = 0
  for (const [month, patch] of byMonth) {
    const file = path.join(plan.itemsDir, `${month}.ndjson`)
    // A boxed flag: the map callback runs synchronously, but a plain `let`
    // trips the unnecessary-condition rule because TS cannot see the write.
    const applied = { touched: false }
    await updateNdjson<Item | null>(file, function (rows) {
      const next = rows.map(function (row) {
        if (!row) return row
        const summary = patch.get(row.id)
        if (summary === undefined || summary.length <= (row.summary || '').length) return row
        applied.touched = true
        repaired++
        return Object.assign({}, row, { summary: summary })
      })
      return applied.touched ? next : null
    })
    if (!applied.touched) continue
    plan.log(`  repair ${path.relative(plan.root, file)}  ${patch.size} item(s)`)
  }
  return repaired
}
