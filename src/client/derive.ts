/**
 * Pure derivations over the reader's published state: which rows the list
 * shows and what each marking scope would touch. Nothing here reads the DOM, a
 * timer, or the network, so the rules that decide what a reader sees can be
 * exercised without a browser.
 */

import type { Feed, Item } from '../shared/types.js'
import type { Filter, MarkCounts } from './types.js'

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

/**
 * Every folder name in use, sorted.
 *
 * A picker offers the folders the reader already has, so a move lands in one
 * of them instead of inventing a spelling next to it. The names are the ones
 * `feeds.json` stores, not the label this UI groups a folderless feed under:
 * what a picker writes is user data, and it must not change with the language.
 * @param feeds the sources as loaded.
 * @returns the stored names, without duplicates.
 */
export function folderNames(feeds: readonly Feed[]): string[] {
  const names = new Set<string>()
  for (const feed of feeds) {
    if (feed.folder) names.add(feed.folder)
  }
  return Array.from(names).sort(function (a, b) { return a.localeCompare(b) })
}

/**
 * The reader's order over its sources: the ones it actually reads first, the
 * rest by name.
 *
 * A source earns a place in the ranked part only when the attention log gave it
 * a score (the theory is in `shared/interest.ts`). Everything else keeps the
 * alphabetical order it always had, so an untried source is never buried below
 * a familiar one — it is simply not preferred. A folder takes the place of its
 * best source, so the top of the rail is the feed the reader reads rather than
 * whichever folder's name sorts first.
 */
export interface SourceOrder {
  /** Position of each source the caller passed. */
  rank: Map<string, number>
  /** Position of each folder, by its best-ranked source. */
  folders: Map<string, number>
  /** The position of a source the order has no entry for: after all of them. */
  next: number
}

/**
 * Build the order the rail and the grouped list both draw from.
 * @param feeds - the subscriptions.
 * @param scores - the sources that earned a place, from the Host; null or empty
 *   is the plain name order.
 * @param uncategorized - the label a folderless source groups under.
 * @returns one order, shared by every surface that lists sources.
 */
export function sourceOrder(
  feeds: readonly Feed[],
  scores: ReadonlyMap<string, number> | null,
  uncategorized: string,
): SourceOrder {
  const ranked: Feed[] = []
  const rest: Feed[] = []
  for (const feed of feeds) {
    if (scores !== null && scores.has(feed.id)) ranked.push(feed)
    else rest.push(feed)
  }
  ranked.sort(function (a, b) {
    const sa = scores === null ? 0 : scores.get(a.id) || 0
    const sb = scores === null ? 0 : scores.get(b.id) || 0
    return sb - sa || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
  })
  rest.sort(function (a, b) { return a.title.localeCompare(b.title) || a.id.localeCompare(b.id) })
  const rank = new Map<string, number>()
  const folders = new Map<string, number>()
  let index = 0
  for (const feed of ranked.concat(rest)) {
    rank.set(feed.id, index)
    const name = feed.folder || uncategorized
    const held = folders.get(name)
    // The first source of a folder to appear is its best-ranked one.
    if (held === undefined) folders.set(name, index)
    index += 1
  }
  return { rank: rank, folders: folders, next: index }
}

/** One folder's row in the rail. */
export interface RailGroup {
  name: string
  feeds: Feed[]
}

/**
 * The rail's folders and sources, in the reader's order.
 * @param feeds - the subscriptions.
 * @param order - the order the rail shares with the list.
 * @param uncategorized - the label a folderless source groups under.
 * @returns the groups, each with its sources in order.
 */
