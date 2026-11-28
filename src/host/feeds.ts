// Feed list helpers: ids, URL normalisation, discovery, and feeds.json access.

import { parseFeed } from './xml.js'
import { PAGE_ACCEPT, USER_AGENT, classifyDocument, readDocument } from './document.js'
import { pathsFor } from './settings.js'
import { InputError } from '../shared/errors.js'
import { readJson, writeJson } from './store.js'
import type { FeedDefinition } from './types.js'

const FEED_TYPE = /(rss|atom|xml)/i

export function slug(input: string): string {
  const s = (input || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s || 'feed'
}

export function feedIdFor(url: string): string {
  const u = new URL(url)
  return slug(u.hostname.replace(/^www\./, '') + u.pathname)
}

/**
 * The ids subscriptions are archived under.
 *
 * One owner, because the fetcher writes rows, metadata, and its scheduler's
 * clocks keyed by these ids, and the digest decides what to show by comparing a
 * row's feed against the same ids: two derivations would be two answers, and a
 * row would become invisible under one of them.
 *
 * An entry keeps the id feeds.json gave it, verbatim — that string is the
 * identity its archive already lives under, so re-slugging it would move the
 * feed's rows and read state to a different key. Only a missing id is derived
 * from the URL. A repeated id is numbered in file order, which is the only
 * ordering the file itself carries; every reader of the list sees the same
 * numbering because they all come through here.
 * @param entries - the raw `feeds` array, in file order.
 * @returns one id per entry, aligned by index; an empty string for a null row.
 */
export function assignFeedIds(entries: ReadonlyArray<{ id?: unknown; url?: unknown } | null>): string[] {
  const used = new Set<string>()
  return entries.map(function (entry) {
    if (!entry) return ''
    let id = ''
    if (typeof entry.id === 'string' && entry.id.trim()) {
      id = entry.id.trim()
    } else if (typeof entry.url === 'string' && entry.url.trim()) {
      try {
        id = feedIdFor(entry.url)
      } catch {
        // A URL that cannot be parsed still belongs to a row the reader can
        // see; its id only has to be stable and unique, not meaningful.
        id = slug(entry.url)
      }
    } else {
      id = 'feed'
    }
    const base = id
    let unique = base
    let n = 2
    while (used.has(unique)) unique = `${base}-${n++}`
    used.add(unique)
    return unique
  })
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return (u.origin + u.pathname + u.search).replace(/\/$/, '').toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

/**
 * Index subscriptions by the key two spellings of one feed share.
 *
 * The list is de-duplicated and updated through this index, so a URL is
 * normalized once per list instead of once per comparison. It is deliberately
 * not stored on a {@link FeedDefinition}: `normalizeUrl` folds case and drops
 * the fragment and a trailing slash, which makes it a usable comparison key
 * and a lossy URL — the entry's `url` stays exactly what the fetcher requests.
 * A later entry for the same key replaces the earlier one, the way the index
 * in `mergeOpml` has always been written.
 * @param feeds subscriptions, usually straight from `readFeeds`.
 * @returns comparison key -> subscription.
 */
export function indexFeeds(feeds: FeedDefinition[]): Map<string, FeedDefinition> {
  const index = new Map<string, FeedDefinition>()
  for (const feed of feeds) {
    if (!feed.url) continue
    index.set(normalizeUrl(feed.url), feed)
  }
  return index
}

export async function readFeeds(root: string): Promise<FeedDefinition[]> {
  const raw = await readJson<{ feeds?: unknown }>(pathsFor(root).feeds, { feeds: [] })
  const entries = Array.isArray(raw.feeds) ? raw.feeds as Array<FeedDefinition | null> : []
  const ids = assignFeedIds(entries)
  const feeds: FeedDefinition[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    // Only an entry whose file spelling differs from the assigned id is copied:
    // a written-back list then carries the ids the archive is keyed by.
    feeds.push(entry.id === ids[i] ? entry : Object.assign({}, entry, { id: ids[i] }))
  }
  return feeds
}

export async function writeFeeds(root: string, feeds: FeedDefinition[]): Promise<void> {
  await writeJson(pathsFor(root).feeds, {
    '$comment': 'Subscription list. Edit by hand, use Add feed in the reader, or run `gitfeed import-opml`; then Sync.',
    feeds: feeds,
  })
}

// Find <link rel="alternate" type="application/rss+xml" href="..."> on a site.
function discoverFeed(html: string, base: string): string | null {
  const re = /<link\b[^>]*>/gi
  let m
  while ((m = re.exec(html))) {
    const tag = m[0]
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (!type || !FEED_TYPE.test(type[1])) continue
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)
    if (!href) continue
    try {
      return new URL(href[1], base).href
    } catch {
      return null
    }
  }
  return null
}

// Accept either a feed URL or a site URL; return the feed URL plus its title.
export interface ResolvedFeed {
  url: string
  title: string | null
  items: number
}

/**
 * The URL a custom feed is handed: it is taken as given, because the script —
 * not feed discovery — decides what to do with it.
 * @param raw configured URL.
 * @returns the absolute URL.
 */
export function sourceUrl(raw: string): string {
  let url: URL
  try {
    url = new URL((raw || '').trim())
  } catch {
    throw new InputError('not a valid URL')
  }
  if (!/^https?:$/i.test(url.protocol)) throw new InputError('only http(s) URLs are supported')
  return url.href
}

export async function resolveFeed(rawUrl: string, depth?: number): Promise<ResolvedFeed> {
  const level = depth || 0
  if (level > 2) throw new InputError('feed discovery loop')
  let url
  try {
    url = new URL(rawUrl.trim()).href
  } catch {
    throw new InputError('not a valid URL')
  }
  if (!/^https?:/i.test(url)) throw new InputError('only http(s) URLs are supported')

  const res = await readDocument(url, {
    headers: { 'user-agent': USER_AGENT, accept: PAGE_ACCEPT },
    signal: AbortSignal.timeout(20000),
  })
  if (res.status < 200 || res.status > 299) throw new Error(`HTTP ${res.status}`)

  if (classifyDocument(res.headers.get('content-type'), res.body) === 'feed') {
    const parsed = parseFeed(res.body)
    if (!parsed.items.length && !parsed.title) throw new InputError('no items found in feed')
    return { url: res.finalUrl, title: parsed.title || null, items: parsed.items.length }
  }

  const discovered = discoverFeed(res.body, res.finalUrl)
  if (!discovered) {
    throw new InputError('no RSS/Atom feed found on that page — a custom feed script can read a page like this instead')
  }
  return resolveFeed(discovered, level + 1)
}
