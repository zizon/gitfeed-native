// The rules that decide what the reader lists, exercised without a browser:
// the derivations are pure, so the filter, search, scope, and mark-scope
// counts can be checked against fixtures instead of by eye.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { finish, ok, repoRoot } from './harness.mjs'

const esbuild = [
  path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
  path.join(process.env.DSH_CHECKOUT || path.join(os.homedir(), 'deepseek-harness'), 'node_modules', '.bin', 'esbuild'),
].find(existsSync)

if (esbuild === undefined) {
  console.log('skip the derivations suite (no esbuild to compile the client module)')
  finish()
} else {
  const out = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-derive-'))
  const bundle = path.join(out, 'derive.mjs')
  try {
    execFileSync(esbuild, [
      path.join(repoRoot, 'src', 'client', 'derive.ts'),
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile=${bundle}`,
      '--log-level=warning',
    ])
    const {
      entriesOf,
      exhaustedGroups,
      feedFolder,
      feedTitle,
      groupKey,
      haystackOf,
      listOf,
      markCountsOf,
    } = await import(pathToFileURL(bundle).href)

    const feeds = new Map([
      ['feed-a', { id: 'feed-a', url: 'https://example.com/a.xml', title: 'Alpha Notes', folder: 'Daily' }],
      ['feed-b', { id: 'feed-b', url: 'https://example.com/b.xml', title: 'Beta Notes', folder: null }],
    ])
    function row(id, feed, title, summary) {
      return { id: id, feed: feed, title: title, link: `https://example.com/${id}`, date: '2026-01-20T12:00:00.000Z', author: 'Author', summary: summary }
    }
    const items = [
      row('a1', 'feed-a', 'First post', 'about <b>tides</b>'),
      row('a2', 'feed-a', 'Second post', 'about <b>weather</b>'),
      row('b1', 'feed-b', 'Third post', 'about <b>tides</b>'),
      row('b2', 'feed-b', 'Fourth post', 'closing note'),
    ]
    const none = new Set()
    const haystack = (item) => `${item.title} ${item.summary} ${item.feed}`.toLowerCase()
    function view(patch) {
      return Object.assign({
        items: items,
        read: none,
        starred: none,
        feeds: feeds,
        filter: 'unread',
        query: '',
        feedId: null,
        stickyRead: none,
        uncategorized: 'Uncategorized',
      }, patch)
    }
    const ids = (rows) => rows.map((item) => item.id).join(',')

    ok(ids(listOf(view({}), haystack)) === 'a1,a2,b1,b2', 'unread with nothing marked shows everything in archive order')
    ok(ids(listOf(view({ read: new Set(['a1', 'b1']) }), haystack)) === 'a2,b2', 'a read row leaves the unread list')
    ok(
      ids(listOf(view({ read: new Set(['a1']), stickyRead: new Set(['a1']) }), haystack)) === 'a1,a2,b1,b2',
      'a row an implicit mark keeps stays put',
    )
    ok(
      ids(listOf(view({ filter: 'starred', starred: new Set(['b2']) }), haystack)) === 'b2',
      'the starred filter shows only starred rows',
    )
    ok(ids(listOf(view({ feedId: 'feed-a' }), haystack)) === 'a1,a2', 'a selected source scopes the list')
    ok(
      ids(listOf(view({ query: '  TIDES  ' }), haystack)) === 'a1,b1',
      'search trims, lowercases, and matches the row text',
    )
    ok(ids(listOf(view({ query: 'nosuchword' }), haystack)).length === 0, 'a query with no match lists nothing')
    ok(
      ids(listOf(view({ query: 'beta', feedId: 'feed-a' }), haystack)) === '',
      'search and scope narrow together',
    )
    ok(
      ids(listOf(view({ filter: 'all', read: new Set(['a1', 'a2', 'b1', 'b2']) }), haystack)) === 'a1,a2,b1,b2',
      'the all filter ignores read state',
    )

    const starTop = markCountsOf(view({ read: new Set(['a1', 'b2']), feedId: 'feed-a' }), listOf(view({ read: new Set(['a1', 'b2']), feedId: 'feed-a' }), haystack))
    ok(
      starTop.results === 1 && starTop.source === 1 && starTop.folder === 1 && starTop.all === 2,
      'each marking scope counts what it would touch',
      starTop,
    )
    ok(starTop.folderName === 'Daily', 'the folder scope names its folder', starTop.folderName)
    const unscoped = markCountsOf(view({}), listOf(view({}), haystack))
    ok(unscoped.folderName === null && unscoped.source === 0, 'an unscoped view offers no source or folder scope', unscoped)
    ok(
      markCountsOf(view({ query: 'tides' }), listOf(view({ query: 'tides' }), haystack)).results === 2,
      'the results scope counts the searched rows only',
    )
    const keptView = view({ read: new Set(['a1']), stickyRead: new Set(['a1']) })
    const keptCounts = markCountsOf(keptView, listOf(keptView, haystack))
    ok(
      keptCounts.results === 3,
      'a read row kept on screen is not counted as something to mark',
      keptCounts,
    )

    ok(feedTitle(feeds, 'feed-a') === 'Alpha Notes', 'a source is shown by its title')
    ok(feedTitle(feeds, 'feed-zzz') === 'feed-zzz', 'an unknown source id stays itself')
    ok(feedFolder(feeds, 'feed-a', 'Uncategorized') === 'Daily', 'a folder is the row grouping')
    ok(
      feedFolder(feeds, 'feed-b', 'Uncategorized') === 'Uncategorized',
      'a source without a folder lands in the fallback label',
    )
    ok(groupKey(items[0], 'feed', feeds, 'Uncategorized') === 'feed-a', 'grouping by source uses the id')
    ok(groupKey(items[2], 'folder', feeds, 'Uncategorized') === 'Uncategorized', 'grouping by folder uses the label')

    // A section is finished when nothing listed in it is still unread.
    const titleOf = (id) => feedTitle(feeds, id)
    const folderOf = (id) => feedFolder(feeds, id, 'Uncategorized')
    const sections = entriesOf(items, 'folder', 10, 10, titleOf, folderOf)
    ok(
      sections.map((entry) => entry.kind).join(',') === 'group,row,row,group,row,row',
      'grouping flattens one header plus its rows per section',
      sections.map((entry) => entry.kind),
    )
    ok(
      exhaustedGroups(sections, new Set(['a1', 'a2']), 'unread').join(',') === 'Daily',
      'a section with nothing unread is finished',
      exhaustedGroups(sections, new Set(['a1', 'a2']), 'unread'),
    )
    ok(
      exhaustedGroups(sections, new Set(['a1']), 'unread').length === 0,
      'a section with one unread row is not finished',
    )
    ok(
      exhaustedGroups(sections, new Set(['a1', 'a2', 'b1', 'b2']), 'all').length === 0,
      'the all filter keeps finished sections',
    )
    ok(
      exhaustedGroups(entriesOf(items, 'none', 10, 10, titleOf, folderOf), new Set(['a1', 'a2']), 'unread').length === 0,
      'an ungrouped list has no section to finish',
    )

    const hay = haystackOf(items[0], 'Alpha Notes')
    ok(hay.includes('first post') && hay.includes('alpha notes'), 'a row search text carries its title and source name', hay)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

finish()
