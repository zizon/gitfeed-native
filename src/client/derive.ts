/**
 * Pure derivations over the reader's published state: which rows the list
 * shows and what each marking scope would touch. Nothing here reads the DOM, a
 * timer, or the network, so the rules that decide what a reader sees can be
 * exercised without a browser.
 */

import type { Feed, Item } from '../shared/types.js'
import type { Filter, MarkCounts } from './types.js'
import { plainFromHtml } from './util.js'

/** One row's searchable text: its title, its body, and the source's name. */
export function haystackOf(item: Item, sourceName: string): string {
  return `${item.title} ${plainFromHtml(item.summary)} ${sourceName}`.toLowerCase()
}

/** The name a source is shown by; an unknown id stays itself. */
export function feedTitle(feeds: ReadonlyMap<string, Feed>, id: string): string {
  const feed = feeds.get(id)
  return feed ? feed.title : id
}

/** The folder a source is grouped under, or the label for "no folder". */
export function feedFolder(
  feeds: ReadonlyMap<string, Feed>,
  id: string,
  uncategorized: string,
): string {
  const feed = feeds.get(id)
  return (feed && feed.folder) || uncategorized
}

/** The section one row belongs to under the current grouping. */
export function groupKey(
  item: Item,
  groupBy: string,
  feeds: ReadonlyMap<string, Feed>,
  uncategorized: string,
): string {
  return groupBy === 'feed' ? item.feed : feedFolder(feeds, item.feed, uncategorized)
}

/** Everything the list derivation reads from the reader's snapshot. */
export interface ReaderView {
  items: readonly Item[]
  read: ReadonlySet<string>
  starred: ReadonlySet<string>
  feeds: ReadonlyMap<string, Feed>
  filter: Filter
  query: string
  feedId: string | null
  /** Rows an implicit mark keeps on screen until the scope changes. */
  stickyRead: ReadonlySet<string>
  /** The localized label for a source that has no folder. */
  uncategorized: string
}

/** One row's searchable text; the caller owns any cache over it. */
export type Haystack = (item: Item) => string

/**
 * The rows the list shows, in the order the archive delivered them.
 * @param view - the reader's current filter, query, and scope.
 * @param haystack - one row's searchable text.
 * @returns the visible rows.
 */
export function listOf(view: ReaderView, haystack: Haystack): Item[] {
  const query = view.query.trim().toLowerCase()
  return view.items.filter(function (item) {
    if (view.filter === 'unread' && view.read.has(item.id) && !view.stickyRead.has(item.id)) return false
    if (view.filter === 'starred' && !view.starred.has(item.id)) return false
    if (view.feedId && item.feed !== view.feedId) return false
    if (query && haystack(item).indexOf(query) === -1) return false
    return true
  })
}

/** One section of the list when grouping is on. */
export interface Group {
  key: string
  label: string
  items: Item[]
}

/** One rendered row. */
export interface RowEntry {
  kind: 'row'
  key: string
  item: Item
  h: number
}

/** One rendered section header. */
export interface GroupEntry {
  kind: 'group'
  key: string
  group: Group
  h: number
}

export type Entry = RowEntry | GroupEntry

/**
 * The rows the list renders, section headers included.
 * @param list - the rows the filter left, in archive order.
 * @param groupBy - `none`, `folder`, or `feed`.
 * @param rowHeight - one row's height at the current density.
 * @param groupHeight - one section header's height.
 * @param titleOf - a source's display name.
 * @param folderOf - the folder a source groups under.
 * @returns the flattened entries the viewport windows over.
 */
export function entriesOf(
  list: readonly Item[],
  groupBy: string,
  rowHeight: number,
  groupHeight: number,
  titleOf: (feedId: string) => string,
  folderOf: (feedId: string) => string,
): Entry[] {
  if (groupBy === 'none') {
    return list.map(function (item) { return { kind: 'row', key: item.id, item: item, h: rowHeight } })
  }
  const groups = new Map<string, Group>()
  for (const item of list) {
    const key = groupBy === 'feed' ? item.feed : folderOf(item.feed)
    const bucket = groups.get(key)
    if (bucket) bucket.items.push(item)
    else groups.set(key, { key: key, label: groupBy === 'feed' ? titleOf(item.feed) : key, items: [item] })
  }
  // Sections hold one order: by name, the way the rail lists folders and feeds.
  // Ordering by size re-ranked every section whenever a fetch landed, so the
  // section being read could move somewhere else under the pointer.
  const ordered = Array.from(groups.values()).sort(function (a, b) {
    return a.label.localeCompare(b.label) || a.key.localeCompare(b.key)
  })
  const out: Entry[] = []
  for (const group of ordered) {
    out.push({ kind: 'group', key: `group:${group.key}`, group: group, h: groupHeight })
    for (const item of group.items) out.push({ kind: 'row', key: item.id, item: item, h: rowHeight })
  }
  return out
}

/**
 * What each marking scope would touch, so the menu can state the size before
 * it acts.
 * @param view - the reader's current scope.
 * @param visible - the rows on screen, already filtered and searched.
 * @returns one count per scope the mark menu offers.
 */
export function markCountsOf(view: ReaderView, visible: readonly Item[]): MarkCounts {
  let results = 0
  for (const item of visible) {
    if (!view.read.has(item.id)) results += 1
  }
  const folder = view.feedId ? feedFolder(view.feeds, view.feedId, view.uncategorized) : null
  let source = 0
  let folderCount = 0
  let all = 0
  for (const item of view.items) {
    if (view.read.has(item.id)) continue
    all += 1
    if (view.feedId && item.feed === view.feedId) source += 1
    if (folder && feedFolder(view.feeds, item.feed, view.uncategorized) === folder) folderCount += 1
  }
  return { results: results, source: source, folder: folderCount, all: all, folderName: folder }
}
