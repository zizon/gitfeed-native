// Custom feeds: a subscription whose items come from a script in the data
// repository. The boundary is the pseudo feed — a script returns the shape an
// RSS parser produces, and everything after that is the ordinary feed path.
// So each suite here checks one thing: a script's output is archived, dated,
// de-duplicated, and reported exactly as a feed's would be, and a broken
// script fails that feed instead of the run.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { finish, lib, nodeTimers, ok, repoRoot } from './harness.mjs'
import { makeDataRoot, removeRoot } from './fixtures.mjs'

const { runFetch } = await import(lib('host', 'fetch.js'))
const { declarationOf, kindOf } = await import(lib('host', 'custom.js'))
const { parseSkill, registerSkill } = await import(lib('host', 'skill.js'))
const { registerCustomFeedTool, registerTool } = await import(lib('host', 'tool.js'))

const PUBS_HTML = readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'google-research-pubs.html'), 'utf8')
const PUBS_SCRIPT = path.join(repoRoot, 'examples', 'google-research.mjs')

/** Answer each URL with a fixed body, and record what was asked for. */
function stub(pages) {
  const calls = []
  globalThis.fetch = async function (url, init) {
    const key = String(url)
    calls.push({ url: key, headers: (init && init.headers) || {} })
    if (pages[key] === undefined) throw new Error(`unstubbed request: ${key}`)
    const page = pages[key]
    return new Response(page.body, { status: page.status || 200, headers: page.headers || {} })
  }
  return calls
}

/** Every archived row in one items directory, whatever shards it landed in. */
function rowsIn(dir) {
  if (!existsSync(dir)) return []
  const rows = []
  for (const name of readdirSync(dir).sort()) {
    for (const line of readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line))
    }
  }
  return rows
}

/** The committed archive of a data root. */
function rowsOf(root) {
  return rowsIn(path.join(root, 'data', 'items'))
}

function metaOf(root, id) {
  return JSON.parse(readFileSync(path.join(root, 'data', 'meta.json'), 'utf8'))[id] || {}
}

function lastError(root, id) {
  return metaOf(root, id).lastError
}

/** Put a script where a custom feed looks for it. */
function writeScript(root, name, source) {
  const file = path.join(root, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, source)
  return file
}

const PUB_ENTRY = {
  id: 'research-google-pubs',
  url: 'https://research.google/pubs/',
  title: 'Google Research — Publications',
  folder: 'Papers',
  type: 'custom',
  script: 'sources/google-research.mjs',
}

// 1. The worked example: one script, one page, the same items a feed would give.
{
  const root = makeDataRoot({ feeds: [PUB_ENTRY] })
  writeScript(root, 'sources/google-research.mjs', readFileSync(PUBS_SCRIPT, 'utf8'))
  const calls = stub({ 'https://research.google/pubs/': { body: PUBS_HTML, headers: { 'content-type': 'text/html' } } })
  const result = await runFetch({ root: root })
  const rows = rowsOf(root)
  const android = rows.find(function (row) { return row.link.indexOf('when-android-apps-request-location') !== -1 })
  const survey = rows.find(function (row) { return row.link.indexOf('a-3d-scene-graphs-survey') !== -1 })
  ok(result.fresh === 2, 'a custom feed archives what its script returned', result.summary)
  ok(calls.length === 1 && calls[0].url === 'https://research.google/pubs/', 'the script is the only one making requests', calls.map(function (call) { return call.url }))
  ok(!!android && android.title.indexOf('When Android Apps Request Location') === 0, 'the script decides the title', android && android.title)
  ok(!!android && android.link === 'https://research.google/pubs/when-android-apps-request-location-with-a-reason-a-developer-study-and-user-behavior-experiment/', 'and the link', android && android.link)
  ok(!!android && android.author === 'Alex Berke', 'and the author', android && android.author)
  ok(!!survey && survey.title.indexOf('A 3D Scene Graphs Survey') === 0, 'every item the script returned is archived', survey && survey.title)
  ok(rows.every(function (row) { return row.feed === 'research-google-pubs' }), 'the rows belong to the subscription', rows.map(function (row) { return row.feed }))
  ok(metaOf(root, 'research-google-pubs').title === 'Google Research — Publications', 'the pseudo feed titles the subscription', metaOf(root, 'research-google-pubs').title)
  ok(metaOf(root, 'research-google-pubs').siteUrl === 'https://research.google/pubs/', 'and carries its site', metaOf(root, 'research-google-pubs').siteUrl)
  // No dates on the page: page order becomes age, so the first card is newest.
  const newest = rows.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1 })[0]
  ok(!!newest && newest.link.indexOf('when-android-apps-request-location') !== -1, 'page order survives as newest-first', newest && newest.link)
  const again = await runFetch({ root: root })
  ok(again.fresh === 0, 'a second run adds nothing', again.summary)
  ok(rowsOf(root).length === 2, 'the archive keeps one row per link', rowsOf(root).length)
  removeRoot(root)
}

