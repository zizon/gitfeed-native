/**
 * The reader's data half: every request the Client makes to its own Host, plus
 * the poll, flush, and fade timers that drive them. It owns no published state —
 * it reads and writes the controller's two halves through {@link TransportPorts}.
 */

import type { Item } from '../shared/types.js'
import { PREFIX } from './constants.js'
import { messageOf } from '../shared/errors.js'
import { armFresh, dataOf, request, uiOf } from './transport-core.js'
import type { ApiResponse, Transport, TransportPorts, TransportRecord } from './transport-core.js'
import { closeStream, openStream, reconnect } from './transport-stream.js'

export type { Transport, TransportPorts } from './transport-core.js'

/**
 * Open the transport over one published state.
 * @param ports - reads, writes, and the two copy helpers the transport borrows.
 * @returns the request and timer surface the controller drives.
 */
export function createTransport(ports: TransportPorts): Transport {
  const record: TransportRecord = {
    ports: ports,
    t: ports.t,
    pendingRead: new Set<string>(),
    pendingUnread: new Set<string>(),
    stickyRead: new Set<string>(),
    heldArrivals: new Set<string>(),
    firstFrame: true,
    flushTimer: null,
    freshTimer: null,
    markWaiters: [],
    visibilityHandler: null,
    mounted: 0,
    disposed: false,
    lastRev: 0,
    stream: null,
    streaming: false,
    streamAttempts: 0,
    streamRetry: null,
  }
  return {
    reconnect: function () { reconnect(record) },
    search: function (query, signal) { return search(record, query, signal) },
    body: function (id, signal) { return body(record, id, signal) },
    mark: function (ids, value, shown) { return mark(record, ids, value, shown) },
    star: function (id, on) { return star(record, id, on) },
    attention: function (kind, item, feed) { attention(record, kind, item, feed) },
    addFeed: function (url, folder) { return addFeed(record, url, folder) },
    importOpml: function (opml, replace) { return importOpml(record, opml, replace) },
    exportOpml: function () { return exportOpml(record) },
    removeFeed: function (id) { return removeFeed(record, id) },
    setFeedFolder: function (id, folder) { return setFeedFolder(record, id, folder) },
    runAction: function (name) { return runAction(record, name) },
    mount: function () { mount(record) },
    unmount: function () { unmount(record) },
    dispose: function () { dispose(record) },
    clearSticky: function () { if (record.stickyRead.size) record.stickyRead.clear() },
    releaseHeld: function () { return releaseRows(record) },
    release: function (ids: readonly string[]): boolean {
      let changed = false
      for (const id of ids) if (record.stickyRead.delete(id)) changed = true
      return changed
    },
    get sticky() { return record.stickyRead },
    get held() { return record.heldArrivals },
  }
}


/** Stop calling a row new once the fade that introduced it is done. */


/**
   * Ask the Host which rows match a query. The body text is the Host's to
   * search: it holds it whole, and the reader holds the list's half of it.
   * @param query - what the reader typed.
   * @returns the matching ids, in archive order.
   */
function body(rec: TransportRecord, id: string, signal?: AbortSignal): Promise<Item | null> {
  return request('/item', { id: id }, signal).then(function (payload) {
    return payload.item ? payload.item : null
  })
}

function search(rec: TransportRecord, query: string, signal?: AbortSignal): Promise<string[]> {
  if (!query.trim()) return Promise.resolve([])
  return request('/search', { query: query }, signal).then(function (payload) {
    return Array.isArray(payload.ids) ? payload.ids : []
  })
}










/**
   * Reload after an act the reader asked for. Rows a refresh was holding land
   * with it: the reader moved the list, so the rows may move now too.
   */
function showAll(rec: TransportRecord): Promise<void> {
  if (releaseRows(rec)) rec.ports.setUi({ listEpoch: uiOf(rec).listEpoch + 1 })
  // The Host announces what the action changed; there is nothing to ask for.
  return Promise.resolve()
}

/**
   * Let the rows a refresh was holding land. They fade in where they belong,
   * the way a row that arrived where the reader was not looking does.
   * @returns whether anything was being held.
   */
function releaseRows(rec: TransportRecord): boolean {
  if (!rec.heldArrivals.size) return false
  const ids = Array.from(rec.heldArrivals)
  rec.heldArrivals.clear()
  const fresh = new Set(dataOf(rec).fresh)
  for (const id of ids) fresh.add(id)
  rec.ports.setData({ fresh: fresh })
  armFresh(rec)
  return true
}

