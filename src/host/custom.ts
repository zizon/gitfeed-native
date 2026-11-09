// Custom feeds: a subscription whose items come from a script.
//
// A `feeds.json` entry may declare `"type": "custom"` and name a `script` that
// lives in the data root's `sources/`. The script is loaded, called, and
// returns a **pseudo feed** — the shape an RSS parser produces, without the
// transport. Everything downstream is the ordinary feed path: item ids,
// de-duplication, retention, the archive, the reader, the agent tool. That
// boundary is the whole feature: one interface, and a custom source is a feed.
//
// The script owns its requests. It is handed the subscription, the validators
// the previous run stored, a `fetch`, and the fetcher's deadline, and it
// decides what to ask for, with which headers, and how many times. The fetcher
// stores back the validators it reports and walks its items like any other
// feed's — so a script is free to be a JSON API, a paginated page, or a
// two-step lookup, and the reader still cannot tell the difference.

import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SourceKind } from '../shared/types.js'
import { textOf } from './xml.js'
import type { ParsedItem } from './xml.js'

/**
 * A script is a `.mjs` file in the data root — the user's own part of the
 * repository, next to the subscriptions it serves, conventionally under
 * `sources/`. The path is relative to the root and is resolved there: an
 * absolute path, or one that resolves outside the root, is refused.
 */
const SCRIPT_SUFFIX = /\.mjs$/i

/** What a custom feed returns. */
export interface CustomFeed {
  /** The feed's display name; falls back to the subscription's title. */
  title?: string | null
  siteUrl?: string | null
  /**
   * Validators for the next run, stored in `meta.json` and handed back in.
   * Omit them when the source did not revalidate; `null` forgets them.
   */
  etag?: string | null
  lastModified?: string | null
  /** The entries. An empty array is a quiet run, not a failure. */
  items: CustomItem[]
}

/** One entry a script returns; only `title` or `link` need to be set. */
export interface CustomItem {
  /** Stable key for the archive; `link` is used when it is absent. */
  id?: string | null
  title?: string | null
  link?: string | null
  /** ISO 8601, a Unix timestamp, or a `Date`. */
  date?: string | number | Date | null
  author?: string | null
  summary?: string | null
}

/** A validated pseudo feed: the shape the fetcher works with. */
export interface CustomRead {
  title: string | null
  siteUrl: string | null
  /** `undefined` when the script did not report one, which keeps the stored. */
  etag: string | null | undefined
  lastModified: string | null | undefined
  items: ParsedItem[]
}

/** What a custom feed script is called with. */
export interface CustomInput {
  /** The subscription's id, as `feeds.json` or the fetcher resolved it. */
  id: string
  /** The subscription's URL. The script decides whether to request it. */
  url: string
  /** The subscription's configured title, when it has one. */
  title: string | null
  /** The entry's `options`, passed through untouched. */
  options: unknown
  /** The validators the previous run stored. */
  meta: { etag: string | null; lastModified: string | null }
  /** The fetcher's own fetch, so a proxy or a stub applies to the script too. */
  fetch: typeof globalThis.fetch
  /** Aborted when the fetch deadline passes: pass it to every request. */
  signal: AbortSignal
}

/** The validated `type`/`script`/`options` of one entry. */
export interface CustomDeclaration {
  script: string
  options: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * How an entry is fetched.
 * @param entry a `feeds.json` entry, or the runtime shape built from one.
 * @returns `rss` when it declares nothing, `custom` when it declares that.
 */
export function kindOf(entry: { type?: unknown }): SourceKind {
  const type = entry.type
  if (type === undefined || type === null || type === 'rss') return 'rss'
  if (type === 'custom') return 'custom'
  throw new Error(`feed.type: expected rss or custom; got ${JSON.stringify(type)}`)
}

/**
 * Validate one entry's declaration and return what a custom feed needs.
 *
 * Runs before the fetch touches the network: a typo in `feeds.json` is that
 * feed's own error, on its own row, and the run carries on.
 * @param entry the subscription.
 * @returns the script name and options, or null for an RSS/Atom feed.
 */
export function declarationOf(entry: { type?: unknown; script?: unknown; options?: unknown }): CustomDeclaration | null {
  if (kindOf(entry) === 'rss') {
    if (entry.script !== undefined && entry.script !== null) {
      throw new Error('feed.script: only a custom feed has a script')
    }
    return null
  }
  const script = typeof entry.script === 'string' ? entry.script.trim() : ''
  if (!script) throw new Error('feed.script: a custom feed names a script in the data root')
  if (!SCRIPT_SUFFIX.test(script)) throw new Error(`feed.script: ${JSON.stringify(script)} is not a .mjs file`)
  if (path.isAbsolute(script)) throw new Error(`feed.script: ${JSON.stringify(script)} must be relative to the data root`)
  return { script: script, options: entry.options }
}

/**
 * Resolve the script file, and keep it inside the data root.
 *
 * A data root is cloned from remotes, so the rule that a subscription cannot
 * run code from outside the repository it belongs to is enforced on the
 * resolved path: a symlink out of the root is refused like a written path.
 * @param root the data root.
 * @param script the relative path from the declaration.
 * @returns the file's real path.
 */
export async function scriptFile(root: string, script: string): Promise<string> {
  const wanted = path.resolve(root, script)
  let file: string
  try {
    file = await realpath(wanted)
  } catch {
    throw new Error(`custom feed: no script at ${wanted}`)
  }
  const base = await realpath(root)
  const inside = path.relative(base, file)
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`custom feed: ${script} resolves outside ${root}`)
  }
  const info = await stat(file)
  if (!info.isFile()) throw new Error(`custom feed: ${wanted} is not a file`)
  return file
}

