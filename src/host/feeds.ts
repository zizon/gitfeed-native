// Feed list helpers: ids, URL normalisation, discovery, and feeds.json access.

import { parseFeed } from './xml.js'
import { pathsFor } from './settings.js'
import { readJson, writeJson } from './store.js'
import type { FeedDefinition } from './types.js'

const UA = 'gitfeed/2.0 (+https://github.com; personal RSS reader)'
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

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return (u.origin + u.pathname + u.search).replace(/\/$/, '').toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

export async function readFeeds(root: string): Promise<FeedDefinition[]> {
  const raw = await readJson<{ feeds?: unknown }>(pathsFor(root).feeds, { feeds: [] })
  const entries = Array.isArray(raw.feeds) ? raw.feeds as Array<FeedDefinition | null> : []
  return entries.filter(function (entry): entry is FeedDefinition { return entry !== null })
}

export async function writeFeeds(root: string, feeds: FeedDefinition[]): Promise<void> {
  await writeJson(pathsFor(root).feeds, {
    '$comment': 'Subscription list. Edit by hand, use Add feed in the reader, or run `gitfeed import-opml`; then Sync.',
    feeds: feeds,
  })
}

// Content-type alone is not enough: some sites serve XHTML as
// application/xhtml+xml, which would slip past an /xml/ test and then parse as
// an empty feed. Look at what the document actually is.
function looksLikeFeed(contentType: string | null, body: string): boolean {
  const head = body
    .slice(0, 2000)
    .replace(/^\uFEFF/, '')
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, '')
    .replace(/^\s*<!--[\s\S]*?-->\s*/, '')
    .trimStart()
  if (/^<(rss|feed|rdf)\b/i.test(head)) return true
  if (/^<(!doctype\s+html|html)\b/i.test(head)) return false
  return /(rss|atom)\+xml/i.test(contentType || '')
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
    throw new Error('not a valid URL')
  }
  if (!/^https?:$/i.test(url.protocol)) throw new Error('only http(s) URLs are supported')
  return url.href
}

export async function resolveFeed(rawUrl: string, depth?: number): Promise<ResolvedFeed> {
  const level = depth || 0
  if (level > 2) throw new Error('feed discovery loop')
  let url
  try {
    url = new URL(rawUrl.trim()).href
  } catch {
    throw new Error('not a valid URL')
  }
  if (!/^https?:/i.test(url)) throw new Error('only http(s) URLs are supported')

  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.text()
  const finalUrl = res.url || url

  if (looksLikeFeed(res.headers.get('content-type'), body)) {
    const parsed = parseFeed(body)
    if (!parsed.items.length && !parsed.title) throw new Error('no items found in feed')
    return { url: finalUrl, title: parsed.title || null, items: parsed.items.length }
  }

  const discovered = discoverFeed(body, finalUrl)
  if (!discovered) {
    throw new Error('no RSS/Atom feed found on that page — a custom feed script can read a page like this instead')
  }
  return resolveFeed(discovered, level + 1)
}
