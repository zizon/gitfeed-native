/** The reader's single client state machine, shared by every surface. */

import type { Feed, GitInfo, GroupBy, Item, ReaderPrefs, ScheduleJobInfo } from '../shared/types.js'
import { DEFAULT_LIST, DEFAULT_RAIL, LS, PREFIX } from './constants.js'
import type { Translate } from './locales.js'
import { tf } from './locales.js'
import type { ClientState, Controller, Filter, MarkCounts } from './types.js'
import {
  clamp,
  digestText,
  messageOf,
  plainFromHtml,
  readStorage,
  storedBool,
  storedFolders,
  storedNumber,
  writeStorage,
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

export function createController(t: Translate): Controller {
  let state: ClientState = {
    status: 'idle',
    error: null,
    loadError: null,
    loadedOnce: false,
    items: [],
    byId: new Map(),
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
    filter: 'unread',
    query: '',
    feedId: null,
    current: null,
    groupBy: storedGroupBy(),
    hideEmpty: storedBool(LS.hideEmpty),
    markOnScroll: storedBool(LS.markOnScroll),
    showDigest: storedBool(LS.showDigest),
    folderOpen: storedFolders(),
    railW: clamp(storedNumber(LS.railW, DEFAULT_RAIL), 150, 460),
    listW: clamp(storedNumber(LS.listW, DEFAULT_LIST), 260, 760),
    listEpoch: 0,
    busy: {},
    toast: null,
  }

  function storedGroupBy(): GroupBy | null {
    const value = readStorage(LS.groupBy)
    return value === 'folder' || value === 'feed' || value === 'none' ? value : null
  }

  const digestCache = new Map<string, string>()
  const listeners = new Set<() => void>()
  let listCache: { key: string | null; items: Item[] } = { key: null, items: [] }
  let loadPromise: Promise<void> | null = null
  let mounted = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
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
    return state
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return function () { listeners.delete(listener) }
  }

  function set(patch: Partial<ClientState>): void {
    state = Object.assign({}, state, patch)
    for (const listener of listeners) listener()
  }

  function setBusy(key: string, value: boolean): void {
    const busy = Object.assign({}, state.busy)
    if (value) busy[key] = true
    else Reflect.deleteProperty(busy, key)
    set({ busy: busy })
  }

  function toast(text: string, error?: boolean, undo?: boolean): void {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: { text: text, error: !!error, at: Date.now(), undo: !!undo } })
    // An undoable mark stays on screen long enough to be taken back.
    toastTimer = setTimeout(function () {
      toastTimer = null
      set({ toast: null })
    }, error || undo ? 8000 : 3500)
  }

  /** Dismiss the banner early, e.g. once the shared toast has faded out. */
  function dismissToast(): void {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    if (state.toast) set({ toast: null })
  }

  function getList(): Item[] {
    const key = [state.filter, state.query, state.feedId || '', state.version || '', state.listEpoch].join('\u0000')
    if (listCache.key !== key) {
      listCache = { key: key, items: filterItems() }
    }
    return listCache.items
  }

  function filterItems(): Item[] {
    const query = state.query.trim().toLowerCase()
    return state.items.filter(function (item) {
      if (state.filter === 'unread' && state.read.has(item.id) && !stickyRead.has(item.id)) return false
      if (state.filter === 'starred' && !state.starred.has(item.id)) return false
      if (state.feedId && item.feed !== state.feedId) return false
      if (query && searchHay(item).indexOf(query) === -1) return false
      return true
    })
  }

  function searchHay(item: Item): string {
    const key = `${item.id}:${item.summary ? item.summary.length : 0}`
    let text = plainCache.get(key)
    if (text === undefined) {
      text = (`${item.title} ${plainFromHtml(item.summary)} ${feedTitleOf(item.feed)}`).toLowerCase()
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
    const feed = state.feedMap.get(id)
    return feed ? feed.title : id
  }

  function feedFolderOf(id: string): string {
    const feed = state.feedMap.get(id)
    return (feed && feed.folder) || t('feed.uncategorized')
  }

  function groupKeyOf(item: Item): string {
    const groupBy = state.groupBy || state.reader.groupBy || 'none'
    return groupBy === 'feed' ? item.feed : feedFolderOf(item.feed)
  }

  function request(route: string, payload?: unknown): Promise<ApiResponse> {
    return fetch(PREFIX + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      cache: 'no-store',
      credentials: 'same-origin',
    }).then(async function (res) {
      let data: ApiResponse = {}
      try {
        data = (await res.json()) as ApiResponse
      } catch {
        data = {}
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    })
  }

  function load(options?: { force?: boolean }): Promise<void> {
    if (disposed) return Promise.resolve()
    if (loadPromise) return loadPromise
    const force = options?.force === true
    loadPromise = (async function () {
      if (!state.loadedOnce) set({ status: 'loading' })
      const url = `${PREFIX}/state${!force && state.version ? `?version=${encodeURIComponent(state.version)}` : ''}`
      const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
      let data: StateResponse
      try {
        data = (await res.json()) as StateResponse
      } catch {
        throw new Error(`HTTP ${res.status}`)
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      if (data.unchanged) {
        set({
          status: 'ready',
          error: null,
          loadedOnce: true,
          git: data.git || state.git,
          schedule: Array.isArray(data.schedule) ? data.schedule : state.schedule,
          repo: data.repo || state.repo,
          allowGit: data.allowGit !== false,
        })
        return
      }
      if (data.error) {
        set({
          status: 'error',
          error: data.error,
          loadedOnce: true,
          version: data.version || null,
          git: data.git || null,
          schedule: Array.isArray(data.schedule) ? data.schedule : [],
        })
        return
      }
      const items: Item[] = Array.isArray(data.items) ? data.items : []
      const feeds: Feed[] = Array.isArray(data.feeds) ? data.feeds : []
      const byId = new Map<string, Item>(items.map(function (item): [string, Item] { return [item.id, item] }))
      const feedMap = new Map<string, Feed>(feeds.map(function (feed): [string, Feed] { return [feed.id, feed] }))
      plainCache.clear()
      set({
        status: 'ready',
        error: null,
        loadError: null,
        loadedOnce: true,
        items: items,
        byId: byId,
        feeds: feeds,
        feedMap: feedMap,
        read: new Set<string>(Array.isArray(data.read) ? data.read : []),
        starred: new Set<string>(Array.isArray(data.starred) ? data.starred : []),
        reader: data.reader || state.reader,
        git: data.git || null,
        schedule: Array.isArray(data.schedule) ? data.schedule : [],
        version: data.version || null,
        repo: data.repo || state.repo,
        allowGit: data.allowGit !== false,
        current: state.current && byId.has(state.current) ? state.current : null,
        listEpoch: state.listEpoch + 1,
      })
    })().catch(function (err: unknown) {
      const text = messageOf(err)
      if (state.loadedOnce) {
        set({ loadError: text })
        toast(tf(t, 'toast.failed', { error: text }), true)
      } else {
        set({ status: 'error', error: text, loadError: text, loadedOnce: true })
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
      if (last?.version) set({ version: last.version })
      load().catch(function () { })
    }).catch(function (err: unknown) {
      toast(tf(t, 'toast.readFailed', { error: messageOf(err) }), true)
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
    const read = new Set(state.read)
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
    set({ read: read })
    if (!flushTimer) flushTimer = setTimeout(flushMarks, 350)
  }

  /** Forget the rows that were kept only so the current list would stay put. */
  function clearSticky(): void {
    if (stickyRead.size) stickyRead.clear()
  }

  function bumpList() {
    set({ listEpoch: state.listEpoch + 1 })
  }

  function select(id: string | null): void {
    if (!id) {
      set({ current: null })
      return
    }
    if (!state.byId.has(id)) return
    set({ current: id })
    if (!state.read.has(id)) mark([id], true)
  }

  function closeArticle() {
    set({ current: null })
  }

  function selectFeed(id: string | null): void {
    if ((id || null) !== state.feedId) clearSticky()
    set({ feedId: id || null })
  }

  function setFilter(filter: Filter): void {
    if (filter !== state.filter) clearSticky()
    set({ filter: filter })
  }

  function setQuery(query: string): void {
    const next = query || ''
    if (next !== state.query) clearSticky()
    set({ query: next })
  }

  function move(offset: number): void {
    const list = getList()
    if (!list.length) return
    let index = list.findIndex(function (item) { return item.id === state.current })
    if (index === -1) index = offset > 0 ? -1 : list.length
    const next = list.at(clamp(index + offset, 0, list.length - 1))
    if (next) select(next.id)
  }

  function toggleRead(): void {
    const id = state.current
    if (!id) return
    const isRead = state.read.has(id)
    mark([id], !isRead)
    if (isRead) bumpList()
  }

  function toggleStar(): void {
    const id = state.current
    if (!id) return
    const on = !state.starred.has(id)
    const starred = new Set(state.starred)
    if (on) starred.add(id)
    else starred.delete(id)
    set({ starred: starred })
    request('/star', { ids: [id], star: on }).then(function (data) {
      if (data.version) set({ version: data.version })
      load().catch(function () { })
    }).catch(function (err: unknown) {
      const revert = new Set(state.starred)
      if (on) revert.delete(id)
      else revert.add(id)
      set({ starred: revert })
      toast(tf(t, 'toast.failed', { error: messageOf(err) }), true)
    })
  }

  function openCurrent(): void {
    const id = state.current
    const item = id ? state.byId.get(id) : undefined
    if (item && item.link && /^https?:/i.test(item.link)) {
      window.open(item.link, '_blank', 'noopener,noreferrer')
    }
  }

  function escape(): void {
    if (state.current) {
      closeArticle()
      return
    }
    set({ query: '', feedId: null })
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
    toast(tf(t, 'toast.marked', { n: ids.length }), false, true)
  }

  function markAll(): void {
    runScopeMark(getList()
      .filter(function (item) { return !state.read.has(item.id) })
      .map(function (item) { return item.id }))
  }

  function markGroup(key: string): void {
    runScopeMark(getList()
      .filter(function (item) { return groupKeyOf(item) === key && !state.read.has(item.id) })
      .map(function (item) { return item.id }))
  }

  /** Every unread item of one source, whatever the list filter is showing. */
  function markFeed(feedId: string): void {
    runScopeMark(state.items
      .filter(function (item) { return item.feed === feedId && !state.read.has(item.id) })
      .map(function (item) { return item.id }))
  }

  /** Every unread item of one folder, whatever the list filter is showing. */
  function markFolder(folder: string): void {
    runScopeMark(state.items
      .filter(function (item) {
        return !state.read.has(item.id) && feedFolderOf(item.feed) === folder
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
    toast(tf(t, 'toast.unmarked', { n: last.ids.length }))
  }

  /**
   * How many unread items each marking scope would touch. The mark menu shows
   * these numbers before it acts, so a five-figure action never hides behind a
   * button that looks like the small one next to it.
   */
  function markCounts(): MarkCounts {
    let results = 0
    for (const item of getList()) if (!state.read.has(item.id)) results += 1
    const folder = state.feedId ? feedFolderOf(state.feedId) : null
    let source = 0
    let folderCount = 0
    let all = 0
    for (const item of state.items) {
      if (state.read.has(item.id)) continue
      all += 1
      if (state.feedId && item.feed === state.feedId) source += 1
      if (folder && feedFolderOf(item.feed) === folder) folderCount += 1
    }
    return { results: results, source: source, folder: folderCount, all: all, folderName: folder }
  }

  /** Mark every unread item in the reader, whatever the scope on screen is. */
  function markEverything(): void {
    runScopeMark(state.items
      .filter(function (item) { return !state.read.has(item.id) })
      .map(function (item) { return item.id }))
  }

  function setGroupBy(value: string): void {
    const next = value === 'folder' || value === 'feed' ? value : 'none'
    writeStorage(LS.groupBy, next)
    set({ groupBy: next })
  }

  function setHideEmpty(value: boolean): void {
    writeStorage(LS.hideEmpty, value ? '1' : '0')
    set({ hideEmpty: value })
  }

  function setMarkOnScroll(value: boolean): void {
    writeStorage(LS.markOnScroll, value ? '1' : '0')
    set({ markOnScroll: value })
  }

  function setShowDigest(value: boolean): void {
    writeStorage(LS.showDigest, value ? '1' : '0')
    set({ showDigest: value })
  }

  function setFolderOpen(name: string, open: boolean): void {
    const next = Object.assign({}, state.folderOpen)
    next[name] = open
    writeStorage(LS.folders, JSON.stringify(next))
    set({ folderOpen: next })
  }

  function setWidths(patch: { railW?: number; listW?: number }): void {
    const next: { railW?: number; listW?: number } = {}
    if (typeof patch.railW === 'number' && Number.isFinite(patch.railW)) {
      next.railW = clamp(Math.round(patch.railW), 150, 460)
      writeStorage(LS.railW, next.railW)
    }
    if (typeof patch.listW === 'number' && Number.isFinite(patch.listW)) {
      next.listW = clamp(Math.round(patch.listW), 260, 900)
      writeStorage(LS.listW, next.listW)
    }
    if (Object.keys(next).length) set(next)
  }

  async function addFeed(url: string, folder: string): Promise<boolean> {
    if (state.busy.add) return false
    setBusy('add', true)
    try {
      const data = await request('/feeds', { url: url, folder: folder })
      if (data.ok === false) throw new Error(data.error || 'could not add feed')
      toast(tf(t, 'toast.subscribed', { name: (data.feed && (data.feed.title || data.feed.url)) || url }))
      await load({ force: true })
      return true
    } catch (err) {
      toast(tf(t, 'toast.failed', { error: messageOf(err) }), true)
      return false
    } finally {
      setBusy('add', false)
    }
  }

  async function removeFeed(id: string): Promise<boolean> {
    if (!id || state.busy.remove) return false
    setBusy('remove', true)
    try {
      const data = await request('/feeds/remove', { id: id })
      if (data.ok === false) throw new Error(data.error || 'could not remove feed')
      if (state.feedId === id) set({ feedId: null })
      toast(tf(t, 'toast.unsubscribed', { name: feedTitleOf(id) }))
      await load({ force: true })
      return true
    } catch (err) {
      toast(tf(t, 'toast.failed', { error: messageOf(err) }), true)
      return false
    } finally {
      setBusy('remove', false)
    }
  }

  async function runAction(name: string): Promise<void> {
    if (state.busy[name]) return
    setBusy(name, true)
    try {
      const data = await request(`/${name}`, {})
      if (data.ok === false) {
        toast(tf(t, 'toast.failed', { error: data.error || data.output || name }), true)
      } else if (name === 'fetch') {
        toast(tf(t, 'toast.fetch', { summary: data.output || 'ok' }))
      } else if (name === 'pull') {
        toast(tf(t, 'toast.pull'))
      } else if (name === 'sync') {
        toast(tf(t, 'toast.sync'))
      } else {
        toast(`${name}: ok`)
      }
      await load({ force: true })
    } catch (err) {
      toast(tf(t, 'toast.failed', { error: messageOf(err) }), true)
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
    listeners.clear()
  }

  const api: Controller = {
    get: get,
    subscribe: subscribe,
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
