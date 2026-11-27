// What an OPML export does to the subscription list: which entries win, what a
// merge keeps, what a replace drops, and why a document with no outlines is
// refused instead of applied.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { finish, lib, ok } from './harness.mjs'

const { mergeOpml, parseOpml } = await import(lib('host', 'opml.js'))
const { readFeeds, writeFeeds } = await import(lib('host', 'feeds.js'))

const base = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-opml-'))
const root = (name) => {
  const dir = path.join(base, name)
  return dir
}

/** An OPML document with `[title, url, folder]` outlines. */
function doc(entries) {
  const outlines = entries
    .map(([title, url, folder]) => (folder
      ? `  <outline text="${folder}">\n    <outline type="rss" text="${title}" xmlUrl="${url}" />\n  </outline>`
      : `  <outline type="rss" text="${title}" xmlUrl="${url}" />`))
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n<body>\n${outlines}\n</body>\n</opml>\n`
}

// ---------- reading the document ----------
const parsed = parseOpml(doc([
  ['Alpha', 'https://alpha.example.com/rss', 'News'],
  ['Beta', 'https://beta.example.com/feed', 'News'],
  ['Gamma', 'https://gamma.example.com/feed', null],
]))
ok(parsed.length === 3, 'every feed outline is read', parsed.length)
ok(parsed[0].title === 'Alpha' && parsed[0].folder === 'News', 'a nested outline takes its folder from the parent', parsed[0])
ok(parsed[2].folder === null, 'a top-level outline has no folder', parsed[2])
ok(parseOpml('<opml version="2.0"><body><outline text="just a folder" /></body></opml>').length === 0, 'a folder alone is not a feed')

// ---------- merge into a list that already has subscriptions ----------
const merged = root('merged')
await writeFeeds(merged, [
  { id: 'keepme', url: 'https://keep.example.com/rss', title: 'Kept', folder: 'Old folder' },
  { id: 'alpha', url: 'https://alpha.example.com/rss', title: 'Alpha (old title)', folder: 'Old folder' },
  {
    id: 'custom', url: 'https://custom.example.com/list', title: 'Custom', folder: 'Papers',
    type: 'custom', script: 'sources/custom.mjs',
  },
])
const merge = await mergeOpml(merged, doc([
  ['Alpha', 'https://alpha.example.com/rss', 'News'],
  ['Beta', 'https://beta.example.com/feed', 'News'],
  ['Custom', 'https://custom.example.com/list', 'Papers'],
]))
ok(merge.added === 1 && merge.updated === 2, 'merge adds what is new and updates what it re-describes', merge)
ok(merge.kept === 1 && merge.total === 4, 'and keeps the subscriptions the export does not mention', merge)
const afterMerge = await readFeeds(merged)
const kept = afterMerge.find((feed) => feed.id === 'keepme')
ok(kept && kept.folder === 'Old folder' && kept.title === 'Kept', 'a kept subscription is not rewritten', kept)
const alpha = afterMerge.find((feed) => feed.url === 'https://alpha.example.com/rss')
ok(alpha && alpha.id === 'alpha' && alpha.folder === 'News', 'an updated entry keeps its id and takes the file folder', alpha)
const custom = afterMerge.find((feed) => feed.id === 'custom')
ok(custom && custom.type === 'custom' && custom.script === 'sources/custom.mjs', 'a custom feed keeps the script an export cannot describe', custom)

// ---------- replace ----------
const replaced = root('replaced')
await writeFeeds(replaced, [
  { id: 'gone', url: 'https://gone.example.com/rss', title: 'Gone', folder: 'News' },
  { id: 'custom', url: 'https://custom.example.com/list', title: 'Custom', folder: 'Papers', type: 'custom', script: 'sources/custom.mjs' },
])
const replace = await mergeOpml(replaced, doc([
  ['Custom', 'https://custom.example.com/list', 'Papers'],
  ['New', 'https://new.example.com/rss', 'Fresh'],
]), { replace: true })
ok(replace.total === 2 && replace.kept === 0, 'replace makes the document the whole list', replace)
ok(replace.added === 1 && replace.updated === 1, 'and still counts what it changed', replace)
const afterReplace = await readFeeds(replaced)
ok(afterReplace.every((feed) => feed.id !== 'gone'), 'a subscription the document does not mention leaves', afterReplace.map((feed) => feed.id))
const replacedCustom = afterReplace.find((feed) => feed.id === 'custom')
ok(replacedCustom && replacedCustom.script === 'sources/custom.mjs', 'and a custom feed re-described keeps its script', replacedCustom)

// ---------- duplicates, invalid URLs, and the refusal ----------
const messy = root('messy')
const mixed = await mergeOpml(messy, doc([
  ['One', 'https://one.example.com/rss', null],
  ['One again', 'https://one.example.com/rss', null],
  ['Broken', 'not a url', null],
]))
ok(mixed.added === 1 && mixed.duplicates === 1 && mixed.invalid === 1, 'duplicates and unusable URLs are counted, not imported', mixed)
ok(mixed.folders.Uncategorized === 1, 'a feed with no folder lands in Uncategorized', mixed.folders)

const guarded = root('guarded')
await writeFeeds(guarded, [{ id: 'stay', url: 'https://stay.example.com/rss', title: 'Stay', folder: 'News' }])
let refused = null
try {
  await mergeOpml(guarded, '<opml version="2.0"><body></body></opml>', { replace: true })
} catch (err) {
  refused = err
}
ok(refused !== null && /no feed outlines/.test(refused.message), 'a document with no feeds is refused, so a replace cannot empty the list', refused && refused.message)
const untouched = await readFeeds(guarded)
ok(untouched.length === 1 && untouched[0].id === 'stay', 'and the list it would have replaced is untouched', untouched.length)

// ---------- the CLI's file path runs the same merge ----------
const file = path.join(base, 'export.opml')
writeFileSync(file, doc([['From file', 'https://file.example.com/rss', 'Imported']]))
const { importOpml } = await import(lib('host', 'opml.js'))
const fromFile = root('from-file')
const imported = await importOpml(fromFile, file)
ok(imported.added === 1 && imported.total === 1, 'the CLI imports the file through the same merge', imported)

rmSync(base, { recursive: true, force: true })
finish()