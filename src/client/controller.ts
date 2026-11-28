/**
 * The reader's command surface: what the reader is looking at, the derivations
 * over it, and the commands a surface calls. The requests themselves live in
 * rec.transport.ts; this file owns the published state both halves read.
 *
 * The state has two halves — the archive and repository facts a load brings in,
 * and what the reader is looking at — published as one snapshot. Every write
 * names the half it moves, so a transport change cannot rewrite the view by
 * accident.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GroupBy, Item } from '../shared/types.js'
import type { Translate } from './locales.js'
import {
  feedFolder,
  feedTitle,
  groupKey,
  listOf,
  markCountsOf,
} from './derive.js'
import type { ReaderView } from './derive.js'
import { LIST_MAX, LIST_MIN, RAIL_MAX, RAIL_MIN } from './constants.js'
import { messageOf } from '../shared/errors.js'
import type { Prefs, PrefsStore } from './prefs.js'
import { createTransport } from './transport.js'
import type { Transport } from './transport.js'
import type {
  ClientState,
  Controller,
  Filter,
  MarkCounts,
  ReaderData,
  ReaderSource,
  ReaderUi,
} from './types.js'
import { clamp, digestText } from './util.js'

/** The archive and repository facts a surface starts from, before any load. */
function initialData(): ReaderData {
  return {
    status: 'idle',
    error: null,
    loadError: null,
    loadedOnce: false,
    items: [],
    byId: new Map(),
    itemsVersion: null,
    fresh: new Set(),
    read: new Set(),
    starred: new Set(),
    feeds: [],
    feedMap: new Map(),
    ranks: new Map(),
    reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
    git: null,
    schedule: [],
    version: null,
    repo: '',
    allowGit: true,
  }
}

/**
 * The viewing state the stored preferences start, validated on the way in: the
 * snapshot crosses a file boundary, so nothing is trusted from its type.
 */
function initialUi(saved: Prefs, groupBy: GroupBy | null, railHidden: boolean): ReaderUi {
  return {
    filter: 'unread',
    query: '',
    searchIds: null,
    feedId: null,
    current: null,
    groupBy: groupBy,
    hideEmpty: saved.hideEmpty,
    markOnScroll: saved.markOnScroll,
    showDigest: saved.showDigest,
    interestOrder: saved.interestOrder,
    folderOpen: saved.folderOpen,
    railW: clamp(saved.railW, RAIL_MIN, RAIL_MAX),
    listW: clamp(saved.listW, LIST_MIN, LIST_MAX),
    railHidden: railHidden,
    listEpoch: 0,
    busy: {},
    toast: null,
  }
}

/** What the controller keeps between calls: the published halves and its caches. */
interface ControllerRecord {
  t: Translate
  prefs: PrefsStore
  data: ReaderData
  ui: ReaderUi
  store: ReturnType<typeof createSnapshotStore<ClientState>>
  /** The published snapshot; the renderer binds it, nothing writes through it. */
  reader: ReaderSource
  digestCache: Map<string, string>
  listCache: { key: string | null; items: Item[] }
  toastTimer: ReturnType<typeof setTimeout> | null
  /** The last explicit scope mark, so a too-wide action can be taken back. */
  lastScopeMark: string[] | null
  /** Which query the Host is answering, and how to cancel it. */
  searchSeq: number
  searchAbort: AbortController | null
  /** Rows whose body is being read, so an article opening twice reads it once. */
  bodyRequests: Set<string>
  /** Whether a surface is showing a list it wants held still. */
  hold: boolean
  attentionSent: Set<string>
  transport: Transport
}