function flushMarks(rec: TransportRecord): void {
  rec.flushTimer = null
  const readIds = Array.from(rec.pendingRead)
  const unreadIds = Array.from(rec.pendingUnread)
  rec.pendingRead.clear()
  rec.pendingUnread.clear()
  // Every mark queued since the last flush settles with it: one write is one
  // answer, and the caller's promise means "the Host has this".
  const waiting = rec.markWaiters
  rec.markWaiters = []
  if (!readIds.length && !unreadIds.length) {
    for (const settle of waiting) settle.resolve()
    return
  }
  const jobs: Array<Promise<ApiResponse>> = []
  if (readIds.length) jobs.push(request('/mark', { ids: readIds, read: true }))
  if (unreadIds.length) jobs.push(request('/mark', { ids: unreadIds, read: false }))
  Promise.all(jobs).then(function () {
    // The Host announces the mark back as a delta; the version its answer
    // carries is not adopted, because it describes the root as it stands —
    // including item shards this reader never loaded. Adopting it made the
    // next request answer "unchanged" and those rows were never delivered.
    for (const settle of waiting) settle.resolve()
  }).catch(function (err: unknown) {
    for (const settle of waiting) settle.reject(err)
    rec.ports.toast(rec.t('toast.readFailed', { error: messageOf(err) }), true)
    reconnect(rec)
  })
}

/**
   * Apply one mark locally and queue it for the Host.
   * @param ids item ids, already validated by the caller.
   * @param value target state.
   * @param shown the rows on screen when an implicit mark keeps them; null when
   * the mark should drop them.
   */
function mark(rec: TransportRecord, ids: string[], value: boolean, shown: ReadonlySet<string> | null): Promise<void> {
  const read = new Set(dataOf(rec).read)
  for (const id of ids) {
    if (value) read.add(id)
    else read.delete(id)
    if (value) {
      rec.pendingRead.add(id)
      rec.pendingUnread.delete(id)
      if (shown) {
        if (shown.has(id)) rec.stickyRead.add(id)
      } else {
        rec.stickyRead.delete(id)
      }
    } else {
      rec.pendingUnread.add(id)
      rec.pendingRead.delete(id)
      rec.stickyRead.delete(id)
    }
  }
  rec.ports.setData({ read: read })
  if (!rec.flushTimer) rec.flushTimer = setTimeout(function () { flushMarks(rec) }, 350)
  return new Promise(function (resolve, reject) {
    rec.markWaiters.push({ resolve: resolve, reject: reject })
  })
}

function star(rec: TransportRecord, id: string, on: boolean): Promise<void> {
  // The load that follows is what settles the version: the answer to the
  // star names the root, not the state this reader is holding.
  return request('/star', { ids: [id], star: on }).then(function () { /* the frame settles it */ })
}

function attention(rec: TransportRecord, kind: 'open' | 'star', item: string, feed: string): void {
  if (!item || !feed) return
  request('/attention', { kind: kind, item: item, feed: feed }).catch(function () {
    // The order is built from what the Host kept; nothing here is the
    // reader's to fix, and a toast over the article would only be noise.
  })
}

async function addFeed(rec: TransportRecord, url: string, folder: string): Promise<boolean> {
  if (uiOf(rec).busy.add) return false
  rec.ports.setBusy('add', true)
  try {
    const payload = await request('/feeds', { url: url, folder: folder })
    rec.ports.toast(rec.t('toast.subscribed', { name: (payload.feed && (payload.feed.title || payload.feed.url)) || url }))
    await showAll(rec)
    return true
  } catch (err) {
    rec.ports.toast(rec.t('toast.failed', { error: messageOf(err) }), true)
    return false
  } finally {
    rec.ports.setBusy('add', false)
  }
}

/**
   * Send one OPML document to the Host and report what it changed.
   *
   * The document is the reader's file, not a URL: the Host parses it, merges or
   * replaces the subscription list, and the next state load draws the result.
   * @param opml the document's text.
   * @param replace whether it becomes the whole list instead of merging.
   * @returns whether the Host applied it.
   */
async function importOpml(rec: TransportRecord, opml: string, replace: boolean): Promise<boolean> {
  if (uiOf(rec).busy.import) return false
  rec.ports.setBusy('import', true)
  try {
    const payload = await request('/import-opml', { opml: opml, replace: replace })
    const summary = payload.summary || {}
    const added = Number(summary.added) || 0
    const updated = Number(summary.updated) || 0
    const kept = Number(summary.kept) || 0
    const total = Number(summary.total) || 0
    rec.ports.toast(replace
      ? rec.t('toast.replaced', { total: total })
      : rec.t('toast.imported', { total: total, added: added, updated: updated, kept: kept }))
    await showAll(rec)
    return true
  } catch (err) {
    rec.ports.toast(rec.t('toast.failed', { error: messageOf(err) }), true)
    return false
  } finally {
    rec.ports.setBusy('import', false)
  }
}

/**
   * Download the subscription list as an OPML file.
   *
   * The Host answers with the document itself, and this surface hands it to
   * the browser's own save. The downloaded name is set here, not read back from
   * the response's disposition, so the file a reader gets is the one this
   * button promised.
   * @returns whether the download started.
   */