// 2. A script that found nothing says so by returning no items: a quiet run,
// not a failed one.
{
  const root = makeDataRoot({
    feeds: [{ id: 'quiet', url: 'https://example.com/quiet', title: 'Quiet', type: 'custom', script: 'sources/quiet.mjs' }],
  })
  writeScript(root, 'sources/quiet.mjs', 'export default async function () { return { items: [] } }\n')
  const result = await runFetch({ root: root })
  ok(result.failed === 0, 'an empty pseudo feed is not a failure', result.summary)
  ok(result.fresh === 0 && rowsOf(root).length === 0, 'and writes nothing', result.summary)
  ok(result.perFeed.quiet.added === 0, 'the feed reports zero additions', result.perFeed.quiet)
  removeRoot(root)
}

// 3. A script that throws fails its own feed, and only its own.
{
  const root = makeDataRoot({
    feeds: [
      { id: 'broken', url: 'https://example.com/broken', title: 'Broken', type: 'custom', script: 'sources/broken.mjs' },
      { id: 'healthy', url: 'https://example.com/feed.xml', title: 'Healthy' },
    ],
  })
  writeScript(root, 'sources/broken.mjs', "export default async function () { throw new Error('page moved') }\n")
  stub({
    'https://example.com/feed.xml': {
      body: '<rss version="2.0"><channel><title>Healthy</title><item><title>ok</title><guid>1</guid></item></channel></rss>',
    },
  })
  const result = await runFetch({ root: root })
  ok(result.failed === 1, 'only the custom feed fails', result.summary)
  ok(result.fresh === 1, 'the RSS feed beside it still lands its row', result.summary)
  ok(result.perFeed.broken.failed === true, 'the failure is reported per feed', result.perFeed.broken)
  ok(/page moved/.test(lastError(root, 'broken') || ''), "the script's own message reaches the row", lastError(root, 'broken'))
  removeRoot(root)
}

// 4. A declaration is validated before anything runs: the kind, the file, and
// its place inside the data root.
{
  const bad = [
    ['an unknown kind', function () { kindOf({ type: 'sql' }) }, /feed\.type/],
    ['no script', function () { declarationOf({ type: 'custom' }) }, /feed\.script/],
    ['not an .mjs', function () { declarationOf({ type: 'custom', script: 'sources/x.js' }) }, /\.mjs/],
    ['an absolute path', function () { declarationOf({ type: 'custom', script: '/tmp/x.mjs' }) }, /relative/],
    ['a script without the type', function () { declarationOf({ script: 'sources/x.mjs' }) }, /only a custom feed/],
  ]
  for (const [label, run, expected] of bad) {
    let thrown = null
    try {
      run()
    } catch (err) {
      thrown = err
    }
    ok(thrown !== null && expected.test(thrown.message), `a bad declaration is refused: ${label}`, thrown && thrown.message)
  }
  ok(kindOf({}) === 'rss' && kindOf({ type: 'custom' }) === 'custom', 'the kind is read without running anything')
  const declared = declarationOf({ type: 'custom', script: 'sources/x.mjs', options: { tag: 'ml' } })
  ok(declared.script === 'sources/x.mjs' && declared.options.tag === 'ml', 'the declaration carries the script and its options', declared)

  // A script that is a symlink out of the data root is not run: the root is
  // cloned from remotes, and the code has to belong to it.
  const root = makeDataRoot({
    feeds: [{ id: 'escape', url: 'https://example.com/escape', title: 'Escape', type: 'custom', script: 'sources/escape.mjs' }],
  })
  const outside = `${root}-outside.mjs`
  writeFileSync(outside, 'export default async function () { return { items: [] } }\n')
  mkdirSync(path.join(root, 'sources'), { recursive: true })
  symlinkSync(outside, path.join(root, 'sources', 'escape.mjs'))
  stub({})
  const result = await runFetch({ root: root })
  ok(result.failed === 1, 'a script that leaves the data root is not run', result.summary)
  ok(/outside/.test(lastError(root, 'escape') || ''), 'and says where it landed', lastError(root, 'escape'))
  rmSync(outside, { force: true })
  removeRoot(root)

  const missing = makeDataRoot({
    feeds: [{ id: 'missing', url: 'https://example.com/missing', title: 'Missing', type: 'custom', script: 'sources/nope.mjs' }],
  })
  stub({})
  const absent = await runFetch({ root: missing })
  ok(absent.failed === 1, 'a script that is not there fails the feed', absent.summary)
  ok(/no script at/.test(lastError(missing, 'missing') || ''), 'with the path it looked at', lastError(missing, 'missing'))
  removeRoot(missing)
}