export function createController(t: Translate, prefs: PrefsStore): Controller {
  const saved = prefs.getSnapshot()
  // Persisted JSON crosses a file boundary, so the grouping is re-validated on
  // the way in instead of trusted from the snapshot's type.
  const savedGroupBy: GroupBy | null = saved.groupBy === 'none' || saved.groupBy === 'folder' || saved.groupBy === 'feed'
    ? saved.groupBy
    : null
  // Likewise for a panel that had no preference when the snapshot was written:
  // a stored value that is not a boolean means the reader never hid it.
  const savedRailHidden = (saved.railHidden as boolean | undefined) === true
  const data = initialData()
  const ui = initialUi(saved, savedGroupBy, savedRailHidden)
  const store = createSnapshotStore<ClientState>(Object.assign({}, data, ui))
  const record: ControllerRecord = {
    t: t,
    prefs: prefs,
    data: data,
    ui: ui,
    store: store,
    reader: store,
    digestCache: new Map<string, string>(),
    listCache: { key: null, items: [] },
    toastTimer: null,
    lastScopeMark: null,
    searchSeq: 0,
    searchAbort: null,
    bodyRequests: new Set<string>(),
    hold: false,
    attentionSent: new Set<string>(),
    transport: null as unknown as Transport,
  }
  record.transport = createTransport({
    read: function () { return { data: record.data, ui: record.ui } },
    setData: function (patch) { setData(record, patch) },
    setUi: function (patch) { setUi(record, patch) },
    commit: function (dataPatch, uiPatch) { commit(record, dataPatch, uiPatch) },
    setBusy: function (key, value) { setBusy(record, key, value) },
    toast: function (text, error, undo) { toast(record, text, error, undo) },
    titleOf: function (feedId) { return feedTitleOf(record, feedId) },
    hold: function () { return holdNow(record) },
    refilter: function () { refilter(record) },
    refetchBody: function (id) { refetchBody(record, id) },
    resetText: function () { resetText(record) },
    t: t,
  })
  return apiOf(record)
}

/** Whether a refresh should hold its rows: a list is on screen to protect. */
function holdNow(rec: ControllerRecord): boolean {
  // A list with nothing on screen has no position to protect. The flag can
  // outlive the list that set it — a scroll to the end, then the filter
  // emptying it — and no scroll pass would clear it, because an empty list
  // renders no viewport.
  return rec.hold && getList(rec).length > 0
}

/** The model moved under a query: ask again for the text the reader left in the box. */
function refilter(rec: ControllerRecord): void {
  const needle = rec.ui.query.trim()
  if (!needle) return
  searchFor(rec, needle)
}

/** The article is showing a row that arrived as a digest: read its body again. */
function refetchBody(rec: ControllerRecord, id: string): void {
  rec.bodyRequests.delete(id)
  ensureBody(rec, id)
}

/** A new item model invalidates the body text this surface has read. */
function resetText(rec: ControllerRecord): void {
  rec.bodyRequests.clear()
}

/** The controller surface, built once the record and the transport exist. */
function apiOf(rec: ControllerRecord): Controller {
  return {
    get: function () { return get(rec) },
    subscribe: function (listener) { return subscribe(rec, listener) },
    reader: rec.store,
    getList: function () { return getList(rec) },
    reconnect: function () { rec.transport.reconnect() },
    mark: function (ids, value, shown) { return mark(rec, ids, value, shown) },
    select: function (id) { select(rec, id) },
    closeArticle: function () { closeArticle(rec) },
    selectFeed: function (id) { selectFeed(rec, id) },
    setFilter: function (filter) { setFilter(rec, filter) },
    setQuery: function (query) { setQuery(rec, query) },
    move: function (offset) { move(rec, offset) },
    toggleRead: function () { toggleRead(rec) },
    toggleStar: function (id) { toggleStar(rec, id) },
    openCurrent: function () { openCurrent(rec) },
    escape: function () { escape(rec) },
    markAll: function () { markAll(rec) },
    markCounts: function () { return markCounts(rec) },
    markEverything: function () { markEverything(rec) },
    undoMark: function () { undoMark(rec) },
    dismissToast: function () { dismissToast(rec) },
    markGroup: function (key) { markGroup(rec, key) },
    markFeed: function (feedId) { markFeed(rec, feedId) },
    markFolder: function (folder) { markFolder(rec, folder) },
    setGroupBy: function (value) { setGroupBy(rec, value) },
    setHideEmpty: function (value) { setHideEmpty(rec, value) },
    setMarkOnScroll: function (value) { setMarkOnScroll(rec, value) },
    setShowDigest: function (value) { setShowDigest(rec, value) },
    setInterestOrder: function (value) { setInterestOrder(rec, value) },
    digest: function (item) { return digestOf(rec, item) },
    releaseSticky: function (ids) { releaseSticky(rec, ids) },
    trimSticky: function (ids) { trimSticky(rec, ids) },
    releaseHeld: function () { releaseHeld(rec) },
    setHold: function (value) { setHold(rec, value) },
    heldCount: function () { return heldCount(rec) },
    countInView: function () { return countInView(rec) },
    setFolderOpen: function (name, open) { setFolderOpen(rec, name, open) },
    setWidths: function (patch) { setWidths(rec, patch) },
    setRailHidden: function (hidden) { setRailHidden(rec, hidden) },
    addFeed: function (url, folder) { return rec.transport.addFeed(url, folder) },
    importOpml: function (opml, replace) { return rec.transport.importOpml(opml, replace) },
    exportOpml: function () { return rec.transport.exportOpml() },
    removeFeed: function (id) { return rec.transport.removeFeed(id) },
    setFeedFolder: function (id, folder) { return rec.transport.setFeedFolder(id, folder) },
    runAction: function (name) { return rec.transport.runAction(name) },
    mount: function () { mount(rec) },
    unmount: function () { unmount(rec) },
    dispose: function () { dispose(rec) },
    feedTitle: function (id) { return feedTitleOf(rec, id) },
    feedFolder: function (id) { return feedFolderOf(rec, id) },
    groupKey: function (item) { return groupKeyOf(rec, item) },
  }
}

