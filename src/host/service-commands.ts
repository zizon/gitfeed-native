// The reader's Host state machine: committed items plus the local refresh
// cache, read/star state, subscriptions, git actions, and the job runner.

import path from 'node:path'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { assignFeedIds, indexFeeds, normalizeUrl, readFeeds, resolveFeed, sourceUrl, writeFeeds } from './feeds.js'
import { exportOpml as writeOpml, mergeOpml } from './opml.js'
import type { ImportSummary } from './opml.js'
import { readGitInfo } from './git.js'
import { CUSTOM_FEED_TEMPLATE, declarationOf, runCustom, scaffoldPath, scriptFile } from './custom.js'
import { recordAttention } from './interest.js'
import { appendNdjson, readNdjson, updateNdjson } from './store.js'
import type { FetchResult, GitActionResult } from './types.js'
import type { FeedDefinition } from './types.js'
import type { InterestEvent } from '../shared/interest.js'
import { InputError, messageOf } from '../shared/errors.js'


import { AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS, checkedIds } from './service-core.js'
import type { ServiceRecord } from './service-core.js'
import { fileVersion, invalidate, refresh, serialize, settings, snapshotNow, touch } from './service-snapshot.js'


async function setState(rec: ServiceRecord, file: string, ids: unknown, value: boolean): Promise<number> {
  return serialize(rec, async function () {
    const clean = checkedIds(ids)
    if (clean.length === 0) return 0
    if (value) {
      // Additive, and the append is ordered behind any rewrite of this file:
      // a row already there is not written twice.
      const have = new Set((await readNdjson<{ id: string }>(file)).map(function (r) { return r.id }))
      const add: Array<{ id: string }> = []
      for (const id of clean) {
        if (have.has(id)) continue
        have.add(id)
        add.push({ id: id })
      }
      await appendNdjson(file, add)
      return add.length
    }
    // Removing filters the rows it reads, so the whole step holds the file's
    // write queue: a fetch appending between the read and the write would
    // lose that row.
    const drop = new Set(clean)
    let changed = 0
    await updateNdjson<{ id: string }>(file, function (rows) {
      const kept = rows.filter(function (r) { return !drop.has(r.id) })
      changed = rows.length - kept.length
      return changed === 0 ? null : kept
    })
    return changed
  })
}

export async function mark(rec: ServiceRecord, ids: unknown, read: boolean): Promise<{ ok: boolean; changed: number; version: string }> {
  touch(rec)
  const clean = checkedIds(ids)
  const changed = await setState(rec, rec.paths.read, clean, read)
  // The git facts are left alone on purpose: a mark dirties the worktree, but
  // the sync job that the nudge below arms commits it and re-reads them, and
  // re-running `git status` on every scroll mark is a worse trade.
  // The mark is what this surface just did, so it does not need the row text:
  // one frame carries the ids to every other surface, and the revision keeps
  // a reconnecting one from seeing it twice.
  rec.live.mark(clean, read)
  if (changed > 0) rec.syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
  return { ok: true, changed: changed, version: await fileVersion(rec) }
}

export async function star(rec: ServiceRecord, ids: unknown, starred: boolean): Promise<{ ok: boolean; changed: number; version: string }> {
  touch(rec)
  const clean = checkedIds(ids)
  const changed = await setState(rec, rec.paths.starred, clean, starred)
  rec.live.star(clean, starred)
  if (changed > 0) rec.syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
  return { ok: true, changed: changed, version: await fileVersion(rec) }
}

export async function attention(
  rec: ServiceRecord, kind: unknown, item: unknown, feed: unknown,
): Promise<{ ok: boolean; recorded: boolean }> {
  touch(rec)
  if (kind !== 'open' && kind !== 'star') throw new InputError('attention: kind must be open or star')
  const id = typeof item === 'string' ? item.trim() : ''
  const source = typeof feed === 'string' ? feed.trim() : ''
  if (!id || id.length >= 64) throw new InputError('attention: item id is required')
  if (!source || source.length >= 200) throw new InputError('attention: feed id is required')
  const event: InterestEvent = { kind: kind, feed: source, item: id, at: new Date().toISOString() }
  const recorded = await recordAttention(rec.paths.interest, event)
  // The log is committed reader state like a mark, so an act arms the same
  // sync; the debounce coalesces a sweep of selection into one commit.
  if (recorded) rec.syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
  return { ok: true, recorded: recorded }
}

export async function ensureLocalMeta(rec: ServiceRecord): Promise<void> {
  await mkdir(rec.paths.localItems, { recursive: true })
  try {
    await stat(rec.paths.localMeta)
  } catch {
    try {
      await copyFile(rec.paths.meta, rec.paths.localMeta)
    } catch {
      // no committed meta yet; the first run just takes longer
    }
  }
}

