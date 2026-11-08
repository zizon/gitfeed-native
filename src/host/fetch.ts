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
import { pathsFor, readRepoConfig } from './settings.js'
import { feedIdFor, slug } from './feeds.js'
import { appendNdjson, ensureDir, listShards, readJson, readNdjson, writeJson, writeNdjson } from './store.js'
import type { FeedDefinition, FetchFeedOutcome, FetchResult, RepoConfig } from './types.js'
import type { FeedEntry, Item } from '../shared/types.js'

const UA = 'gitfeed/2.0 (+https://github.com; personal RSS reader)'

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
  const d = new Date(raw.trim())
  if (Number.isNaN(d.getTime())) return null
  const t = d.getTime()
  // Clamp nonsense: future timestamps and pre-web dates are treated as
  // "undated" so the shard they land in stays predictable.
  if (t > now.getTime() + 86400000) return null
  if (t < Date.UTC(1995, 0, 1)) return null
  return d
}

/**
 * The feeds a run would fetch, with the ids the fetcher assigns them: a
 * configured `id` goes through the same slug rules, and duplicate ids get a
 * numeric suffix. The scheduler keys its per-feed clocks by these ids, so both
 * sides must agree on them.
 * @param {string} root data root.
 * @returns {Promise<Array<{id:string,url:string,title:string|null,folder:string|null}>>} runnable feeds.
 */
export async function loadRuntimeFeeds(root: string): Promise<FeedDefinition[]> {
  const raw = await readJson<{ feeds?: unknown } | null>(pathsFor(root).feeds, null)
  if (!raw || !Array.isArray(raw.feeds)) {
    throw new Error('feeds.json is missing or has no "feeds" array')
  }
  const entries = raw.feeds as Array<FeedEntry | null>
  const used = new Set<string>()
  const feeds: FeedDefinition[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || !entry.url || entry.disabled) continue
    let id
    try {
      id = entry.id ? slug(entry.id) : feedIdFor(entry.url)
    } catch {
      continue
    }
    let unique = id
    let n = 2
    while (used.has(unique)) unique = `${id}-${n++}`
    used.add(unique)
    feeds.push({ id: unique, url: entry.url, title: entry.title || null, folder: entry.folder || null })
  }
  return feeds
}

function parseXml(text: string): boolean {
  const head = text.slice(0, 4000).replace(/^\uFEFF/, '')
  return /<(rss|feed|rdf:RDF|channel)\b/i.test(head)
}

interface FetchOneResult {
  notModified?: boolean
  items?: Item[]
  meta: FeedMeta
}