// 5. A script's return value is checked: it must be a pseudo feed, and each
// item must be an object.
{
  const root = makeDataRoot({
    feeds: [
      { id: 'array', url: 'https://example.com/a', title: 'Array', type: 'custom', script: 'sources/array.mjs' },
      { id: 'noitems', url: 'https://example.com/b', title: 'No items', type: 'custom', script: 'sources/noitems.mjs' },
      { id: 'baditem', url: 'https://example.com/c', title: 'Bad item', type: 'custom', script: 'sources/baditem.mjs' },
    ],
  })
  writeScript(root, 'sources/array.mjs', 'export default async function () { return [] }\n')
  writeScript(root, 'sources/noitems.mjs', "export default async function () { return { title: 'x' } }\n")
  writeScript(root, 'sources/baditem.mjs', 'export default async function () { return { items: [null] } }\n')
  stub({})
  const result = await runFetch({ root: root })
  ok(result.failed === 3, 'every malformed return fails its own feed', result.summary)
  ok(/instead of an object/.test(lastError(root, 'array') || ''), 'an array is not a pseudo feed', lastError(root, 'array'))
  ok(/no "items" array/.test(lastError(root, 'noitems') || ''), 'a feed needs items', lastError(root, 'noitems'))
  ok(/item 0 is not an object/.test(lastError(root, 'baditem') || ''), 'an item needs to be an object', lastError(root, 'baditem'))
  removeRoot(root)
}

// 6. The validators round-trip: what the script reports is stored, and handed
// back on the next run, so a script can be conditional. Omitting them keeps
// what is stored rather than silently dropping it.
{
  const root = makeDataRoot({
    feeds: [{ id: 'etagged', url: 'https://example.com/etagged', title: 'Etagged', type: 'custom', script: 'sources/etagged.mjs' }],
  })
  writeScript(root, 'sources/etagged.mjs', `
export default async function (input) {
  const tag = input.meta.etag || 'none'
  return {
    etag: input.meta.etag ? undefined : 'v1',
    items: [{ title: 'tag=' + tag, link: 'https://example.com/tag/' + tag, date: '2026-10-01T00:00:00.000Z' }],
  }
}
`)
  stub({})
  const first = await runFetch({ root: root })
  ok(first.fresh === 1, 'the first run archives a row', first.summary)
  ok(metaOf(root, 'etagged').etag === 'v1', 'the validators a script reports are stored', metaOf(root, 'etagged').etag)
  const second = await runFetch({ root: root })
  ok(second.fresh === 1, 'the second run sees the stored validator', second.summary)
  const rows = rowsOf(root)
  ok(rows.some(function (row) { return row.title === 'tag=v1' }), 'the script was handed the stored etag', rows.map(function (row) { return row.title }))
  ok(metaOf(root, 'etagged').etag === 'v1', 'omitting them keeps them', metaOf(root, 'etagged').etag)
  removeRoot(root)
}

// 7. The script is handed the entry's options and the fetcher's deadline.
{
  const root = makeDataRoot({
    feeds: [{
      id: 'options', url: 'https://example.com/options', title: 'Options',
      type: 'custom', script: 'sources/options.mjs', options: { tag: 'ml' },
    }],
  })
  writeScript(root, 'sources/options.mjs', `
export default async function (input) {
  const deadline = input.signal instanceof AbortSignal && input.signal.aborted === false
  return { items: [{ title: 'tag=' + input.options.tag + ' deadline=' + deadline, link: 'https://example.com/opt' }] }
}
`)
  stub({})
  await runFetch({ root: root })
  const rows = rowsOf(root)
  ok(rows.length === 1 && rows[0].title === 'tag=ml deadline=true', 'options and the deadline arrive', rows.map(function (row) { return row.title }))
  removeRoot(root)
}

