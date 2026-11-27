// OPML import: read an export from Inoreader, Feedly, NetNewsWire, and the
// like, and merge it into feeds.json. Shared by the CLI and the reader's
// Import OPML row; the Add feed box covers the one-feed case.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { InputError } from '../shared/errors.js'
import { feedIdFor, indexFeeds, normalizeUrl, readFeeds, writeFeeds } from './feeds.js'
import type { FeedDefinition } from './types.js'
import { attr, decodeEntities } from './xml.js'

export interface OpmlEntry {
  url: string
  title: string | null
  folder: string | null
}

export interface ImportSummary {
  total: number
  added: number
  updated: number
  kept: number
  duplicates: number
  invalid: number
  folders: Record<string, number>
}

function folderLabel(raw: string | null | undefined): string | null {
  const text = decodeEntities(raw || '').trim()
  return text || null
}

/**
 * Read the feed entries out of an OPML document. Folder nesting becomes the
 * nearest enclosing `<outline>` without an `xmlUrl`.
 * @param xml OPML document.
 * @returns feed entries in document order.
 */
export function parseOpml(xml: string): OpmlEntry[] {
  const feeds: OpmlEntry[] = []
  const stack: string[] = []
  const re = /<outline\b([^>]*)>|<\/outline\s*>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    if (!match[1] && match[0].charAt(1) === '/') {
      stack.pop()
      continue
    }
    const raw = match[1] || ''
    const selfClosing = /\/\s*$/.test(raw)
    const attrs = selfClosing ? raw.replace(/\/\s*$/, '') : raw
    const url = attr(attrs, 'xmlUrl') || attr(attrs, 'url')
    if (url) {
      feeds.push({
        url: url,
        title: folderLabel(attr(attrs, 'title') || attr(attrs, 'text')),
        folder: stack.length ? stack[stack.length - 1] : null,
      })
      continue
    }
    if (selfClosing) continue
    stack.push(folderLabel(attr(attrs, 'text') || attr(attrs, 'title')) || 'Uncategorized')
  }
  return feeds
}

/**
 * Merge (or replace) `feeds.json` from an OPML document.
 *
 * In merge mode the OPML entries win because they carry folders; feeds already
 * subscribed but missing from the export are kept under "Uncategorized". A
 * document with no feed outlines is refused rather than applied: in replace
 * mode it would empty the subscription list, and the wrong file is far more
 * likely than a deliberate reset.
 * @param root data root.
 * @param xml OPML document.
 * @param options `replace` throws the old list away.
 * @returns counts for the caller to print or report.
 */
export async function mergeOpml(root: string, xml: string, options?: { replace?: boolean }): Promise<ImportSummary> {
  const parsed = parseOpml(xml)
  if (!parsed.length) throw new InputError('no feed outlines found in that OPML document')
  // Read in both modes: replace still needs the old list for identity (an id
  // and a custom feed's declaration the document cannot carry), which is the
  // one part of a takeover that is not describe-able by the document alone.
  const existing = indexFeeds(await readFeeds(root))
  const draft = options && options.replace ? replaceWith(parsed, existing) : mergeInto(parsed, existing)
  await writeFeeds(root, draft.feeds)
  return {
    total: draft.feeds.length,
    added: draft.added,
    updated: draft.updated,
    kept: draft.kept,
    duplicates: draft.duplicates,
    invalid: draft.invalid,
    folders: draft.folders,
  }
}

/** The subscription list an import is building, and the tallies that report it. */
interface Draft {
  feeds: FeedDefinition[]
  folders: Record<string, number>
  used: Set<string>
  added: number
  updated: number
  kept: number
  duplicates: number
  invalid: number
}

function emptyDraft(): Draft {
  return { feeds: [], folders: {}, used: new Set(), added: 0, updated: 0, kept: 0, duplicates: 0, invalid: 0 }
}

/**
 * Claim a unique id and append one entry.
 *
 * Ids are disambiguated here rather than in a pass over the finished list, so
 * the suffixing order is the order entries are kept and the list, the id set,
 * and the folder tally cannot drift from each other.
 */
function keep(draft: Draft, wanted: FeedDefinition): void {
  let id = wanted.id
  let n = 2
  while (draft.used.has(id)) id = `${wanted.id}-${n++}`
  draft.used.add(id)
  draft.feeds.push({ ...wanted, id })
  const folder = wanted.folder || 'Uncategorized'
  draft.folders[folder] = (draft.folders[folder] || 0) + 1
}

/**
 * Replace: the document is the list.
 *
 * The existing list is read only to keep an id and a custom feed's declaration
 * for an entry the document re-describes, and for nothing else — there is no
 * kept half, because nothing outside the document survives a replace.
 * @param parsed the document's feed outlines.
 * @param existing the list being replaced, by comparison key.
 * @returns the document as the new list.
 */
function replaceWith(parsed: OpmlEntry[], existing: Map<string, FeedDefinition>): Draft {
  return adoptDocument(parsed, existing).draft
}