// Persisted JSON crosses a file boundary, so the grouping is re-validated on
// the way in instead of trusted from the snapshot's type.
// Likewise for a panel that had no preference when the snapshot was written:
// a stored value that is not a boolean means the rec.reader never hid it.

/** The last explicit scope mark, so a too-wide action can be taken back. */
/**
   * Which query the Host is answering, and how to cancel it. Only the newest
   * answer may be applied, and the query it replaced is told to stop: the
   * Host's index build is the expensive part, and nobody is waiting for it.
   */
/** Rows whose body is being read, so an article opening twice reads it once. */
/**
   * Whether a surface is showing a list it wants held still. The transport asks
   * before it lets a refresh put rows where the rec.reader is looking; it is not
   * published, because a scroll must not republish the snapshot.
   */

function get(rec: ControllerRecord): ClientState {
  return rec.reader.getSnapshot()
}

function subscribe(rec: ControllerRecord, listener: () => void): () => void {
  return rec.reader.subscribe(listener)
}

/**
   * Publish one consistent snapshot. Both halves merge in the same step, so a
   * change that moves both — a load that also drops the selection — never
   * renders the intermediate one.
   * @param dataPatch - archive, marks, or repository facts that moved.
   * @param uiPatch - viewing state that moved.
   */
function commit(rec: ControllerRecord, dataPatch: Partial<ReaderData> | null, uiPatch: Partial<ReaderUi> | null): void {
  if (dataPatch) rec.data = Object.assign({}, rec.data, dataPatch)
  if (uiPatch) rec.ui = Object.assign({}, rec.ui, uiPatch)
  rec.store.set(Object.assign({}, rec.data, rec.ui))
}

/** Publish a change the transport made to the archive or the repository. */
function setData(rec: ControllerRecord, patch: Partial<ReaderData>): void {
  commit(rec, patch, null)
}

/** Publish a change the rec.reader made to what it is looking at. */
function setUi(rec: ControllerRecord, patch: Partial<ReaderUi>): void {
  commit(rec, null, patch)
}


function setBusy(rec: ControllerRecord, key: string, value: boolean): void {
  const busy = Object.assign({}, rec.ui.busy)
  if (value) busy[key] = true
  else Reflect.deleteProperty(busy, key)
  setUi(rec, { busy: busy })
}

function toast(rec: ControllerRecord, text: string, error?: boolean, undo?: boolean): void {
  if (rec.toastTimer) clearTimeout(rec.toastTimer)
  setUi(rec, { toast: { text: text, error: !!error, at: Date.now(), undo: !!undo } })
  // An undoable mark stays on screen long enough to be taken back.
  rec.toastTimer = setTimeout(function () {
    rec.toastTimer = null
    setUi(rec, { toast: null })
  }, error || undo ? 8000 : 3500)
}

/** Dismiss the banner early, e.g. once the shared toast has faded out. */
function dismissToast(rec: ControllerRecord): void {
  if (rec.toastTimer) {
    clearTimeout(rec.toastTimer)
    rec.toastTimer = null
  }
  if (rec.ui.toast) setUi(rec, { toast: null })
}

/** The list's inputs, gathered from the snapshot the rec.reader publishes. */
function view(rec: ControllerRecord): ReaderView {
  return {
    items: rec.data.items,
    read: rec.data.read,
    starred: rec.data.starred,
    feeds: rec.data.feedMap,
    filter: rec.ui.filter,
    query: rec.ui.query,
    searchIds: rec.ui.searchIds,
    feedId: rec.ui.feedId,
    stickyRead: rec.transport.sticky,
    heldArrivals: rec.transport.held,
    uncategorized: rec.t('feed.uncategorized'),
  }
}