async function fetchOne(feed: FeedDefinition, prev: FeedMeta | undefined, now: Date, settings: RepoConfig): Promise<FetchOneResult> {
  const headers: Record<string, string> = {
    'user-agent': UA,
    accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    'accept-language': 'en;q=0.8, *;q=0.5',
  }
  if (prev && prev.etag) headers['if-none-match'] = prev.etag
  if (prev && prev.lastModified) headers['if-modified-since'] = prev.lastModified

  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, settings.fetch.timeoutMs)
  // The deadline spans the body as well as the headers: a server that answers
  // and then stalls must not hold this feed's slot until the socket gives up.
  try {
    const res = await fetch(feed.url, { headers: headers, redirect: 'follow', signal: controller.signal })

    if (res.status === 304) {
      return {
        notModified: true,
        meta: Object.assign({}, prev, { checkedAt: now.toISOString(), status: 304 }),
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const body = await res.text()
    if (!parseXml(body)) throw new Error('response is not an XML feed')

    const parsed = parseFeed(body)
    if (parsed.items.length === 0) throw new Error('no items in feed')

    const seen = new Set<string>()
    const items: Item[] = []
    // Zero is the default and keeps the feed's body whole; a positive setting is
    // a deliberate cap for archives that must stay small.
    const cap = settings.fetch.maxSummaryChars
    for (let i = 0; i < parsed.items.length; i++) {
      const it = parsed.items[i]
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

    return {
      items: items,
      meta: {
        title: parsed.title || feed.title || feed.id,
        folder: feed.folder || null,
        siteUrl: parsed.siteUrl || null,
        etag: res.headers.get('etag') || null,
        lastModified: res.headers.get('last-modified') || null,
        checkedAt: now.toISOString(),
        status: res.status,
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

async function pool<T, R>(list: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(list.length)
  let next = 0
  const runners: Array<Promise<void>> = []
  const size = Math.max(1, Math.min(limit, list.length))
  for (let i = 0; i < size; i++) {
    runners.push((async function () {
      while (true) {
        const idx = next++
        if (idx >= list.length) return
        out[idx] = await worker(list[idx], idx)
      }
    })())
  }
  await Promise.all(runners)
  return out
}

type FeedRun = ({ feed: FeedDefinition; error: string } | ({ feed: FeedDefinition } & FetchOneResult))

async function runFeed(feed: FeedDefinition, prev: FeedMeta | undefined, now: Date, settings: RepoConfig): Promise<FeedRun> {
  try {
    const result = await fetchOne(feed, prev, now, settings)
    return Object.assign({ feed: feed }, result)
  } catch (err) {
    const failure = err as { message?: unknown } | null
    return { feed: feed, error: String(failure?.message || err) }
  }
}

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

// Unsubscribing (or re-deriving ids after an OPML import) leaves metadata and
// items behind. Drop both so the sidebar does not grow phantom feeds.
async function dropOrphans(itemsDir: string, live: Set<string>): Promise<number> {
  let items = 0
  for (const file of await listShards(itemsDir)) {
    const rows = await readNdjson<{ feed: string } | null>(file)
    const kept = rows.filter(function (r) { return r && live.has(r.feed) })
    if (kept.length !== rows.length) {
      items += rows.length - kept.length
      await writeNdjson(file, kept)
    }
  }
  return items
}

/**
 * Fetch one or every feed and write what changed.
 * @param {object} options
 * @param {string} options.root gitfeed checkout.
 * @param {string} [options.dataDir] output directory relative to `root`; defaults to `data`.
 * @param {string} [options.only] fetch exactly one feed id.
 * @param {string[]} [options.feeds] fetch only these feed ids (the scheduler's due set).
 * @param {boolean} [options.dryRun] fetch and report without writing.
 * @param {(line: string) => void} [options.onLog] receives every progress line.
 * @returns {{code:number, logs:string[], summary:string, feeds:number, fresh:number,
 *   unchanged:number, expired:number, failed:number, perFeed:Record<string,Object>}} fetcher result.
 */
export interface FetchOptions {
  root: string
  dataDir?: string
  only?: string
  feeds?: string[]
  dryRun?: boolean
  /** Ignore the stored validator and re-read every feed body. */
  refresh?: boolean
  onLog?: (line: string) => void
}

export async function runFetch(options: FetchOptions): Promise<FetchResult> {
  const opts = options
  const root = opts.root
  const settings = readRepoConfig(root)
  const paths = pathsFor(root)
  const dataRoot = opts.dataDir ? path.resolve(root, opts.dataDir) : paths.data
  const itemsDir = path.join(dataRoot, 'items')
  const metaFile = path.join(dataRoot, 'meta.json')
  const only = opts.only || ''
  const wanted = Array.isArray(opts.feeds) ? new Set(opts.feeds.map(String)) : null
  const restricted = only !== '' || wanted !== null
  const dryRun = opts.dryRun === true
  const refresh = opts.refresh === true
  const logs: string[] = []
  const log = function (line: string): void {
    logs.push(line)
    if (typeof opts.onLog === 'function') opts.onLog(line)
  }

  let feeds = await loadRuntimeFeeds(root)
  if (only) feeds = feeds.filter(function (feed) { return feed.id === only })
  if (wanted) feeds = feeds.filter(function (feed) { return wanted.has(feed.id) })
  if (feeds.length === 0) {
    const message = only ? `no feed with id ${only}` : 'feeds.json contains no usable feeds'
    log(message)
    return {
      code: 1, logs: logs, summary: message, feeds: 0, fresh: 0, unchanged: 0, expired: 0, failed: 0, repaired: 0,
      perFeed: {},
    }
  }

  await ensureDir(itemsDir)
  const meta = await readJson<Record<string, FeedMeta | undefined>>(metaFile, {})
  const live = new Set(feeds.map(function (feed) { return feed.id }))
  let staleFeeds = 0
  // A restricted run must not judge every other feed "unsubscribed".
  if (!restricted) {
    for (const key of Object.keys(meta)) {
      if (live.has(key)) continue
      Reflect.deleteProperty(meta, key)
      staleFeeds++
    }
  }

  // id -> archived summary length, so a feed that re-serves a longer body than
  // the archive holds can repair a copy an older, smaller cap cut short. A run
  // that writes the cache still counts the committed archive as archived:
  // otherwise every row the reader already holds from `data/` is fetched again
  // as new, and the cache fills with a second copy of the whole library.
  const known = new Map<string, number>()
  const archivedDirs = itemsDir === paths.items ? [itemsDir] : [paths.items, itemsDir]
  for (const dir of archivedDirs) {
    for (const file of await listShards(dir)) {
      const rows = await readNdjson<{ id: string; summary?: string } | null>(file)
      for (const row of rows) {
        if (!row || !row.id) continue
        const length = typeof row.summary === 'string' ? row.summary.length : 0
        const previous = known.get(row.id)
        if (previous === undefined || length > previous) known.set(row.id, length)
      }
    }
  }

  const now = new Date()
  log(`gitfeed ${now.toISOString()}  ${feeds.length} feeds`)
  if (staleFeeds) log(`  drop ${staleFeeds} stale feed(s) from meta.json`)
  if (!dryRun && !restricted) {
    const dropped = await dropOrphans(itemsDir, live)
    if (dropped) log(`  drop ${dropped} item(s) from removed feeds`)
  }

  const results = await pool(feeds, settings.fetch.concurrency, function (feed) {
    // `refresh` drops the validators so every feed answers with a body; the
    // second pass over known ids is what repairs summaries a smaller cap cut.
    return runFeed(feed, refresh ? undefined : meta[feed.id], now, settings)
  })

  const floor = cutoffKey(now, settings.fetch.keepMonths)
  const fresh: Item[] = []
  const repairs = new Map<string, { month: string; summary: string }>()
  const perFeed: Record<string, FetchFeedOutcome> = {}
  let failed = 0
  let unchanged = 0
  let expired = 0
  let repaired = 0
  for (const r of results) {
    if ('error' in r) {
      failed++
      perFeed[r.feed.id] = { added: 0, failed: true, notModified: false }
      log(`  err  ${r.feed.id.padEnd(18)} ${r.error}`)
      const prevMeta = meta[r.feed.id] || {}
      meta[r.feed.id] = Object.assign({}, prevMeta, {
        title: prevMeta.title || r.feed.title || r.feed.id,
        folder: r.feed.folder || prevMeta.folder || null,
        url: r.feed.url,
        lastError: r.error,
        checkedAt: now.toISOString(),
      })
      continue
    }
    meta[r.feed.id] = Object.assign({ url: r.feed.url, folder: r.feed.folder || null }, r.meta)
    if (r.notModified) {
      unchanged++
      perFeed[r.feed.id] = { added: 0, failed: false, notModified: true }
      log(`  ok   ${r.feed.id.padEnd(18)} unchanged`)
      continue
    }
    let added = 0
    for (const item of r.items ?? []) {
      const archived = known.get(item.id)
      if (archived !== undefined) {
        // The feed is re-serving a body longer than the archived copy, which
        // means that copy was cut by a smaller maxSummaryChars when it was
        // written. Raising the cap should heal the archive, not only new items.
        if (item.summary.length > archived && item.date.slice(0, 7) >= floor) {
          repairs.set(item.id, { month: item.date.slice(0, 7), summary: item.summary })
          known.set(item.id, item.summary.length)
        }
        continue
      }
      // Older than the retention window: never write it, and let prune() drop
      // any shard already fully out of range.
      if (item.date.slice(0, 7) < floor) {
        known.set(item.id, item.summary.length)
        expired++
        continue
      }
      known.set(item.id, item.summary.length)
      fresh.push(item)
      added++
    }
    perFeed[r.feed.id] = { added: added, failed: false, notModified: false }
    log(`  ok   ${r.feed.id.padEnd(18)} +${added} (${(r.items ?? []).length} seen)`)
  }

  if (fresh.length > 0 && !dryRun) {
    const byMonth = new Map<string, Item[]>()
    for (const item of fresh) {
      const key = item.date.slice(0, 7)
      const bucket = byMonth.get(key)
      if (bucket) bucket.push(item)
      else byMonth.set(key, [item])
    }
    const months = Array.from(byMonth.keys()).sort()
    for (const key of months) {
      const rows = (byMonth.get(key) ?? []).sort(function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0
      })
      await appendNdjson(path.join(itemsDir, `${key}.ndjson`), rows)
      log(`  write ${path.relative(root, path.join(itemsDir, `${key}.ndjson`))}  +${rows.length}`)
    }
  }

  // Repairing rewrites an existing shard in place; the append above never
  // touches a known id, so the two passes cannot see the same row.
  if (repairs.size > 0 && !dryRun) {
    const byMonth = new Map<string, Map<string, string>>()
    for (const [id, repair] of repairs) {
      let patch = byMonth.get(repair.month)
      if (!patch) {
        patch = new Map<string, string>()
        byMonth.set(repair.month, patch)
      }
      patch.set(id, repair.summary)
    }
    for (const [month, patch] of byMonth) {
      const file = path.join(itemsDir, `${month}.ndjson`)
      const rows = await readNdjson<Item | null>(file)
      // A boxed flag: the map callback runs synchronously, but a plain `let`
      // trips the unnecessary-condition rule because TS cannot see the write.
      const applied = { touched: false }
      const next = rows.map(function (row) {
        if (!row) return row
        const summary = patch.get(row.id)
        if (summary === undefined || summary.length <= (row.summary || '').length) return row
        applied.touched = true
        repaired++
        return Object.assign({}, row, { summary: summary })
      })
      if (!applied.touched) continue
      await writeNdjson(file, next)
      log(`  repair ${path.relative(root, file)}  ${patch.size} item(s)`)
    }
  }

  if (!dryRun) {
    const sorted: Record<string, FeedMeta | undefined> = {}
    Object.keys(meta).sort().forEach(function (key) { sorted[key] = meta[key] })
    await writeJson(metaFile, sorted)
    const dropped = await prune(itemsDir, now, settings.fetch.keepMonths)
    if (dropped) log(`  prune ${dropped} shard(s) older than ${settings.fetch.keepMonths} months`)
  }

  const repairedNote = repaired > 0 ? `, ${repaired} repaired` : ''
  const counts = `${unchanged} unchanged, ${expired} past retention, ${failed} failed${repairedNote}`
  const summary = `${dryRun ? 'dry-run: ' : ''}${fresh.length} new item(s), ${counts}`
  log(summary)
  return {
    code: failed === feeds.length ? 1 : 0,
    logs: logs,
    summary: summary,
    feeds: feeds.length,
    fresh: fresh.length,
    unchanged: unchanged,
    expired: expired,
    failed: failed,
    repaired: repaired,
    perFeed: perFeed,
  }
}