/** A JSON-ish value as text: strings, digits, ISO dates, and the usual wrappers. */
function texts(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const entry of value) {
      const one = texts(entry)
      if (one) parts.push(one)
    }
    return parts.join(', ')
  }
  if (isRecord(value)) {
    for (const key of ['name', 'title', 'text', 'rendered', 'value', 'url', 'href']) {
      const one = texts(value[key])
      if (one) return one
    }
  }
  return ''
}

function readItem(row: unknown, name: string, index: number): ParsedItem {
  if (!isRecord(row)) throw new Error(`custom feed: ${name} item ${index} is not an object`)
  return {
    guid: texts(row.id) || texts(row.guid),
    // A title and an author are prose even when the API hands back a rendered
    // field; a summary is markup by design and is kept as it came.
    title: textOf(texts(row.title)),
    link: texts(row.link).trim(),
    date: texts(row.date).trim(),
    author: textOf(texts(row.author)),
    summary: texts(row.summary),
  }
}

/**
 * Read what a script returned, and refuse anything that is not a pseudo feed.
 * @param value the script's return value.
 * @param name the script's file name, for the message.
 * @returns the validated feed.
 */
function readCustomFeed(value: unknown, name: string): CustomRead {
  if (!isRecord(value)) throw new Error(`custom feed: ${name} returned ${Array.isArray(value) ? 'an array' : typeof value} instead of an object`)
  if (!Array.isArray(value.items)) throw new Error(`custom feed: ${name} returned no "items" array`)
  return {
    title: texts(value.title) || null,
    siteUrl: texts(value.siteUrl) || null,
    // Absent means "this run did not revalidate", which keeps what is stored;
    // a null or an empty string forgets it.
    etag: value.etag === undefined ? undefined : texts(value.etag) || null,
    lastModified: value.lastModified === undefined ? undefined : texts(value.lastModified) || null,
    items: value.items.map(function (row, index) { return readItem(row, name, index) }),
  }
}

/**
 * Load a script and call it.
 * @param file the resolved script path.
 * @param input the subscription, the stored validators, and the deadline.
 * @returns the pseudo feed the script produced.
 */
export async function runCustom(file: string, input: CustomInput): Promise<CustomRead> {
  const name = path.basename(file)
  const info = await stat(file)
  // The mtime keeps the ESM cache from pinning the first version of a script
  // across an edit: a custom feed is code its author iterates on.
  const loaded = await import(`${pathToFileURL(file).href}?v=${info.mtimeMs}`) as Record<string, unknown>
  if (typeof loaded.default !== 'function') {
    throw new Error(`custom feed: ${name} exports no default function`)
  }
  const value: unknown = await (loaded.default as (input: CustomInput) => unknown)(input)
  return readCustomFeed(value, name)
}

/**
 * The skeleton `gitfeed_custom_feed scaffold` writes: the interface as comments,
 * and the one check a scraper must make — that its split still matched.
 */
export const CUSTOM_FEED_TEMPLATE = `// A gitfeed custom feed.
//
// The default export is called with one object and returns a pseudo feed:
//
//   input.id, input.url, input.title   the subscription
//   input.options                      the entry's "options", untouched
//   input.meta                         { etag, lastModified } from the last run
//   input.fetch                        use this instead of the global fetch
//   input.signal                       aborted at fetch.timeoutMs; pass it on
//
//   return { title?, siteUrl?, etag?, lastModified?, items }
//   item   { id?, title?, link?, date?, author?, summary? }
//
// Throw when the page stops looking like it used to: that is what puts the
// feed's row in the reader's error colour. Return no items when there is
// genuinely nothing new.
//
// Then check it and subscribe it:
//   gitfeed_custom_feed { action: 'check', script: '<this file>', url: '<the page>' }
//   gitfeed_custom_feed { action: 'subscribe', script: '<this file>', url: '<the page>' }

export default async function (input) {
  const answer = await input.fetch(input.url, {
    headers: { 'user-agent': 'gitfeed/3 (+https://github.com/zizon/gitfeed-native)' },
    redirect: 'follow',
    signal: input.signal,
  })
  if (!answer.ok) throw new Error('HTTP ' + answer.status)
  const body = await answer.text()

  const items = []
  // Cut the body into one piece per item and pull the fields out of each piece,
  // e.g.:
  //
  //   for (const chunk of body.split('<li class="result">').slice(1)) {
  //     const title = /<h3[^>]*>([\\s\\S]*?)<\\/h3>/.exec(chunk)
  //     const href = /<a[^>]*href="([^"]+)"/.exec(chunk)
  //     if (!title || !href) continue
  //     items.push({ title: title[1], link: new URL(href[1], input.url).href })
  //   }

  if (items.length === 0) throw new Error('no items matched on the page')
  return { title: input.title || input.url, siteUrl: new URL(input.url).origin, items: items }
}
`

/** A script name is a file name under `sources/`, never a path. */
const SCAFFOLD_NAME = /^[a-z0-9][a-z0-9._-]*$/

/**
 * Where a scaffold writes, from the name an author typed.
 * @param root the data root.
 * @param name the script name, with or without the `.mjs` suffix.
 * @returns the path as `feeds.json` writes it, and on disk.
 */
export function scaffoldPath(root: string, name: string): { script: string; file: string } {
  const trimmed = (name || '').trim().toLowerCase().replace(/\.mjs$/, '')
  if (!SCAFFOLD_NAME.test(trimmed)) {
    throw new Error('custom feed: name the script in lower-case letters, digits, dot, dash, or underscore')
  }
  return { script: `sources/${trimmed}.mjs`, file: path.join(root, 'sources', `${trimmed}.mjs`) }
}