function getList(rec: ControllerRecord): Item[] {
  // The epoch covers every rebuild the rows can see: a new item model, a
  // changed read/star set, or a fresh answer from the Host's search. The
  // state version is not part of the key, because it also moves for git and
  // schedule polling, and rebuilding the rows for those would hand the list
  // a fresh array on every quiet refresh.
  const key = [rec.ui.filter, rec.ui.query, rec.ui.feedId || '', rec.ui.listEpoch].join('\u0000')
  if (rec.listCache.key !== key) {
    rec.listCache = { key: key, items: listOf(view(rec)) }
  }
  return rec.listCache.items
}

/**
   * Ask the Host for the rows the query matches. The bodies are the Host's:
   * the rec.reader carries what the list draws, not what it searches.
   * @param needle - the trimmed query.
   */
function searchFor(rec: ControllerRecord, needle: string): void {
  const seq = ++rec.searchSeq
  if (rec.searchAbort) rec.searchAbort.abort()
  const controller = new AbortController()
  rec.searchAbort = controller
  rec.transport.search(needle, controller.signal).then(function (ids) {
    // A newer query was typed while this one was answered.
    if (seq !== rec.searchSeq || controller.signal.aborted) return
    if (rec.ui.query.trim() !== needle) return
    setUi(rec, { searchIds: new Set(ids) })
    bumpList(rec)
  }).catch(function (err: unknown) {
    // A cancelled query says nothing: the rec.reader already moved on.
    if (seq !== rec.searchSeq || controller.signal.aborted) return
    toast(rec, rec.t('toast.failed', { error: messageOf(err) }), true)
    setUi(rec, { searchIds: new Set() })
    bumpList(rec)
  })
}

function digestOf(rec: ControllerRecord, item: Item): string {
  const key = `${item.id}:${item.summary ? item.summary.length : 0}`
  let text = rec.digestCache.get(key)
  if (text === undefined) {
    text = digestText(item.summary)
    if (rec.digestCache.size > 4000) rec.digestCache.clear()
    rec.digestCache.set(key, text)
  }
  return text
}

function feedTitleOf(rec: ControllerRecord, id: string): string {
  return feedTitle(rec.data.feedMap, id)
}

function feedFolderOf(rec: ControllerRecord, id: string): string {
  return feedFolder(rec.data.feedMap, id, rec.t('feed.uncategorized'))
}

function groupKeyOf(rec: ControllerRecord, item: Item): string {
  const groupBy = rec.ui.groupBy || rec.data.reader.groupBy || 'none'
  return groupKey(item, groupBy, rec.data.feedMap, rec.t('feed.uncategorized'))
}

/**
   * Mark items read or unread.
   * @param ids item ids.
   * @param value target state.
   * @param [keepList] keep the affected rows in the list until the scope
   * changes. Implicit marks (opening an article, scrolling past a row) keep
   * them so nothing moves under the pointer; an explicit "mark these read"
   * command drops them, because that is the feedback the rec.reader asked for.
   */
function mark(rec: ControllerRecord, ids: string[], value: boolean, keepList?: boolean): Promise<void> {
  const clean = (Array.isArray(ids) ? ids : []).filter(function (id) {
    return typeof id === 'string' && id.length > 0 && id.length < 64
  })
  if (!clean.length) return Promise.resolve()
  // An implicit mark keeps the rows that are on screen; the transport applies
  // the mark and holds those rows until the scope changes.
  const shown = keepList && value ? new Set(getList(rec).map(function (item) { return item.id })) : null
  const request = rec.transport.mark(clean, value, shown)
  // The transport already reconnected and told the rec.reader what failed; most
  // callers are event handlers that never look at this promise.
  request.catch(function () { /* reported by the transport */ })
  return request
}

/**
   * Forget the rows that were kept only so the current list would stay put, and
   * let the arrivals that were waiting for the rec.reader to move land with them.
   */
function clearSticky(rec: ControllerRecord): void {
  rec.transport.clearSticky()
  rec.transport.releaseHeld()
}

/**
   * Let a refresh's held arrivals land, rebuilding the list when that adds
   * rows. The list calls this once the viewport is back at the top, where new
   * rows are what the rec.reader expects to find.
   */