export async function scaffoldCustomFeed(rec: ServiceRecord, input: { name?: string } | null | undefined) {
  touch(rec)
  const target = scaffoldPath(rec.root, input?.name || '')
  await mkdir(path.dirname(target.file), { recursive: true })
  try {
    await writeFile(target.file, CUSTOM_FEED_TEMPLATE, { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new InputError(`custom feed: ${target.script} already exists; pick another name`)
    }
    throw err
  }
  return {
    script: target.script,
    file: target.file,
    next: 'fill in the items loop, then check it with gitfeed_custom_feed check',
  }
}

export async function checkCustomFeed(rec: ServiceRecord, input: { script?: string; url?: string; options?: unknown } | null | undefined) {
  if (!input?.script) throw new InputError('script is required')
  const declaration = declarationOf({ type: 'custom', script: input.script, options: input.options })
  if (declaration === null) throw new InputError('script is required')
  const file = await scriptFile(rec.root, declaration.script)
  const url = sourceUrl(input.url || 'https://example.com/')
  const controller = new AbortController()
  // The same deadline the fetcher would give it, armed on the Host timer.
  const cancel = rec.timers.timeout(function () { controller.abort() }, settings(rec).fetch.timeoutMs)
  try {
    const feed = await runCustom(file, {
      id: 'check',
      url: url,
      title: null,
      options: declaration.options,
      meta: { etag: null, lastModified: null },
      fetch: globalThis.fetch,
      signal: controller.signal,
    })
    return {
      ok: true,
      script: declaration.script,
      url: url,
      title: feed.title,
      siteUrl: feed.siteUrl,
      count: feed.items.length,
      dated: feed.items.filter(function (item) { return item.date !== '' }).length,
      sample: feed.items.slice(0, 5).map(function (item) {
        return {
          title: item.title.slice(0, 90),
          link: item.link,
          date: item.date,
          author: item.author.slice(0, 60),
        }
      }),
    }
  } finally {
    cancel()
  }
}

export async function customFeeds(rec: ServiceRecord) {
  const { data } = await snapshotNow(rec)
  const declared = await readFeeds(rec.root)
  const counts = new Map<string, number>()
  for (const item of data.items) counts.set(item.feed, (counts.get(item.feed) || 0) + 1)
  const rows = []
  for (const feed of declared) {
    if (feed.type !== 'custom') continue
    const shown = data.feeds.find(function (candidate) { return candidate.id === feed.id })
    rows.push({
      id: feed.id,
      title: shown ? shown.title : (feed.title || feed.id),
      folder: feed.folder || null,
      script: feed.script || null,
      items: counts.get(feed.id) || 0,
      error: shown ? shown.error : null,
    })
  }
  return { count: rows.length, feeds: rows }
}

export async function runLocalFetch(rec: ServiceRecord, opts?: { only?: string; feeds?: string[]; all?: boolean }): Promise<FetchResult> {
  touch(rec)
  const run = await rec.refreshJob.runNow(opts || { all: true })
  // The run's own onRun already refreshed; awaiting it here makes the
  // response the signal that the rows are on the wire, not a race with it.
  await refresh(rec, { force: true })
  if (run.value) return run.value as FetchResult
  throw new Error(run.outcome.summary || 'fetch failed')
}

export async function addFeed(rec: ServiceRecord,
  input: {
    url?: string
    folder?: string
    title?: string
    type?: string
    script?: string
    options?: unknown
  } | null | undefined,
): Promise<FeedDefinition> {
  touch(rec)
  const raw = (input?.url || '').trim()
  if (!raw) throw new InputError('a feed or site URL is required')
  // A custom feed is its own recipe: validating the declaration is what
  // discovery would have been, and the URL is taken as given.
  const declared = declarationOf({ type: input?.type, script: input?.script, options: input?.options })
  const resolved = declared === null
    ? await resolveFeed(raw)
    : { url: sourceUrl(raw), title: (input?.title || '').trim() || null, items: 0 }
    // Resolved before the subscription exists: a missing script is a rejected
    // add, not a red row the user has to unsubscribe from.
  if (declared !== null) await scriptFile(rec.root, declared.script)

  // The subscription list is read-modify-write, so the whole step queues
  // behind every other one: two subscribes at once would otherwise both read
  // the same list and the second would drop the first. Discovery is done
  // above, outside the queue, so a slow site does not hold it.
  const entry = await serialize(rec, async function () {
    const feeds = await readFeeds(rec.root)
    if (indexFeeds(feeds).has(normalizeUrl(resolved.url))) {
      throw new InputError(`already subscribed to ${resolved.url}`)
    }

    // The same derivation every other reader of the list uses, so a new entry
    // can never be given an id the fetcher would key its rows under
    // differently.
    const listed = feeds.map(function (feed): { id?: unknown; url?: unknown } {
      return { id: feed.id, url: feed.url }
    })
    const ids = assignFeedIds(listed.concat([{ url: resolved.url }]))
    const id = ids[ids.length - 1]

    const folder = (input?.folder || '').trim() || 'Uncategorized'
    const added: FeedDefinition = { id: id, url: resolved.url, title: resolved.title || id, folder: folder }
    // Stored as written: it stays readable in feeds.json, and the script is
    // the user's, so it is never copied into the package.
    if (declared !== null) {
      added.type = 'custom'
      added.script = declared.script
      if (declared.options !== undefined) added.options = declared.options
    }
    feeds.push(added)
    await writeFeeds(rec.root, feeds)
    return added
  })
  invalidate(rec)
  rec.syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
  // The new row is drawn from the stream, so announce it before the one-off
  // fetch starts: the subscription existing is the news here.
  await refresh(rec, { force: true, git: true })

  // Pull this one feed into the local cache so it appears immediately. A
  // failure here still leaves the subscription in place.
  try {
    await runLocalFetch(rec, { only: entry.id })
  } catch (err) {
    rec.logger.warn(`gitfeed: initial fetch for ${entry.id} failed: ${messageOf(err)}`)
  }
  return entry
}

export async function removeFeed(rec: ServiceRecord, id: string | undefined): Promise<{ ok: boolean; removed: string }> {
  touch(rec)
  const key = id || ''
  if (!key) throw new InputError('feed id is required')
  // One queue for every subscription mutation and every mark, so the list and
  // the archive cannot interleave with another one.
  await serialize(rec, async function () {
    const feeds = await readFeeds(rec.root)
    const next = feeds.filter(function (f) { return f.id !== key })
    if (next.length === feeds.length) throw new InputError('no such feed')
    await writeFeeds(rec.root, next)
  })
  invalidate(rec)
  rec.syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
  await refresh(rec, { force: true, git: true })
  return { ok: true, removed: key }
}

export async function exportOpml(rec: ServiceRecord): Promise<string> {
  touch(rec)
  return writeOpml(await readFeeds(rec.root))
}

export async function importOpml(rec: ServiceRecord, xml: string, replace: boolean): Promise<ImportSummary> {
  touch(rec)
  const document = (xml || '').trim()
  if (!document) throw new InputError('an OPML document is required')
  let addedIds: string[] = []
  const summary = await serialize(rec, async function () {
    const before = await readFeeds(rec.root)
    const beforeKeys = new Set(indexFeeds(before).keys())
    const result = await mergeOpml(rec.root, document, { replace: replace })
    const after = indexFeeds(await readFeeds(rec.root))
    addedIds = Array.from(after.entries())
      .filter(function ([key]) { return !beforeKeys.has(key) })
      .map(function ([, feed]) { return feed.id })
    return result
  })
  invalidate(rec)
  rec.syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
  await refresh(rec, { force: true, git: true })
  // The new subscriptions have nothing archived yet. Fetch just those, off
  // the response: forty feeds take longer than a click should, and each one
  // that answers reaches the reader over the stream as it lands.
  if (addedIds.length) {
    void runLocalFetch(rec, { feeds: addedIds }).catch(function (err: unknown) {
      rec.logger.warn(`gitfeed: initial fetch after import failed: ${messageOf(err)}`)
    })
  }
  return summary
}

export async function setFeedFolder(rec: ServiceRecord, id: string | undefined, folder: string | undefined): Promise<FeedDefinition> {
  touch(rec)
  const key = (id || '').trim()
  if (!key) throw new InputError('feed id is required')
  const name = (folder || '').trim() || 'Uncategorized'
  // Same queue as every other subscription write: the list is
  // read-modify-write, so a move must not land on a list a subscribe is
  // still replacing.
  const moved = await serialize(rec, async function () {
    const feeds = await readFeeds(rec.root)
    const entry = feeds.find(function (f) { return f.id === key })
    if (!entry) throw new InputError('no such feed')
    if ((entry.folder || '') === name) return entry
    entry.folder = name
    await writeFeeds(rec.root, feeds)
    return entry
  })
  invalidate(rec)
  // feeds.json is already a sync target, so the move is pushed whatever
  // pushed the last subscription change.
  rec.syncJob.nudge(AUTO_SYNC_DEBOUNCE_MS, AUTO_SYNC_MAX_WAIT_MS)
  await refresh(rec, { force: true, git: true })
  return moved
}

export async function gitAction(rec: ServiceRecord, name: string): Promise<GitActionResult> {
  touch(rec)
  if (!rec.allowGit) throw new Error('git actions are disabled by the gitfeed plugin config (rec.allowGit)')
  const info = await readGitInfo(rec.root)
  if (!info.repo) {
    const localCopy = `gitfeed: ${rec.root} is a local copy, not a git working tree`
    throw new Error(`${localCopy} — clone your own repository there (or point config.repo at one) to ${name}`)
  }
  if (name === 'sync' && (info.remotes || []).indexOf('origin') === -1) {
    throw new Error(`gitfeed: ${rec.root} has no \`origin\` remote — add one with \`git remote add origin <url>\` and try Sync again`)
  }
  const run = await rec.syncJob.runNow({ action: name })
  invalidate(rec)
  await refresh(rec, { force: true, git: true })
  const value = run.value
  if (value && typeof value === 'object') return value as GitActionResult
  return { ok: false, action: name, error: run.outcome.summary || 'git action failed' }
}
