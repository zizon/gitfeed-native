/**
 * The reader's single client state machine, shared by every surface.
 *
 * It holds two halves — the archive and repository facts a load brings in, and
 * what the reader is looking at — and publishes them as one snapshot. Every
 * write names the half it moves, so a transport change cannot rewrite the view
 * by accident.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Feed, GitInfo, GroupBy, Item, ReaderPrefs, ScheduleJobInfo } from '../shared/types.js'
import { PREFIX } from './constants.js'
import type { Translate } from './locales.js'
import {
  feedFolder,
  feedTitle,
  groupKey,
  haystackOf,
  listOf,
  markCountsOf,
} from './derive.js'
import type { ReaderView } from './derive.js'
import type { PrefsStore } from './prefs.js'
import type {
  ClientState,
  Controller,
  Filter,
  MarkCounts,
  ReaderData,
  ReaderSource,
  ReaderUi,
} from './types.js'
import {
  clamp,
  digestText,
  messageOf,
} from './util.js'

export const plainCache = new Map<string, string>()

interface ApiFeed {
  title?: string
  url?: string
}

interface ApiResponse {
  ok?: boolean
  error?: string
  output?: string
  version?: string
  feed?: ApiFeed
}

interface StateResponse {
  unchanged?: boolean
  error?: string
  version?: string
  itemsVersion?: string
  itemsUnchanged?: boolean
  items?: Item[]
  feeds?: Feed[]
  read?: string[]
  starred?: string[]
  reader?: ReaderPrefs
  git?: GitInfo | null
  schedule?: ScheduleJobInfo[]
  repo?: string
  allowGit?: boolean
}

function sameSet(current: Set<string>, next: Set<string>): boolean {
  if (current.size !== next.size) return false
  for (const id of next) if (!current.has(id)) return false
  return true
}

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
    feedId: null,
    current: null,
    groupBy: savedGroupBy,
    hideEmpty: saved.hideEmpty,
    markOnScroll: saved.markOnScroll,
    showDigest: saved.showDigest,
    folderOpen: saved.folderOpen,
    railW: clamp(saved.railW, 150, 460),
    listW: clamp(saved.listW, 260, 760),
    listEpoch: 0,
    busy: {},
    toast: null,
  }

  const store = createSnapshotStore<ClientState>(Object.assign({}, data, ui))
  /** The published snapshot; the renderer binds it, nothing writes through it. */
  const reader: ReaderSource = store

  const digestCache = new Map<string, string>()
  let listCache: { key: string | null; items: Item[] } = { key: null, items: [] }
  let loadPromise: Promise<void> | null = null
  let mounted = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let freshTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const pendingRead = new Set<string>()
  const pendingUnread = new Set<string>()
  /**
   * Read rows that stay in the Unread list until the scope changes. A row the
   * reader scrolled past or opened must not vanish from under the pointer,
   * which is what made the list jump on every mark.
   */
  const stickyRead = new Set<string>()
  /** The last explicit scope mark, so a too-wide action can be taken back. */
  let lastScopeMark: { ids: string[]; read: boolean } | null = null
  let visibilityHandler: (() => void) | null = null

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
      feedId: ui.feedId,
      stickyRead: stickyRead,
      uncategorized: t('feed.uncategorized'),
    }
  }

  function getList(): Item[] {
    // The epoch covers every rebuild the rows can see: a new item model, or a
    // changed read/star set. The state version is not part of the key, because
    // it also moves for git and schedule polling, and rebuilding the rows for
    // those would hand the list a fresh array on every quiet refresh.
    const key = [ui.filter, ui.query, ui.feedId || '', ui.listEpoch].join('\u0000')
    if (listCache.key !== key) {
      listCache = { key: key, items: listOf(view(), searchHay) }
    }
    return listCache.items
  }

  function searchHay(item: Item): string {
    const key = `${item.id}:${item.summary ? item.summary.length : 0}`
    let text = plainCache.get(key)
    if (text === undefined) {
      text = haystackOf(item, feedTitle(data.feedMap, item.feed))
      if (plainCache.size > 4000) plainCache.clear()
      plainCache.set(key, text)
    }
    return text
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

  function request(route: string, payload?: unknown): Promise<ApiResponse> {
    return fetch(PREFIX + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      cache: 'no-store',
      credentials: 'same-origin',
    }).then(async function (res) {
      let body: ApiResponse = {}
      try {
        body = (await res.json()) as ApiResponse
      } catch {
        body = {}
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    })
  }

  function load(options?: { force?: boolean }): Promise<void> {
    if (disposed) return Promise.resolve()
    if (loadPromise) return loadPromise
    const force = options?.force === true
    loadPromise = (async function () {
      if (!data.loadedOnce) setData({ status: 'loading' })
      const params: string[] = []
      if (!force && data.version) params.push(`version=${encodeURIComponent(data.version)}`)
      if (data.itemsVersion) params.push(`itemsVersion=${encodeURIComponent(data.itemsVersion)}`)
      const url = `${PREFIX}/state${params.length ? `?${params.join('&')}` : ''}`
      const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
      let payload: StateResponse
      try {
        payload = (await res.json()) as StateResponse
      } catch {
        throw new Error(`HTTP ${res.status}`)
      }
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`)
      if (payload.unchanged) {
        setData({
          status: 'ready',
          error: null,
          loadedOnce: true,
          git: payload.git || data.git,
          schedule: Array.isArray(payload.schedule) ? payload.schedule : data.schedule,
          repo: payload.repo || data.repo,
          allowGit: payload.allowGit !== false,
        })
        return
      }
      if (payload.error) {
        setData({
          status: 'error',
          error: payload.error,
          loadedOnce: true,
          version: payload.version || null,
          git: payload.git || null,
          schedule: Array.isArray(payload.schedule) ? payload.schedule : [],
        })
        return
      }
      // Rows travel only with the item model they belong to. A payload without
      // them is usable just when it names the model this reader already holds;
      // anything else means a mid-update race, so ask again from scratch.
      const replaceItems = Array.isArray(payload.items)
      if (!replaceItems && payload.itemsVersion !== data.itemsVersion) {
        setTimeout(function () { load({ force: true }).catch(function () { }) }, 0)
        return
      }
      const items = replaceItems ? (payload.items as Item[]) : data.items
      const byId = replaceItems
        ? new Map<string, Item>(items.map(function (item): [string, Item] { return [item.id, item] }))
        : data.byId
      // Rows that landed while the reader was already open: the list fades
      // them in instead of reflowing the page under the pointer.
      const fresh = new Set<string>()
      if (replaceItems && data.loadedOnce) {
        for (const item of items) if (!data.byId.has(item.id)) fresh.add(item.id)
      }
      const read = new Set<string>(Array.isArray(payload.read) ? payload.read : data.read)
      const starred = new Set<string>(Array.isArray(payload.starred) ? payload.starred : data.starred)
      const feeds: Feed[] = Array.isArray(payload.feeds) ? payload.feeds : data.feeds
      const feedMap = new Map<string, Feed>(feeds.map(function (feed): [string, Feed] { return [feed.id, feed] }))
      if (replaceItems) plainCache.clear()
      commit({
        status: 'ready',
        error: null,
        loadError: null,
        loadedOnce: true,
        items: items,
        byId: byId,
        itemsVersion: payload.itemsVersion || data.itemsVersion,
        fresh: fresh,
        feeds: feeds,
        feedMap: feedMap,
        read: read,
        starred: starred,
        reader: payload.reader || data.reader,
        git: payload.git || null,
        schedule: Array.isArray(payload.schedule) ? payload.schedule : [],
        version: payload.version || null,
        repo: payload.repo || data.repo,
        allowGit: payload.allowGit !== false,
      }, {
        current: ui.current && byId.has(ui.current) ? ui.current : null,
        listEpoch: replaceItems || !sameSet(data.read, read) || !sameSet(data.starred, starred)
          ? ui.listEpoch + 1
          : ui.listEpoch,
      })
      if (fresh.size) {
        if (freshTimer) clearTimeout(freshTimer)
        freshTimer = setTimeout(function () {
          freshTimer = null
          if (data.fresh.size) setData({ fresh: new Set() })
        }, 1600)
      }
    })().catch(function (err: unknown) {
      const text = messageOf(err)
      if (data.loadedOnce) {
        setData({ loadError: text })
        toast(t('toast.failed', { error: text }), true)
      } else {
        setData({ status: 'error', error: text, loadError: text, loadedOnce: true })
      }
    }).finally(function () {
      loadPromise = null
    })
    return loadPromise
  }

  function flushMarks() {
    flushTimer = null
    const readIds = Array.from(pendingRead)
    const unreadIds = Array.from(pendingUnread)
    pendingRead.clear()
    pendingUnread.clear()
    if (!readIds.length && !unreadIds.length) return
    const jobs: Array<Promise<ApiResponse>> = []
    if (readIds.length) jobs.push(request('/mark', { ids: readIds, read: true }))
    if (unreadIds.length) jobs.push(request('/mark', { ids: unreadIds, read: false }))
    Promise.all(jobs).then(function (results) {
      const last = results.at(-1)
      if (last?.version) setData({ version: last.version })
      load().catch(function () { })
    }).catch(function (err: unknown) {
      toast(t('toast.readFailed', { error: messageOf(err) }), true)
      load({ force: true }).catch(function () { })
    })
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
  function mark(ids: string[], value: boolean, keepList?: boolean): void {
    const clean = (Array.isArray(ids) ? ids : []).filter(function (id) {
      return typeof id === 'string' && id.length > 0 && id.length < 64
    })
    if (!clean.length) return
    const keep =  keepList
    const shown = keep && value ? new Set(getList().map(function (item) { return item.id })) : null
    const read = new Set(data.read)
    for (const id of clean) {
      if (value) read.add(id)
      else read.delete(id)
      if (value) {
        pendingRead.add(id)
        pendingUnread.delete(id)
        if (keep) {
          if (shown && shown.has(id)) stickyRead.add(id)
        } else {
          stickyRead.delete(id)
        }
      } else {
        pendingUnread.add(id)
        pendingRead.delete(id)
        stickyRead.delete(id)
      }
    }
    setData({ read: read })
    if (!flushTimer) flushTimer = setTimeout(flushMarks, 350)
  }

  /** Forget the rows that were kept only so the current list would stay put. */
  function clearSticky(): void {
    if (stickyRead.size) stickyRead.clear()
  }

  function bumpList() {
    setUi({ listEpoch: ui.listEpoch + 1 })
  }

  function select(id: string | null): void {
    if (!id) {
      setUi({ current: null })
      return
    }
    if (!data.byId.has(id)) return
    setUi({ current: id })
    if (!data.read.has(id)) mark([id], true)
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
    mark([id], !isRead)
    if (isRead) bumpList()
  }

  function toggleStar(): void {
    const id = ui.current
    if (!id) return
    const on = !data.starred.has(id)
    const starred = new Set(data.starred)
    if (on) starred.add(id)
    else starred.delete(id)
    setData({ starred: starred })
    request('/star', { ids: [id], star: on }).then(function (payload) {
      if (payload.version) setData({ version: payload.version })
      load().catch(function () { })
    }).catch(function (err: unknown) {
      const revert = new Set(data.starred)
      if (on) revert.delete(id)
      else revert.add(id)
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
    setUi({ query: '', feedId: null })
  }

  /**
   * Run one explicit scope mark: read rows leave the list, the toast offers to
   * take it back, and only the most recent one can be undone.
   */
  function runScopeMark(ids: string[]): void {
    if (!ids.length) return
    lastScopeMark = { ids: ids.slice(), read: true }
    mark(ids, true, false)
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
    if (!last || !last.ids.length) return
    mark(last.ids, !last.read, false)
    bumpList()
    toast(t('toast.unmarked', { n: last.ids.length }))
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
      const railW = clamp(Math.round(patch.railW), 150, 460)
      next.railW = railW
      prefs.update(function (draft) { draft.railW = railW })
    }
    if (typeof patch.listW === 'number' && Number.isFinite(patch.listW)) {
      const listW = clamp(Math.round(patch.listW), 260, 900)
      next.listW = listW
      prefs.update(function (draft) { draft.listW = listW })
    }
    if (Object.keys(next).length) setUi(next)
  }

  async function addFeed(url: string, folder: string): Promise<boolean> {
    if (ui.busy.add) return false
    setBusy('add', true)
    try {
      const payload = await request('/feeds', { url: url, folder: folder })
      if (payload.ok === false) throw new Error(payload.error || 'could not add feed')
      toast(t('toast.subscribed', { name: (payload.feed && (payload.feed.title || payload.feed.url)) || url }))
      await load({ force: true })
      return true
    } catch (err) {
      toast(t('toast.failed', { error: messageOf(err) }), true)
      return false
    } finally {
      setBusy('add', false)
    }
  }

  async function removeFeed(id: string): Promise<boolean> {
    if (!id || ui.busy.remove) return false
    setBusy('remove', true)
    try {
      const payload = await request('/feeds/remove', { id: id })
      if (payload.ok === false) throw new Error(payload.error || 'could not remove feed')
      if (ui.feedId === id) setUi({ feedId: null })
      toast(t('toast.unsubscribed', { name: feedTitleOf(id) }))
      await load({ force: true })
      return true
    } catch (err) {
      toast(t('toast.failed', { error: messageOf(err) }), true)
      return false
    } finally {
      setBusy('remove', false)
    }
  }

  async function runAction(name: string): Promise<void> {
    if (ui.busy[name]) return
    setBusy(name, true)
    try {
      const payload = await request(`/${name}`, {})
      if (payload.ok === false) {
        toast(t('toast.failed', { error: payload.error || payload.output || name }), true)
      } else if (name === 'fetch') {
        toast(t('toast.fetch', { summary: payload.output || 'ok' }))
      } else if (name === 'pull') {
        toast(t('toast.pull'))
      } else if (name === 'sync') {
        toast(t('toast.sync'))
      } else {
        toast(`${name}: ok`)
      }
      await load({ force: true })
    } catch (err) {
      toast(t('toast.failed', { error: messageOf(err) }), true)
    } finally {
      setBusy(name, false)
    }
  }

  function mount(): void {
    mounted += 1
    if (mounted === 1) {
      load({ force: true }).catch(function () { })
      pollTimer = setInterval(function () {
        if (document.visibilityState === 'visible') load().catch(function () { })
      }, 60000)
      visibilityHandler = function () {
        if (document.visibilityState === 'visible') load().catch(function () { })
      }
      document.addEventListener('visibilitychange', visibilityHandler)
    }
  }

  function unmount(): void {
    mounted = Math.max(0, mounted - 1)
    if (mounted > 0) return
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityHandler = null
    }
  }

  function dispose(): void {
    disposed = true
    mounted = 0
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityHandler = null
    }
    if (toastTimer) clearTimeout(toastTimer)
    if (flushTimer) clearTimeout(flushTimer)
    if (freshTimer) clearTimeout(freshTimer)
  }

  const api: Controller = {
    get: get,
    subscribe: subscribe,
    reader: reader,
    getList: getList,
    load: load,
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
    setFolderOpen: setFolderOpen,
    setWidths: setWidths,
    addFeed: addFeed,
    removeFeed: removeFeed,
    runAction: runAction,
    mount: mount,
    unmount: unmount,
    dispose: dispose,
    feedTitle: feedTitleOf,
    feedFolder: feedFolderOf,
    groupKey: groupKeyOf,
  }
  return api
}