function releaseHeld(rec: ControllerRecord): void {
  if (rec.transport.releaseHeld()) bumpList(rec)
}

/**
   * Tell the transport whether a surface is showing a list it wants held
   * still, which is any list with rows on it.
   * @param value - whether a list with rows is on screen.
   */
function setHold(rec: ControllerRecord, value: boolean): void {
  rec.hold = value
}

/** How many rows a refresh is holding back until the rec.reader asks for them. */
function heldCount(rec: ControllerRecord): number {
  return rec.transport.held.size
}

/**
   * Rows the current view has, counted from the archive instead of from the
   * list, so a row a refresh is holding still counts as something to read.
   */
function countInView(rec: ControllerRecord): number {
  const query = rec.ui.query.trim()
  let n = 0
  for (const item of rec.data.items) {
    if (rec.ui.feedId && item.feed !== rec.ui.feedId) continue
    if (rec.ui.filter === 'unread' && rec.data.read.has(item.id)) continue
    if (rec.ui.filter === 'starred' && !rec.data.starred.has(item.id)) continue
    if (query && !(rec.ui.searchIds && rec.ui.searchIds.has(item.id))) continue
    n++
  }
  return n
}

/**
   * Let go of rows a finished section no longer needs kept, and rebuild so the
   * section leaves. The list asked for this once its fade is done.
   */
function releaseSticky(rec: ControllerRecord, ids: string[]): void {
  rec.transport.release(ids)
  bumpList(rec)
}

/**
   * Drop the rows a scroll left behind. They were held so the list would not
   * move under the pointer, and the anchor holds that now; the rebuild is
   * skipped when nothing was actually held, so a scroll over rows that never
   * stuck costs nothing.
   */
function trimSticky(rec: ControllerRecord, ids: string[]): void {
  if (!rec.transport.release(ids)) return
  bumpList(rec)
}

function bumpList(rec: ControllerRecord) {
  setUi(rec, { listEpoch: rec.ui.listEpoch + 1 })
}

/**
   * Read the body of a row the wire only carried a digest of. The list draws a
   * digest and the text filter is the Host's, so the one body worth reading is
   * the one the rec.reader is about to read.
   * @param id - the row the article is opening.
   */
function ensureBody(rec: ControllerRecord, id: string): void {
  const item = rec.data.byId.get(id)
  if (!item || !item.bodyChars || item.bodyChars <= item.summary.length) return
  if (rec.bodyRequests.has(id)) return
  rec.bodyRequests.add(id)
  rec.transport.body(id).then(function (full) {
    rec.bodyRequests.delete(id)
    if (!full) return
    const before = rec.data
    if (!before.byId.has(id)) return
    const row = Object.assign({}, full)
    Reflect.deleteProperty(row, 'bodyChars')
    const byId = new Map(before.byId)
    byId.set(id, row)
    const items = before.items.map(function (item) { return item.id === id ? row : item })
    // No list epoch: the digest is unchanged, and rebuilding the rows under
    // the pointer to lengthen one body in the article is a reflow for nothing.
    setData(rec, { items: items, byId: byId })
  }).catch(function (err: unknown) {
    rec.bodyRequests.delete(id)
    toast(rec, rec.t('toast.failed', { error: messageOf(err) }), true)
  })
}

/**
   * The acts already told to the Host, so a j/k sweep through a list logs each
   * row once rather than once per visit.
   */

/**
   * Tell the Host which rows the rec.reader is actually reading. Opening a row and
   * starring one are the two signals the source order is built from; a read
   * mark is not one, because scrolling and bulk marking saturate it.
   * @param kind - `open` for a selected row, `star` for an explicit one.
   * @param id - the row.
   */
function recordAttention(rec: ControllerRecord, kind: 'open' | 'star', id: string): void {
  const item = rec.data.byId.get(id)
  if (!item) return
  const key = `${kind}\u0000${id}`
  if (rec.attentionSent.has(key)) return
  rec.attentionSent.add(key)
  rec.transport.attention(kind, id, item.feed)
}

function select(rec: ControllerRecord, id: string | null): void {
  if (!id) {
    setUi(rec, { current: null })
    return
  }
  if (!rec.data.byId.has(id)) return
  setUi(rec, { current: id })
  ensureBody(rec, id)
  recordAttention(rec, 'open', id)
  if (!rec.data.read.has(id)) void mark(rec, [id], true, true)
}