// 8. Subscribing through the reader's own path: a declaration is validated
// against the data root, stored as written, and read at once.
{
  const root = makeDataRoot({ feeds: [] })
  const { createGitfeed } = await import(lib('host', 'service.js'))
  const service = createGitfeed({ root: root, timers: nodeTimers(), allowGit: false, refreshMinutes: 0 })
  writeScript(root, 'sources/one.mjs', "export default async function () { return { title: 'One', items: [{ title: 'first', link: 'https://example.com/1' }] } }\n")
  const entry = await service.addFeed({
    url: 'https://example.com/one',
    title: 'One',
    folder: 'Custom',
    type: 'custom',
    script: 'sources/one.mjs',
    options: { tag: 'x' },
  })
  const stored = JSON.parse(readFileSync(path.join(root, 'feeds.json'), 'utf8')).feeds
  ok(entry.id === 'example-com-one', 'the id comes from the URL', entry.id)
  ok(stored.length === 1 && stored[0].type === 'custom', 'the entry is declared custom', stored)
  ok(stored[0].script === 'sources/one.mjs' && stored[0].options.tag === 'x', 'the script and its options are stored as written', stored[0])
  ok(rowsIn(path.join(root, '.local', 'items')).length === 1, 'and read into the cache at once', rowsIn(path.join(root, '.local', 'items')).length)

  let refused = null
  try {
    await service.addFeed({ url: 'https://example.com/two', type: 'custom', script: 'sources/nope.mjs' })
  } catch (err) {
    refused = err
  }
  ok(!!refused && /no script at/.test(refused.message), 'a missing script is refused before the subscription exists', refused && refused.message)
  ok(JSON.parse(readFileSync(path.join(root, 'feeds.json'), 'utf8')).feeds.length === 1, 'and nothing is written for it')

  // An unreadable declaration must not take the reader down with it: the row
  // still renders, and the fetch is what reports the complaint.
  const doc = JSON.parse(readFileSync(path.join(root, 'feeds.json'), 'utf8'))
  doc.feeds.push({ id: 'typo', url: 'https://example.com/typo', title: 'Typo', type: 'bogus' })
  writeFileSync(path.join(root, 'feeds.json'), JSON.stringify(doc, null, 2) + '\n')
  const state = await service.getState()
  const typo = (state.feeds || []).find(function (row) { return row.id === 'typo' })
  ok(!!typo && typo.kind === 'rss', 'an unreadable declaration still renders its row', typo)
  service.dispose()
  removeRoot(root)
}

// 9. An OPML import describes feeds; a custom feed it does not mention has to
// survive the rewrite of feeds.json that every import performs.
{
  const root = makeDataRoot({
    feeds: [
      { id: 'research-google-pubs', url: 'https://research.google/pubs/', title: 'Google Research', folder: 'Papers', type: 'custom', script: 'sources/google-research.mjs' },
      { id: 'example', url: 'https://example.com/feed.xml', title: 'Example' },
    ],
  })
  const file = path.join(root, 'import.opml')
  writeFileSync(file, `<?xml version="1.0"?>
<opml version="2.0"><body>
  <outline text="Daily"><outline type="rss" text="Example" xmlUrl="https://example.com/feed.xml"/></outline>
</body></opml>
`)
  const { importOpml } = await import(lib('host', 'opml.js'))
  await importOpml(root, file)
  const stored = JSON.parse(readFileSync(path.join(root, 'feeds.json'), 'utf8')).feeds
  const kept = stored.find(function (row) { return row.id === 'research-google-pubs' })
  const renamed = stored.find(function (row) { return row.id === 'example' })
  ok(!!kept && kept.type === 'custom' && kept.script === 'sources/google-research.mjs', 'an import keeps a custom feed it does not describe', kept)
  ok(!!renamed && renamed.folder === 'Daily', 'and still applies the export folder', renamed)
  removeRoot(root)
}