export function railGroups(
  feeds: readonly Feed[],
  order: SourceOrder,
  uncategorized: string,
): RailGroup[] {
  const byName = new Map<string, Feed[]>()
  for (const feed of feeds) {
    const name = feed.folder || uncategorized
    const bucket = byName.get(name)
    if (bucket) bucket.push(feed)
    else byName.set(name, [feed])
  }
  const groups: RailGroup[] = Array.from(byName.entries()).map(function (entry) {
    return { name: entry[0], feeds: entry[1] }
  })
  for (const group of groups) {
    group.feeds.sort(function (a, b) {
      const ra = order.rank.get(a.id)
      const rb = order.rank.get(b.id)
      return (ra === undefined ? order.next : ra) - (rb === undefined ? order.next : rb)
        || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
    })
  }
  groups.sort(function (a, b) {
    const ra = order.folders.get(a.name)
    const rb = order.folders.get(b.name)
    return (ra === undefined ? order.next : ra) - (rb === undefined ? order.next : rb)
      || a.name.localeCompare(b.name)
  })
  return groups
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
  /** Ids the Host matched for `query`; null until it answers. */
  searchIds: ReadonlySet<string> | null
  feedId: string | null
  /** Rows an implicit mark keeps on screen until the scope changes. */
  stickyRead: ReadonlySet<string>
  /** Arrivals a refresh is holding back while the reader stays where they are. */
  heldArrivals: ReadonlySet<string>
  /** The localized label for a source that has no folder. */
  uncategorized: string
}

/**
 * The rows the list shows, in the order the archive delivered them.
 *
 * The text filter is answered by the Host, which holds every body whole: the
 * row bodies a surface carries are the list's half, and a query has to match
 * text the list does not have. A query with no answer yet matches nothing.
 * @param view - the reader's current filter, query, and scope.
 * @returns the visible rows.
 */
export function listOf(view: ReaderView): Item[] {
  const query = view.query.trim()
  return view.items.filter(function (item) {
    // A row that arrived under the reader is listed once they leave the spot
    // it would have moved. Hiding it keeps the rows they are reading still;
    // the count still says it is there, because it counts the archive.
    if (view.heldArrivals.has(item.id)) return false
    if (view.filter === 'unread' && view.read.has(item.id) && !view.stickyRead.has(item.id)) return false
    if (view.filter === 'starred' && !view.starred.has(item.id)) return false
    if (view.feedId && item.feed !== view.feedId) return false
    if (query && !(view.searchIds && view.searchIds.has(item.id))) return false
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
 * @param rankOf - a section's place in the reader's source order; omitted, the
 *   sections keep the name order.
 * @returns the flattened entries the viewport windows over.
 */
export function entriesOf(
  list: readonly Item[],
  groupBy: string,
  rowHeight: number,
  groupHeight: number,
  titleOf: (feedId: string) => string,
  folderOf: (feedId: string) => string,
  rankOf?: (key: string) => number,
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
  // Sections hold one order: the reader's order over sources, the same one the
  // rail lists folders and feeds in. It is settled when the surface loads, so a
  // fetch or a mark cannot move the section being read. (Ranking by size did:
  // every fetch re-ranked the list under the pointer.)
  const rank = rankOf || function () { return 0 }
  const ordered = Array.from(groups.values()).sort(function (a, b) {
    return rank(a.key) - rank(b.key) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key)
  })
  const out: Entry[] = []
  for (const group of ordered) {
    out.push({ kind: 'group', key: `group:${group.key}`, group: group, h: groupHeight })
    for (const item of group.items) out.push({ kind: 'row', key: item.id, item: item, h: rowHeight })
  }
  return out
}

/**
 * Sections whose every listed row is already read. Only the unread filter can
 * hold those, and only because an implicit mark kept them listed: they are on
 * their way out, not content.
 * @param entries - the flattened list entries.
 * @param read - the read set.
 * @param filter - the list filter in effect.
 * @returns the section keys that are finished.
 */
export function exhaustedGroups(
  entries: readonly Entry[],
  read: ReadonlySet<string>,
  filter: Filter,
  hold?: string | null,
): string[] {
  if (filter !== 'unread') return []
  const out: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'group') continue
    if (hold && entry.group.key === hold) continue
    if (entry.group.items.every(function (item) { return read.has(item.id) })) out.push(entry.group.key)
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