function closeArticle(rec: ControllerRecord) {
  setUi(rec, { current: null })
}

function selectFeed(rec: ControllerRecord, id: string | null): void {
  if ((id || null) !== rec.ui.feedId) clearSticky(rec)
  setUi(rec, { feedId: id || null })
}

function setFilter(rec: ControllerRecord, filter: Filter): void {
  if (filter !== rec.ui.filter) clearSticky(rec)
  setUi(rec, { filter: filter })
}

function setQuery(rec: ControllerRecord, query: string): void {
  const next = query || ''
  if (next !== rec.ui.query) clearSticky(rec)
  setUi(rec, { query: next })
  const needle = next.trim()
  if (needle) {
    searchFor(rec, needle)
    return
  }
  // An empty box is the whole view again, and no answer is pending for it.
  rec.searchSeq += 1
  if (rec.searchAbort) rec.searchAbort.abort()
  if (rec.ui.searchIds) setUi(rec, { searchIds: null })
}

function move(rec: ControllerRecord, offset: number): void {
  const list = getList(rec)
  if (!list.length) return
  let index = list.findIndex(function (item) { return item.id === rec.ui.current })
  if (index === -1) index = offset > 0 ? -1 : list.length
  const next = list.at(clamp(index + offset, 0, list.length - 1))
  if (next) select(rec, next.id)
}

function toggleRead(rec: ControllerRecord): void {
  const id = rec.ui.current
  if (!id) return
  const isRead = rec.data.read.has(id)
  // Marking read keeps the row where it is, the way opening an article does:
  // the section fade or the band trim lets it go once it is out of the way.
  // Marking unread puts it back, so that direction rebuilds at once.
  void mark(rec, [id], !isRead, !isRead)
  if (isRead) bumpList(rec)
}

/**
   * Star or unstar one item.
   * @param [id] the row whose star was clicked; the open article when omitted.
   */
function toggleStar(rec: ControllerRecord, id?: string): void {
  const target = id || rec.ui.current
  if (!target) return
  const on = !rec.data.starred.has(target)
  const starred = new Set(rec.data.starred)
  if (on) starred.add(target)
  else starred.delete(target)
  setData(rec, { starred: starred })
  if (on) recordAttention(rec, 'star', target)
  // Under the Starred filter the star is what membership *is*, so that is
  // the one view that has to rebuild its rows; in the others the glyph
  // updates in place and the list stays where the rec.reader left it.
  if (rec.ui.filter === 'starred') bumpList(rec)
  rec.transport.star(target, on).catch(function (err: unknown) {
    const revert = new Set(rec.data.starred)
    if (on) revert.delete(target)
    else revert.add(target)
    setData(rec, { starred: revert })
    toast(rec, rec.t('toast.failed', { error: messageOf(err) }), true)
  })
}

function openCurrent(rec: ControllerRecord): void {
  const id = rec.ui.current
  const item = id ? rec.data.byId.get(id) : undefined
  if (item && item.link && /^https?:/i.test(item.link)) {
    window.open(item.link, '_blank', 'noopener,noreferrer')
  }
}

function escape(rec: ControllerRecord): void {
  if (rec.ui.current) {
    closeArticle(rec)
    return
  }
  // Clearing the scope is a scope change like any other: the rows the old
  // scope kept reachable go with it.
  if (rec.ui.query || rec.ui.feedId) clearSticky(rec)
  rec.searchSeq += 1
  if (rec.searchAbort) rec.searchAbort.abort()
  setUi(rec, { query: '', feedId: null, searchIds: null })
}

/**
   * Run one explicit scope mark: read rows leave the list, the toast offers to
   * take it back, and only the most recent one can be undone.
   */
function runScopeMark(rec: ControllerRecord, ids: string[]): void {
  if (!ids.length) return
  rec.lastScopeMark = ids.slice()
  void mark(rec, ids, true, false)
  bumpList(rec)
  toast(rec, rec.t('toast.marked', { n: ids.length }), false, true)
}

function markAll(rec: ControllerRecord): void {
  runScopeMark(rec, getList(rec)
    .filter(function (item) { return !rec.data.read.has(item.id) })
    .map(function (item) { return item.id }))
}

function markGroup(rec: ControllerRecord, key: string): void {
  runScopeMark(rec, getList(rec)
    .filter(function (item) { return groupKeyOf(rec, item) === key && !rec.data.read.has(item.id) })
    .map(function (item) { return item.id }))
}