// 10. Scaffolding and checking: the loop an author actually iterates in.
{
  const root = makeDataRoot({ feeds: [] })
  const { createGitfeed } = await import(lib('host', 'service.js'))
  const service = createGitfeed({ root: root, timers: nodeTimers(), allowGit: false, refreshMinutes: 0 })

  const made = await service.scaffoldCustomFeed({ name: 'draft' })
  ok(made.script === 'sources/draft.mjs', 'scaffold writes the script feeds.json names', made.script)
  const written = readFileSync(path.join(root, made.script), 'utf8')
  ok(written.includes('export default async function'), 'the skeleton is a script, not a stub', written.slice(0, 40))
  ok(written.includes('input.signal'), 'and it documents the interface it is handed')

  let twice = null
  try {
    await service.scaffoldCustomFeed({ name: 'draft' })
  } catch (err) {
    twice = err
  }
  ok(!!twice && /already exists/.test(twice.message), 'scaffold refuses to overwrite', twice && twice.message)

  let bad = null
  try {
    await service.scaffoldCustomFeed({ name: '../escape' })
  } catch (err) {
    bad = err
  }
  ok(!!bad && /lower-case/.test(bad.message), 'scaffold refuses a name that is not a file name', bad && bad.message)

  // The skeleton parses and runs; it fails on its own assertion, which is the
  // lesson it carries. A script that returns items then checks clean.
  stub({ 'https://example.com/x': { body: '<html><body>nothing here</body></html>' } })
  let unparsed = null
  try {
    await service.checkCustomFeed({ script: made.script, url: 'https://example.com/x' })
  } catch (err) {
    unparsed = err
  }
  ok(!!unparsed && /no items matched/.test(unparsed.message), 'the skeleton runs and carries its own assertion', unparsed && unparsed.message)

  writeFileSync(path.join(root, made.script), `
export default async function (input) {
  return { title: 'Checked', items: [{ title: 'One', link: input.url + '/1', date: '2026-11-01T00:00:00.000Z' }, { title: 'Two' }] }
}
`)
  const checked = await service.checkCustomFeed({ script: made.script, url: 'https://example.com/x' })
  ok(checked.count === 2, 'check reports what the script returned', checked.count)
  ok(checked.dated === 1, 'and how many items carried a date', checked.dated)
  ok(checked.title === 'Checked' && checked.sample.length === 2, 'with the pseudo feed title and a sample', checked.title)
  ok(rowsOf(root).length === 0, 'check writes nothing to the archive')

  const listed = await service.customFeeds()
  ok(listed.count === 0, 'no custom feed is declared yet', listed)
  service.dispose()
  removeRoot(root)
}

// 11. The authoring tool drives those same methods, and the skill that points
// at it parses and advertises itself.
{
  const root = makeDataRoot({ feeds: [] })
  const { createGitfeed } = await import(lib('host', 'service.js'))
  const service = createGitfeed({ root: root, timers: nodeTimers(), allowGit: false, refreshMinutes: 0 })
  const definitions = []
  const ctx = { tools: { register(definition) { definitions.push(definition); return function () {} } } }
  registerTool(ctx, service)
  registerCustomFeedTool(ctx, service)
  const byName = new Map(definitions.map(function (definition) { return [definition.name, definition] }))
  ok(byName.has('gitfeed') && byName.has('gitfeed_custom_feed'), 'both tools register', [...byName.keys()])
  const custom = byName.get('gitfeed_custom_feed')
  ok(/custom feed/i.test(custom.description) && custom.description.includes('custom-feeds skill'), 'the authoring tool names the skill', custom.description.slice(0, 60))

  const scaffolded = await custom.execute({ action: 'scaffold', name: 'tool-draft' })
  ok(scaffolded.script === 'sources/tool-draft.mjs', 'the tool scaffolds through the same path', scaffolded)
  writeFileSync(path.join(root, scaffolded.script), 'export default async () => ({ items: [{ title: "One", link: "https://example.com/tool/1" }] })\n')
  const checked = await custom.execute({ action: 'check', script: scaffolded.script, url: 'https://example.com/tool' })
  ok(checked.count === 1, 'and checks it', checked.count)
  stub({})
  const subscribed = await custom.execute({ action: 'subscribe', script: scaffolded.script, url: 'https://example.com/tool', title: 'Tool feed', folder: 'Papers' })
  ok(subscribed.ok && subscribed.feed.type === 'custom', 'and subscribes it as a custom feed', subscribed.feed)
  const listed = await custom.execute({ action: 'list' })
  ok(listed.count === 1 && listed.feeds[0].script === scaffolded.script, 'the list action reports the declaration', listed)
  ok(listed.feeds[0].items === 1, 'with the items it archived', listed.feeds[0].items)
  service.dispose()
  removeRoot(root)

  const skill = parseSkill(readFileSync(path.join(repoRoot, 'src', 'skill', 'custom-feeds.md'), 'utf8'))
  ok(skill.name === 'custom-feeds' && skill.description.length > 40, 'the skill parses with a routable description', skill.name)
  ok(!!skill.whenToUse && skill.whenToUse.length > 10, 'and carries when-to-use guidance', skill.whenToUse)
  ok(skill.content.includes('gitfeed_custom_feed') && skill.content.includes('input.signal'), 'the body documents the tool and the interface')
  const registered = []
  registerSkill({ skills: { register(value) { registered.push(value); return function () {} } } })
  ok(registered.length === 1 && registered[0].name === 'custom-feeds', 'the plugin registers the skill', registered.length)
}

finish()
