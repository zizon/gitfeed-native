// OPML import: read an export from Inoreader, Feedly, NetNewsWire, and the
// like, and merge it into feeds.json. Shared by the CLI; the reader's Add feed
// box covers the one-feed case.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { feedIdFor, normalizeUrl, readFeeds, writeFeeds } from './feeds.js'
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
 * Merge (or replace) `feeds.json` from an OPML file.
 *
 * In merge mode the OPML entries win because they carry folders; feeds already
 * subscribed but missing from the export are kept under "Uncategorized".
 * @param root data root.
 * @param file OPML file path.
 * @param options `replace` throws the old list away.
 * @returns counts for the CLI to print.
 */
export async function importOpml(root: string, file: string, options?: { replace?: boolean }): Promise<ImportSummary> {
  const replace = !!(options && options.replace)
  const xml = await readFile(path.resolve(file), 'utf8')
  const parsed = parseOpml(xml)

  const existing = new Map<string, { id: string; url: string; title: string | null; folder: string | null }>()
  if (!replace) {
    for (const entry of await readFeeds(root)) {
      if (!entry.url) continue
      existing.set(normalizeUrl(entry.url), entry)
    }
  }

  const seen = new Set<string>()
  const feeds: Array<{ id: string; url: string; title: string | null; folder: string | null }> = []
  let added = 0
  let updated = 0
  let duplicates = 0
  let invalid = 0
  for (const entry of parsed) {
    const key = normalizeUrl(entry.url)
    if (seen.has(key)) {
      duplicates++
      continue
    }
    seen.add(key)
    let id: string
    try {
      id = feedIdFor(entry.url)
    } catch {
      invalid++
      continue
    }
    const previous = existing.get(key)
    if (previous) {
      existing.delete(key)
      updated++
    } else {
      added++
    }
    feeds.push({
      id: previous && previous.id ? previous.id : id,
      url: entry.url,
      title: entry.title || (previous ? previous.title : null),
      folder: entry.folder || (previous && previous.folder) || 'Uncategorized',
    })
  }

  // Merge mode keeps subscriptions the export does not mention.
  let kept = 0
  for (const entry of existing.values()) {
    let id: string
    try {
      id = entry.id || feedIdFor(entry.url)
    } catch {
      continue
    }
    feeds.push({ id: id, url: entry.url, title: entry.title || null, folder: entry.folder || 'Uncategorized' })
    kept++
  }

  // ids must be unique; the fetcher would disambiguate, but then meta.json and
  // feeds.json would disagree, so do it here.
  const used = new Set<string>()
  for (const entry of feeds) {
    let id = entry.id
    let n = 2
    while (used.has(id)) id = `${entry.id}-${n++}`
    used.add(id)
    entry.id = id
  }

  const folders: Record<string, number> = {}
  for (const entry of feeds) {
    const folder = entry.folder || 'Uncategorized'
    folders[folder] = (folders[folder] || 0) + 1
  }

  await writeFeeds(root, feeds)
  return {
    total: feeds.length,
    added: added,
    updated: updated,
    kept: kept,
    duplicates: duplicates,
    invalid: invalid,
    folders: folders,
  }
}
