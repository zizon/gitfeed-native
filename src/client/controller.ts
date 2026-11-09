/**
 * The reader's command surface: what the reader is looking at, the derivations
 * over it, and the commands a surface calls. The requests themselves live in
 * transport.ts; this file owns the published state both halves read.
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
import type { PrefsStore } from './prefs.js'
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

export function createController(t: Translate, prefs: PrefsStore): Controller {
  const saved = prefs.getSnapshot()
  // Persisted JSON crosses a file boundary, so the grouping is re-validated on
  // the way in instead of trusted from the snapshot's type.
  const savedGroupBy: GroupBy | null = saved.groupBy === 'none' || saved.groupBy === 'folder' || saved.groupBy === 'feed'
    ? saved.groupBy
    : null
  let data: ReaderData = {
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
    reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: 'none' },
    git: null,
    schedule: [],
    version: null,
    repo: '',
    allowGit: true,
  }
  let ui: ReaderUi = {
    filter: 'unread',
    query: '',
    searchIds: null,
    feedId: null,
    current: null,
    groupBy: savedGroupBy,
    hideEmpty: saved.hideEmpty,
    markOnScroll: saved.markOnScroll,
    showDigest: saved.showDigest,
    folderOpen: saved.folderOpen,
    railW: clamp(saved.railW, RAIL_MIN, RAIL_MAX),
    listW: clamp(saved.listW, LIST_MIN, LIST_MAX),
    listEpoch: 0,
    busy: {},
    toast: null,
  }

  const store = createSnapshotStore<ClientState>(Object.assign({}, data, ui))
  /** The published snapshot; the renderer binds it, nothing writes through it. */
  const reader: ReaderSource = store

  const digestCache = new Map<string, string>()
  let listCache: { key: string | null; items: Item[] } = { key: null, items: [] }
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  /** The last explicit scope mark, so a too-wide action can be taken back. */
  let lastScopeMark: string[] | null = null
  /**
   * Which query the Host is answering, and how to cancel it. Only the newest
   * answer may be applied, and the query it replaced is told to stop: the
   * Host's index build is the expensive part, and nobody is waiting for it.
   */
  let searchSeq = 0
  let searchAbort: AbortController | null = null
  /** Rows whose body is being read, so an article opening twice reads it once. */
  const bodyRequests = new Set<string>()
  /**
   * Whether the list is scrolled into the archive. The transport asks before it
   * lets a refresh put rows where the reader is looking; it is not published,
   * because a scroll must not republish the snapshot.
   */
  let scrolled = false

  function get(): ClientState {
    return reader.getSnapshot()
  }

  function subscribe(listener: () => void): () => void {
    return reader.subscribe(listener)
  }

  /**
   * Publish one consistent snapshot. Both halves merge in the same step, so a
   * change that moves both — a load that also drops the selection — never
   * renders the intermediate one.
   * @param dataPatch - archive, marks, or repository facts that moved.
   * @param uiPatch - viewing state that moved.
   */
  function commit(dataPatch: Partial<ReaderData> | null, uiPatch: Partial<ReaderUi> | null): void {
    if (dataPatch) data = Object.assign({}, data, dataPatch)
    if (uiPatch) ui = Object.assign({}, ui, uiPatch)
    store.set(Object.assign({}, data, ui))
  }

  /** Publish a change the transport made to the archive or the repository. */
  function setData(patch: Partial<ReaderData>): void {
    commit(patch, null)
  }

  /** Publish a change the reader made to what it is looking at. */
  function setUi(patch: Partial<ReaderUi>): void {
    commit(null, patch)
  }

  const transport: Transport = createTransport({
    read: function () { return { data: data, ui: ui } },
    setData: setData,
    setUi: setUi,
    commit: commit,
    setBusy: setBusy,
    toast: toast,
    titleOf: function (id: string) { return feedTitle(data.feedMap, id) },
    scrolled: function () { return scrolled },
    refilter: function () {
      // The model moved under a query: ask again for the text the reader left
      // in the box, so a row a refresh brought in is searchable at once.
      const needle = ui.query.trim()
      if (needle) searchFor(needle)
    },
    refetchBody: function (id: string) {
      // A row that arrived as a digest under the open article: read it whole
      // again. ensureBody is a no-op when the row is complete or already being
      // read.
      ensureBody(id)
    },
    resetText: function () {
      // The digest cache is the one text cache the reader still owns: search
      // is the Host's answer now, not text this half derives.
      digestCache.clear()
    },
    t: t,
  })

  function setBusy(key: string, value: boolean): void {
    const busy = Object.assign({}, ui.busy)
    if (value) busy[key] = true
    else Reflect.deleteProperty(busy, key)
    setUi({ busy: busy })
  }

  function toast(text: string, error?: boolean, undo?: boolean): void {
    if (toastTimer) clearTimeout(toastTimer)
    setUi({ toast: { text: text, error: !!error, at: Date.now(), undo: !!undo } })
    // An undoable mark stays on screen long enough to be taken back.
    toastTimer = setTimeout(function () {
      toastTimer = null
      setUi({ toast: null })
    }, error || undo ? 8000 : 3500)
  }

  /** Dismiss the banner early, e.g. once the shared toast has faded out. */
  function dismissToast(): void {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    if (ui.toast) setUi({ toast: null })
  }

  /** The list's inputs, gathered from the snapshot the reader publishes. */
  function view(): ReaderView {
    return {
      items: data.items,
      read: data.read,
      starred: data.starred,
      feeds: data.feedMap,
      filter: ui.filter,
      query: ui.query,
      searchIds: ui.searchIds,
      feedId: ui.feedId,
      stickyRead: transport.sticky,
      heldArrivals: transport.held,
      uncategorized: t('feed.uncategorized'),
    }
  }

  function getList(): Item[] {
    // The epoch covers every rebuild the rows can see: a new item model, or a
    // changed read/star set. The state version is not part of the key, because
    // it also moves for git and schedule polling, and rebuilding the rows for
    // those would hand the list a fresh array on every quiet refresh.
    // The epoch covers every rebuild the rows can see: a new item model, a
    // changed read/star set, or a fresh answer from the Host's search. The
    // state version is not part of the key, because it also moves for git and
    // schedule polling, and rebuilding the rows for those would hand the list
    // a fresh array on every quiet refresh.
    const key = [ui.filter, ui.query, ui.feedId || '', ui.listEpoch].join('\u0000')
    if (listCache.key !== key) {
      listCache = { key: key, items: listOf(view()) }
    }
    return listCache.items
  }

  /**
   * Ask the Host for the rows the query matches. The bodies are the Host's:
   * the reader carries what the list draws, not what it searches.
   * @param needle - the trimmed query.
   */
  function searchFor(needle: string): void {
    const seq = ++searchSeq
    if (searchAbort) searchAbort.abort()
    const controller = new AbortController()
    searchAbort = controller
    transport.search(needle, controller.signal).then(function (ids) {
      // A newer query was typed while this one was answered.
      if (seq !== searchSeq || controller.signal.aborted) return
      if (ui.query.trim() !== needle) return
      setUi({ searchIds: new Set(ids) })
      bumpList()
    }).catch(function (err: unknown) {
      // A cancelled query says nothing: the reader already moved on.
      if (seq !== searchSeq || controller.signal.aborted) return
      toast(t('toast.failed', { error: messageOf(err) }), true)
      setUi({ searchIds: new Set() })
      bumpList()
    })
  }

  function digestOf(item: Item): string {
    const key = `${item.id}:${item.summary ? item.summary.length : 0}`
    let text = digestCache.get(key)
    if (text === undefined) {
      text = digestText(item.summary)
      if (digestCache.size > 4000) digestCache.clear()
      digestCache.set(key, text)
    }
    return text
  }

  function feedTitleOf(id: string): string {
    return feedTitle(data.feedMap, id)
  }

  function feedFolderOf(id: string): string {
    return feedFolder(data.feedMap, id, t('feed.uncategorized'))
  }

  function groupKeyOf(item: Item): string {
    const groupBy = ui.groupBy || data.reader.groupBy || 'none'
    return groupKey(item, groupBy, data.feedMap, t('feed.uncategorized'))
  }

  /**
   * Mark items read or unread.
   * @param ids item ids.
   * @param value target state.
   * @param [keepList] keep the affected rows in the list until the scope
   * changes. Implicit marks (opening an article, scrolling past a row) keep
   * them so nothing moves under the pointer; an explicit "mark these read"
   * command drops them, because that is the feedback the reader asked for.
   */
  function mark(ids: string[], value: boolean, keepList?: boolean): Promise<void> {
    const clean = (Array.isArray(ids) ? ids : []).filter(function (id) {
      return typeof id === 'string' && id.length > 0 && id.length < 64
    })
    if (!clean.length) return Promise.resolve()
    // An implicit mark keeps the rows that are on screen; the transport applies
    // the mark and holds those rows until the scope changes.
    const shown = keepList && value ? new Set(getList().map(function (item) { return item.id })) : null
    const request = transport.mark(clean, value, shown)
    // The transport already reconnected and told the reader what failed; most
    // callers are event handlers that never look at this promise.
    request.catch(function () { /* reported by the transport */ })
    return request
  }

  /**
   * Forget the rows that were kept only so the current list would stay put, and
   * let the arrivals that were waiting for the reader to move land with them.
   */
  function clearSticky(): void {
    transport.clearSticky()
    transport.releaseHeld()
  }

  /**
   * Let a refresh's held arrivals land, rebuilding the list when that adds
   * rows. The list calls this once the viewport is back at the top, where new
   * rows are what the reader expects to find.
   */
  function releaseHeld(): void {
    if (transport.releaseHeld()) bumpList()
  }

  /** Tell the transport whether the list is scrolled into the archive. */
  function setScrolled(value: boolean): void {
    scrolled = value
  }

  /**
   * Rows the current view has, counted from the archive instead of from the
   * list, so a row a refresh is holding still counts as something to read.
   */
  function countInView(): number {
    const query = ui.query.trim()
    let n = 0
    for (const item of data.items) {
      if (ui.feedId && item.feed !== ui.feedId) continue
      if (ui.filter === 'unread' && data.read.has(item.id)) continue
      if (ui.filter === 'starred' && !data.starred.has(item.id)) continue
      if (query && !(ui.searchIds && ui.searchIds.has(item.id))) continue
      n++
    }
    return n
  }

  /**
   * Let go of rows a finished section no longer needs kept, and rebuild so the
   * section leaves. The list asked for this once its fade is done.
   */
  function releaseSticky(ids: string[]): void {
    transport.release(ids)
    bumpList()
  }

  /**
   * Drop the rows a scroll left behind. They were held so the list would not
   * move under the pointer, and the anchor holds that now; the rebuild is
   * skipped when nothing was actually held, so a scroll over rows that never
   * stuck costs nothing.
   */
  function trimSticky(ids: string[]): void {
    if (!transport.release(ids)) return
    bumpList()
  }

  function bumpList() {
    setUi({ listEpoch: ui.listEpoch + 1 })
  }

  /**
   * Read the body of a row the wire only carried a digest of. The list draws a
   * digest and the text filter is the Host's, so the one body worth reading is
   * the one the reader is about to read.
   * @param id - the row the article is opening.
   */
  function ensureBody(id: string): void {
    const item = data.byId.get(id)
    if (!item || !item.bodyChars || item.bodyChars <= item.summary.length) return
    if (bodyRequests.has(id)) return
    bodyRequests.add(id)
    transport.body(id).then(function (full) {
      bodyRequests.delete(id)
      if (!full) return
      const before = data
      if (!before.byId.has(id)) return
      const row = Object.assign({}, full)
      Reflect.deleteProperty(row, 'bodyChars')
      const byId = new Map(before.byId)
      byId.set(id, row)
      const items = before.items.map(function (item) { return item.id === id ? row : item })
      // No list epoch: the digest is unchanged, and rebuilding the rows under
      // the pointer to lengthen one body in the article is a reflow for nothing.
      setData({ items: items, byId: byId })
    }).catch(function (err: unknown) {
      bodyRequests.delete(id)
      toast(t('toast.failed', { error: messageOf(err) }), true)
    })
  }

  function select(id: string | null): void {
    if (!id) {
      setUi({ current: null })
      return
    }
    if (!data.byId.has(id)) return
    setUi({ current: id })
    ensureBody(id)
    if (!data.read.has(id)) void mark([id], true, true)
  }

  function closeArticle() {
    setUi({ current: null })
  }

  function selectFeed(id: string | null): void {
    if ((id || null) !== ui.feedId) clearSticky()
    setUi({ feedId: id || null })
  }

  function setFilter(filter: Filter): void {
    if (filter !== ui.filter) clearSticky()
    setUi({ filter: filter })
  }

  function setQuery(query: string): void {
    const next = query || ''
    if (next !== ui.query) clearSticky()
    setUi({ query: next })
    const needle = next.trim()
    if (needle) {
      searchFor(needle)
      return
    }
    // An empty box is the whole view again, and no answer is pending for it.
    searchSeq += 1
    if (searchAbort) searchAbort.abort()
    if (ui.searchIds) setUi({ searchIds: null })
  }

  function move(offset: number): void {
    const list = getList()
    if (!list.length) return
    let index = list.findIndex(function (item) { return item.id === ui.current })
    if (index === -1) index = offset > 0 ? -1 : list.length
    const next = list.at(clamp(index + offset, 0, list.length - 1))
    if (next) select(next.id)
  }

  function toggleRead(): void {
    const id = ui.current
    if (!id) return
    const isRead = data.read.has(id)
    // Marking read keeps the row where it is, the way opening an article does:
    // the section fade or the band trim lets it go once it is out of the way.
    // Marking unread puts it back, so that direction rebuilds at once.
    void mark([id], !isRead, !isRead)
    if (isRead) bumpList()
  }

  /**
   * Star or unstar one item.
   * @param [id] the row whose star was clicked; the open article when omitted.
   */
  function toggleStar(id?: string): void {
    const target = id || ui.current
    if (!target) return
    const on = !data.starred.has(target)
    const starred = new Set(data.starred)
    if (on) starred.add(target)
    else starred.delete(target)
    setData({ starred: starred })
    // Under the Starred filter the star is what membership *is*, so that is
    // the one view that has to rebuild its rows; in the others the glyph
    // updates in place and the list stays where the reader left it.
    if (ui.filter === 'starred') bumpList()
    transport.star(target, on).catch(function (err: unknown) {
      const revert = new Set(data.starred)
      if (on) revert.delete(target)
      else revert.add(target)
      setData({ starred: revert })
      toast(t('toast.failed', { error: messageOf(err) }), true)
    })
  }

  function openCurrent(): void {
    const id = ui.current
    const item = id ? data.byId.get(id) : undefined
    if (item && item.link && /^https?:/i.test(item.link)) {
      window.open(item.link, '_blank', 'noopener,noreferrer')
    }
  }

  function escape(): void {
    if (ui.current) {
      closeArticle()
      return
    }
    // Clearing the scope is a scope change like any other: the rows the old
    // scope kept reachable go with it.
    if (ui.query || ui.feedId) clearSticky()
    searchSeq += 1
    if (searchAbort) searchAbort.abort()
    setUi({ query: '', feedId: null, searchIds: null })
  }

  /**
   * Run one explicit scope mark: read rows leave the list, the toast offers to
   * take it back, and only the most recent one can be undone.
   */
  function runScopeMark(ids: string[]): void {
    if (!ids.length) return
    lastScopeMark = ids.slice()
    void mark(ids, true, false)
    bumpList()
    toast(t('toast.marked', { n: ids.length }), false, true)
  }

  function markAll(): void {
    runScopeMark(getList()
      .filter(function (item) { return !data.read.has(item.id) })
      .map(function (item) { return item.id }))
  }

  function markGroup(key: string): void {
    runScopeMark(getList()
      .filter(function (item) { return groupKeyOf(item) === key && !data.read.has(item.id) })
      .map(function (item) { return item.id }))
  }

  /** Every unread item of one source, whatever the list filter is showing. */
  function markFeed(feedId: string): void {
    runScopeMark(data.items
      .filter(function (item) { return item.feed === feedId && !data.read.has(item.id) })
      .map(function (item) { return item.id }))
  }

  /** Every unread item of one folder, whatever the list filter is showing. */
  function markFolder(folder: string): void {
    runScopeMark(data.items
      .filter(function (item) {
        return !data.read.has(item.id) && feedFolderOf(item.feed) === folder
      })
      .map(function (item) { return item.id }))
  }

  /** Take back the last scope mark; scroll and selection marks are not tracked. */
  function undoMark(): void {
    const last = lastScopeMark
    lastScopeMark = null
    if (!last || !last.length) return
    void mark(last, false, false)
    bumpList()
    toast(t('toast.unmarked', { n: last.length }))
  }

  /**
   * How many unread items each marking scope would touch. The mark menu shows
   * these numbers before it acts, so a five-figure action never hides behind a
   * button that looks like the small one next to it.
   */
  function markCounts(): MarkCounts {
    return markCountsOf(view(), getList())
  }

  /** Mark every unread item in the reader, whatever the scope on screen is. */
  function markEverything(): void {
    runScopeMark(data.items
      .filter(function (item) { return !data.read.has(item.id) })
      .map(function (item) { return item.id }))
  }

  function setGroupBy(value: string): void {
    const next = value === 'folder' || value === 'feed' ? value : 'none'
    prefs.update(function (draft) { draft.groupBy = next })
    setUi({ groupBy: next })
  }

  function setHideEmpty(value: boolean): void {
    prefs.update(function (draft) { draft.hideEmpty = value })
    setUi({ hideEmpty: value })
  }

  function setMarkOnScroll(value: boolean): void {
    prefs.update(function (draft) { draft.markOnScroll = value })
    setUi({ markOnScroll: value })
  }

  function setShowDigest(value: boolean): void {
    prefs.update(function (draft) { draft.showDigest = value })
    setUi({ showDigest: value })
  }

  function setFolderOpen(name: string, open: boolean): void {
    prefs.update(function (draft) { draft.folderOpen[name] = open })
    setUi({ folderOpen: Object.assign({}, prefs.getSnapshot().folderOpen) })
  }

  function setWidths(patch: { railW?: number; listW?: number }): void {
    const next: { railW?: number; listW?: number } = {}
    if (typeof patch.railW === 'number' && Number.isFinite(patch.railW)) {
      const railW = clamp(Math.round(patch.railW), RAIL_MIN, RAIL_MAX)
      next.railW = railW
      prefs.update(function (draft) { draft.railW = railW })
    }
    if (typeof patch.listW === 'number' && Number.isFinite(patch.listW)) {
      const listW = clamp(Math.round(patch.listW), LIST_MIN, LIST_MAX)
      next.listW = listW
      prefs.update(function (draft) { draft.listW = listW })
    }
    if (Object.keys(next).length) setUi(next)
  }

  /** The mount refcount the transport polls on while any surface is on screen. */
  function mount(): void {
    transport.mount()
  }

  function unmount(): void {
    transport.unmount()
  }

  function dispose(): void {
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = null
    transport.dispose()
  }

  const api: Controller = {
    get: get,
    subscribe: subscribe,
    reader: reader,
    getList: getList,
    reconnect: transport.reconnect,
    mark: mark,
    select: select,
    closeArticle: closeArticle,
    selectFeed: selectFeed,
    setFilter: setFilter,
    setQuery: setQuery,
    move: move,
    toggleRead: toggleRead,
    toggleStar: toggleStar,
    openCurrent: openCurrent,
    escape: escape,
    markAll: markAll,
    markCounts: markCounts,
    markEverything: markEverything,
    undoMark: undoMark,
    dismissToast: dismissToast,
    markGroup: markGroup,
    markFeed: markFeed,
    markFolder: markFolder,
    setGroupBy: setGroupBy,
    setHideEmpty: setHideEmpty,
    setMarkOnScroll: setMarkOnScroll,
    setShowDigest: setShowDigest,
    digest: digestOf,
    releaseSticky: releaseSticky,
    trimSticky: trimSticky,
    releaseHeld: releaseHeld,
    setScrolled: setScrolled,
    countInView: countInView,
    setFolderOpen: setFolderOpen,
    setWidths: setWidths,
    addFeed: transport.addFeed,
    removeFeed: transport.removeFeed,
    setFeedFolder: transport.setFeedFolder,
    runAction: transport.runAction,
    mount: mount,
    unmount: unmount,
    dispose: dispose,
    feedTitle: feedTitleOf,
    feedFolder: feedFolderOf,
    groupKey: groupKeyOf,
  }
  return api
}