async function exportOpml(rec: TransportRecord): Promise<boolean> {
  if (uiOf(rec).busy.export) return false
  rec.ports.setBusy('export', true)
  try {
    const answer = await fetch(`${PREFIX}/export-opml`, { cache: 'no-store', credentials: 'same-origin' })
    if (!answer.ok) throw new Error(`HTTP ${answer.status}`)
    const opml = await answer.text()
    const url = URL.createObjectURL(new Blob([opml], { type: 'text/x-opml' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'gitfeed-subscriptions.opml'
    document.body.append(link)
    link.click()
    link.remove()
    // The click has already asked the browser to save; the blob is free once
    // that dispatch has happened, and never before it.
    setTimeout(function () { URL.revokeObjectURL(url) }, 0)
    rec.ports.toast(rec.t('toast.exported', { n: dataOf(rec).feeds.length }))
    return true
  } catch (err) {
    rec.ports.toast(rec.t('toast.failed', { error: messageOf(err) }), true)
    return false
  } finally {
    rec.ports.setBusy('export', false)
  }
}

async function removeFeed(rec: TransportRecord, id: string): Promise<boolean> {
  if (!id || uiOf(rec).busy.remove) return false
  rec.ports.setBusy('remove', true)
  try {
    await request('/feeds/remove', { id: id })
    if (uiOf(rec).feedId === id) rec.ports.setUi({ feedId: null })
    rec.ports.toast(rec.t('toast.unsubscribed', { name: rec.ports.titleOf(id) }))
    await showAll(rec)
    return true
  } catch (err) {
    rec.ports.toast(rec.t('toast.failed', { error: messageOf(err) }), true)
    return false
  } finally {
    rec.ports.setBusy('remove', false)
  }
}

/**
   * Move one subscription to another folder and reload the list of sources.
   * @param id feed id.
   * @param folder folder to move it to; an empty name means Uncategorized.
   * @returns whether the move was accepted.
   */
async function setFeedFolder(rec: TransportRecord, id: string, folder: string): Promise<boolean> {
  if (!id || uiOf(rec).busy.folder) return false
  rec.ports.setBusy('folder', true)
  try {
    const payload = await request('/feeds/folder', { id: id, folder: folder })
    const name = (payload.feed && payload.feed.folder) || rec.t('feed.uncategorized')
    rec.ports.toast(rec.t('toast.moved', { name: rec.ports.titleOf(id), folder: name }))
    await showAll(rec)
    return true
  } catch (err) {
    rec.ports.toast(rec.t('toast.failed', { error: messageOf(err) }), true)
    return false
  } finally {
    rec.ports.setBusy('folder', false)
  }
}

async function runAction(rec: TransportRecord, name: string): Promise<void> {
  if (uiOf(rec).busy[name]) return
  rec.ports.setBusy(name, true)
  try {
    const payload = await request(`/${name}`, {})
    if (name === 'fetch') {
      rec.ports.toast(rec.t('toast.fetch', { summary: payload.output || 'ok' }))
    } else if (name === 'pull') {
      rec.ports.toast(rec.t('toast.pull'))
    } else if (name === 'sync') {
      rec.ports.toast(rec.t('toast.sync'))
    } else {
      rec.ports.toast(`${name}: ok`)
    }
    await showAll(rec)
  } catch (err) {
    rec.ports.toast(rec.t('toast.failed', { error: messageOf(err) }), true)
  } finally {
    rec.ports.setBusy(name, false)
  }
}

function mount(rec: TransportRecord): void {
  rec.mounted += 1
  if (rec.mounted > 1) return
  openStream(rec)
  // A tab that was away may come back to a rec.stream the browser dropped.
  rec.visibilityHandler = function () {
    if (document.visibilityState !== 'visible') return
    if (rec.streaming) return
    openStream(rec)
  }
  document.addEventListener('visibilitychange', rec.visibilityHandler)
}

function unmount(rec: TransportRecord): void {
  rec.mounted = Math.max(0, rec.mounted - 1)
  if (rec.mounted > 0) return
  closeStream(rec)
  if (rec.visibilityHandler) {
    document.removeEventListener('visibilitychange', rec.visibilityHandler)
    rec.visibilityHandler = null
  }
}

function dispose(rec: TransportRecord): void {
  rec.disposed = true
  // Marks queued a moment ago were already applied optimistically; dropping
  // them here would silently unmark what the reader just read (the next load
  // would bring the old state back).
  if (rec.flushTimer) flushMarks(rec)
  closeStream(rec)
  rec.mounted = 0
  unmount(rec)
  if (rec.flushTimer) clearTimeout(rec.flushTimer)
  if (rec.freshTimer) clearTimeout(rec.freshTimer)
  if (rec.streamRetry) clearTimeout(rec.streamRetry)
  rec.flushTimer = null
  rec.freshTimer = null
  rec.streamRetry = null
}