/** Every unread item of one source, whatever the list filter is showing. */
function markFeed(rec: ControllerRecord, feedId: string): void {
  runScopeMark(rec, rec.data.items
    .filter(function (item) { return item.feed === feedId && !rec.data.read.has(item.id) })
    .map(function (item) { return item.id }))
}

/** Every unread item of one folder, whatever the list filter is showing. */
function markFolder(rec: ControllerRecord, folder: string): void {
  runScopeMark(rec, rec.data.items
    .filter(function (item) {
      return !rec.data.read.has(item.id) && feedFolderOf(rec, item.feed) === folder
    })
    .map(function (item) { return item.id }))
}

/** Take back the last scope mark; scroll and selection marks are not tracked. */
function undoMark(rec: ControllerRecord): void {
  const last = rec.lastScopeMark
  rec.lastScopeMark = null
  if (!last || !last.length) return
  void mark(rec, last, false, false)
  bumpList(rec)
  toast(rec, rec.t('toast.unmarked', { n: last.length }))
}

/**
   * How many unread items each marking scope would touch. The mark menu shows
   * these numbers before it acts, so a five-figure action never hides behind a
   * button that looks like the small one next to it.
   */
function markCounts(rec: ControllerRecord): MarkCounts {
  return markCountsOf(view(rec), getList(rec))
}

/** Mark every unread item in the rec.reader, whatever the scope on screen is. */
function markEverything(rec: ControllerRecord): void {
  runScopeMark(rec, rec.data.items
    .filter(function (item) { return !rec.data.read.has(item.id) })
    .map(function (item) { return item.id }))
}

function setGroupBy(rec: ControllerRecord, value: string): void {
  const next = value === 'folder' || value === 'feed' ? value : 'none'
  rec.prefs.update(function (draft) { draft.groupBy = next })
  setUi(rec, { groupBy: next })
}

function setHideEmpty(rec: ControllerRecord, value: boolean): void {
  rec.prefs.update(function (draft) { draft.hideEmpty = value })
  setUi(rec, { hideEmpty: value })
}

function setMarkOnScroll(rec: ControllerRecord, value: boolean): void {
  rec.prefs.update(function (draft) { draft.markOnScroll = value })
  setUi(rec, { markOnScroll: value })
}

function setShowDigest(rec: ControllerRecord, value: boolean): void {
  rec.prefs.update(function (draft) { draft.showDigest = value })
  setUi(rec, { showDigest: value })
}

function setInterestOrder(rec: ControllerRecord, value: boolean): void {
  rec.prefs.update(function (draft) { draft.interestOrder = value })
  setUi(rec, { interestOrder: value })
}

function setFolderOpen(rec: ControllerRecord, name: string, open: boolean): void {
  rec.prefs.update(function (draft) { draft.folderOpen[name] = open })
  setUi(rec, { folderOpen: Object.assign({}, rec.prefs.getSnapshot().folderOpen) })
}

function setWidths(rec: ControllerRecord, patch: { railW?: number; listW?: number }): void {
  const next: { railW?: number; listW?: number } = {}
  if (typeof patch.railW === 'number' && Number.isFinite(patch.railW)) {
    const railW = clamp(Math.round(patch.railW), RAIL_MIN, RAIL_MAX)
    next.railW = railW
    rec.prefs.update(function (draft) { draft.railW = railW })
  }
  if (typeof patch.listW === 'number' && Number.isFinite(patch.listW)) {
    const listW = clamp(Math.round(patch.listW), LIST_MIN, LIST_MAX)
    next.listW = listW
    rec.prefs.update(function (draft) { draft.listW = listW })
  }
  if (Object.keys(next).length) setUi(rec, next)
}

function setRailHidden(rec: ControllerRecord, hidden: boolean): void {
  rec.prefs.update(function (draft) { draft.railHidden = hidden })
  setUi(rec, { railHidden: hidden })
}

/** The mount refcount the transport polls on while any surface is on screen. */
function mount(rec: ControllerRecord): void {
  rec.transport.mount()
}

function unmount(rec: ControllerRecord): void {
  rec.transport.unmount()
}

function dispose(rec: ControllerRecord): void {
  if (rec.toastTimer) clearTimeout(rec.toastTimer)
  rec.toastTimer = null
  rec.transport.dispose()
}