/**
 * Merge: the document's entries are upserted, then the rest of the old list is
 * kept.
 * @param parsed the document's feed outlines.
 * @param existing the list being merged into, by comparison key.
 * @returns the old list with the document applied.
 */
function mergeInto(parsed: OpmlEntry[], existing: Map<string, FeedDefinition>): Draft {
  const { draft, matched } = adoptDocument(parsed, existing)
  keepUnmentioned(draft, existing, matched)
  return draft
}

/**
 * Adopt the document: its entries become the list, in document order.
 *
 * An entry the existing list already has keeps that entry's id and custom-feed
 * declaration — OPML describes feeds, never the script behind a custom one — and
 * counts as updated; anything else is added. A URL that appears twice in the
 * document is kept once, and one that names no feed is counted and skipped.
 * @param parsed the document's feed outlines.
 * @param existing the list being replaced or merged into, by comparison key.
 * @returns the draft, and the keys the document spoke for.
 */
function adoptDocument(parsed: OpmlEntry[], existing: Map<string, FeedDefinition>): { draft: Draft; matched: Set<string> } {
  const draft = emptyDraft()
  const seen = new Set<string>()
  const matched = new Set<string>()
  for (const entry of parsed) {
    const key = normalizeUrl(entry.url)
    if (seen.has(key)) {
      draft.duplicates++
      continue
    }
    seen.add(key)
    let base: string
    try {
      base = feedIdFor(entry.url)
    } catch {
      draft.invalid++
      continue
    }
    const previous = existing.get(key)
    matched.add(key)
    if (previous) draft.updated++
    else draft.added++
    const adopted: FeedDefinition = {
      id: previous && previous.id ? previous.id : base,
      url: entry.url,
      title: entry.title || (previous ? previous.title : null),
      folder: entry.folder || (previous && previous.folder) || 'Uncategorized',
    }
    if (previous) {
      if (previous.type !== undefined) adopted.type = previous.type
      if (previous.script !== undefined) adopted.script = previous.script
      if (previous.options !== undefined) adopted.options = previous.options
    }
    keep(draft, adopted)
  }
  return { draft, matched }
}

/**
 * Append the subscriptions the document did not mention, in their old order.
 *
 * This is the merge half only: a replace never calls it, because there is
 * nothing outside the document for the list to hold.
 * @param draft the list already adopted from the document.
 * @param existing the list that was read for identity.
 * @param matched the keys the document spoke for.
 */
function keepUnmentioned(draft: Draft, existing: Map<string, FeedDefinition>, matched: Set<string>): void {
  for (const [key, entry] of existing) {
    if (matched.has(key)) continue
    let base: string
    try {
      base = entry.id || feedIdFor(entry.url)
    } catch {
      continue
    }
    keep(draft, {
      id: base,
      url: entry.url,
      title: entry.title || null,
      folder: entry.folder || 'Uncategorized',
      type: entry.type,
      script: entry.script,
      options: entry.options,
    })
    draft.kept++
  }
}

/**
 * Merge (or replace) `feeds.json` from an OPML file.
 * @param root data root.
 * @param file OPML file path.
 * @param options `replace` throws the old list away.
 * @returns counts for the CLI to print.
 */
export async function importOpml(root: string, file: string, options?: { replace?: boolean }): Promise<ImportSummary> {
  const xml = await readFile(path.resolve(file), 'utf8')
  return mergeOpml(root, xml, options)
}

/** One XML attribute value, quoted for a double-quoted attribute. */
function attrValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Write the subscription list as OPML 2.0.
 *
 * Folders become nested outlines, in the order they first appear in
 * feeds.json; a feed with no folder (or the reader's `Uncategorized`) sits at
 * the top level. Titles fall back to the URL when an entry has none, which is
 * what a reader that has never fetched the feed holds. A custom feed exports as
 * its URL like any other: OPML has no way to describe the script behind it, so
 * that declaration has to be made again on the reader it is imported into.
 * @param feeds subscriptions to write.
 * @returns the document.
 */
export function exportOpml(feeds: FeedDefinition[]): string {
  const folders = new Map<string, FeedDefinition[]>()
  const loose: FeedDefinition[] = []
  for (const feed of feeds) {
    if (!feed.url) continue
    const folder = (feed.folder || '').trim()
    if (!folder || folder === 'Uncategorized') {
      loose.push(feed)
      continue
    }
    const list = folders.get(folder) || []
    list.push(feed)
    folders.set(folder, list)
  }
  const outline = (feed: FeedDefinition, indent: string): string => {
    const title = attrValue(feed.title || feed.url)
    return `${indent}<outline type="rss" text="${title}" title="${title}" xmlUrl="${attrValue(feed.url)}" />`
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    '    <title>gitfeed subscriptions</title>',
    '  </head>',
    '  <body>',
  ]
  for (const feed of loose) lines.push(outline(feed, '    '))
  for (const [folder, list] of folders) {
    const name = attrValue(folder)
    lines.push(`    <outline text="${name}" title="${name}">`)
    for (const feed of list) lines.push(outline(feed, '      '))
    lines.push('    </outline>')
  }
  lines.push('  </body>', '</opml>', '')
  return lines.join('\n')
}
