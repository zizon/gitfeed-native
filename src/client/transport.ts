/**
 * The reader's data half: every request the Client makes to its own Host, plus
 * the poll, flush, and fade timers that drive them. It owns no published state —
 * it reads and writes the controller's two halves through {@link TransportPorts}.
 */

import type { Feed, GitInfo, Item, ReaderPrefs, ScheduleJobInfo } from '../shared/types.js'
import { PREFIX } from './constants.js'
import type { Translate } from './locales.js'
import type { ReaderData, ReaderUi } from './types.js'
import { messageOf } from '../shared/errors.js'

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

/** What the transport needs from the controller that owns the published state. */
export interface TransportPorts {
  /** The two halves as published right now. */
  read(): { data: ReaderData; ui: ReaderUi }
  setData(patch: Partial<ReaderData>): void
  setUi(patch: Partial<ReaderUi>): void
  /** Publish both halves in one step, for a load that also moves the view. */
  commit(data: Partial<ReaderData>, ui: Partial<ReaderUi>): void
  setBusy(key: string, value: boolean): void
  toast(text: string, error?: boolean, undo?: boolean): void
  /** The name a source is shown by, for the toast that names it. */
  titleOf(feedId: string): string
  /** Drop the row text a new item model invalidates. */
  resetText(): void
  t: Translate
}

export interface Transport {
  load: (options?: { force?: boolean }) => Promise<void>
  mark: (ids: string[], value: boolean, shown: ReadonlySet<string> | null) => void
  star: (id: string, on: boolean) => Promise<void>
  addFeed: (url: string, folder: string) => Promise<boolean>
  removeFeed: (id: string) => Promise<boolean>
  runAction: (name: string) => Promise<void>
  mount: () => void
  unmount: () => void
  dispose: () => void
  clearSticky: () => void
  /** Let go of rows a finished section no longer needs kept. */
  release: (ids: readonly string[]) => boolean
  /** Rows kept on screen only so the list stays put; the view reads this. */
  readonly sticky: ReadonlySet<string>
}

/**
 * Open the transport over one published state.
 * @param ports - reads, writes, and the two copy helpers the transport borrows.
 * @returns the request and timer surface the controller drives.
 */
export function createTransport(ports: TransportPorts): Transport {
  const t = ports.t
  const data = function () { return ports.read().data }
  const ui = function () { return ports.read().ui }

  const pendingRead = new Set<string>()
  const pendingUnread = new Set<string>()
  /**
   * Read rows that stay in the Unread list until the scope changes. A row the
   * reader scrolled past or opened must not vanish from under the pointer,
   * which is what made the list jump on every mark.
   */
  const stickyRead = new Set<string>()

  let loadPromise: Promise<void> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let freshTimer: ReturnType<typeof setTimeout> | null = null
  let visibilityHandler: (() => void) | null = null
  let mounted = 0
  let disposed = false

  function request(route: string, body?: unknown): Promise<ApiResponse> {
    return fetch(PREFIX + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
      credentials: 'same-origin',
    }).then(async function (res) {
      let payload: ApiResponse = {}
      try {
        payload = (await res.json()) as ApiResponse
      } catch {
        payload = {}
      }
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`)
      return payload
    })
  }

  function load(options?: { force?: boolean }): Promise<void> {
    if (disposed) return Promise.resolve()
    if (loadPromise) return loadPromise
    const force = options?.force === true
    loadPromise = (async function () {
      const before = data()
      if (!before.loadedOnce) ports.setData({ status: 'loading' })
      const params: string[] = []
      if (!force && before.version) params.push(`version=${encodeURIComponent(before.version)}`)
      if (before.itemsVersion) params.push(`itemsVersion=${encodeURIComponent(before.itemsVersion)}`)
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
        ports.setData({
          status: 'ready',
          error: null,
          loadedOnce: true,
          git: payload.git || data().git,
          schedule: Array.isArray(payload.schedule) ? payload.schedule : data().schedule,
          repo: payload.repo || data().repo,
          allowGit: payload.allowGit !== false,
        })
        return
      }
      if (payload.error) {
        ports.setData({
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
      if (!replaceItems && payload.itemsVersion !== data().itemsVersion) {
        setTimeout(function () { load({ force: true }).catch(function () { }) }, 0)
        return
      }
      const items = replaceItems ? (payload.items as Item[]) : data().items
      const byId = replaceItems
        ? new Map<string, Item>(items.map(function (item): [string, Item] { return [item.id, item] }))
        : data().byId
      // Rows that landed while the reader was already open: the list fades
      // them in instead of reflowing the page under the pointer.
      const fresh = new Set<string>()
      if (replaceItems && data().loadedOnce) {
        for (const item of items) if (!data().byId.has(item.id)) fresh.add(item.id)
      }
      const read = new Set<string>(Array.isArray(payload.read) ? payload.read : data().read)
      const starred = new Set<string>(Array.isArray(payload.starred) ? payload.starred : data().starred)
      const feeds: Feed[] = Array.isArray(payload.feeds) ? payload.feeds : data().feeds
      const feedMap = new Map<string, Feed>(feeds.map(function (feed): [string, Feed] { return [feed.id, feed] }))
      if (replaceItems) ports.resetText()
      const current = ui().current
      ports.commit({
        status: 'ready',
        error: null,
        loadError: null,
        loadedOnce: true,
        items: items,
        byId: byId,
        itemsVersion: payload.itemsVersion || data().itemsVersion,
        fresh: fresh,
        feeds: feeds,
        feedMap: feedMap,
        read: read,
        starred: starred,
        reader: payload.reader || data().reader,
        git: payload.git || null,
        schedule: Array.isArray(payload.schedule) ? payload.schedule : [],
        version: payload.version || null,
        repo: payload.repo || data().repo,
        allowGit: payload.allowGit !== false,
      }, {
        current: current && byId.has(current) ? current : null,
        listEpoch: replaceItems || !sameSet(data().read, read) || !sameSet(data().starred, starred)
          ? ui().listEpoch + 1
          : ui().listEpoch,
      })
      if (fresh.size) {
        if (freshTimer) clearTimeout(freshTimer)
        freshTimer = setTimeout(function () {
          freshTimer = null
          if (data().fresh.size) ports.setData({ fresh: new Set() })
        }, 1600)
      }
    })().catch(function (err: unknown) {
      const text = messageOf(err)
      if (data().loadedOnce) {
        ports.setData({ loadError: text })
        ports.toast(t('toast.failed', { error: text }), true)
      } else {
        ports.setData({ status: 'error', error: text, loadError: text, loadedOnce: true })
      }
    }).finally(function () {
      loadPromise = null
    })
    return loadPromise
  }

  function flushMarks(): void {
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
      if (last?.version) ports.setData({ version: last.version })
      load().catch(function () { })
    }).catch(function (err: unknown) {
      ports.toast(t('toast.readFailed', { error: messageOf(err) }), true)
      load({ force: true }).catch(function () { })
    })
  }

  /**
   * Apply one mark locally and queue it for the Host.
   * @param ids item ids, already validated by the caller.
   * @param value target state.
   * @param shown the rows on screen when an implicit mark keeps them; null when
   * the mark should drop them.
   */
  function mark(ids: string[], value: boolean, shown: ReadonlySet<string> | null): void {
    const read = new Set(data().read)
    for (const id of ids) {
      if (value) read.add(id)
      else read.delete(id)
      if (value) {
        pendingRead.add(id)
        pendingUnread.delete(id)
        if (shown) {
          if (shown.has(id)) stickyRead.add(id)
        } else {
          stickyRead.delete(id)
        }
      } else {
        pendingUnread.add(id)
        pendingRead.delete(id)
        stickyRead.delete(id)
      }
    }
    ports.setData({ read: read })
    if (!flushTimer) flushTimer = setTimeout(flushMarks, 350)
  }

  function star(id: string, on: boolean): Promise<void> {
    return request('/star', { ids: [id], star: on }).then(function (payload) {
      if (payload.version) ports.setData({ version: payload.version })
      return load().catch(function () { })
    })
  }

  async function addFeed(url: string, folder: string): Promise<boolean> {
    if (ui().busy.add) return false
    ports.setBusy('add', true)
    try {
      const payload = await request('/feeds', { url: url, folder: folder })
      if (payload.ok === false) throw new Error(payload.error || 'could not add feed')
      ports.toast(t('toast.subscribed', { name: (payload.feed && (payload.feed.title || payload.feed.url)) || url }))
      await load({ force: true })
      return true
    } catch (err) {
      ports.toast(t('toast.failed', { error: messageOf(err) }), true)
      return false
    } finally {
      ports.setBusy('add', false)
    }
  }

  async function removeFeed(id: string): Promise<boolean> {
    if (!id || ui().busy.remove) return false
    ports.setBusy('remove', true)
    try {
      const payload = await request('/feeds/remove', { id: id })
      if (payload.ok === false) throw new Error(payload.error || 'could not remove feed')
      if (ui().feedId === id) ports.setUi({ feedId: null })
      ports.toast(t('toast.unsubscribed', { name: ports.titleOf(id) }))
      await load({ force: true })
      return true
    } catch (err) {
      ports.toast(t('toast.failed', { error: messageOf(err) }), true)
      return false
    } finally {
      ports.setBusy('remove', false)
    }
  }

  async function runAction(name: string): Promise<void> {
    if (ui().busy[name]) return
    ports.setBusy(name, true)
    try {
      const payload = await request(`/${name}`, {})
      if (payload.ok === false) {
        ports.toast(t('toast.failed', { error: payload.error || payload.output || name }), true)
      } else if (name === 'fetch') {
        ports.toast(t('toast.fetch', { summary: payload.output || 'ok' }))
      } else if (name === 'pull') {
        ports.toast(t('toast.pull'))
      } else if (name === 'sync') {
        ports.toast(t('toast.sync'))
      } else {
        ports.toast(`${name}: ok`)
      }
      await load({ force: true })
    } catch (err) {
      ports.toast(t('toast.failed', { error: messageOf(err) }), true)
    } finally {
      ports.setBusy(name, false)
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
    // Marks queued a moment ago were already applied optimistically; dropping
    // them here would silently unmark what the reader just read (the next load
    // would bring the old state back).
    if (flushTimer) flushMarks()
    mounted = 0
    unmount()
    if (flushTimer) clearTimeout(flushTimer)
    if (freshTimer) clearTimeout(freshTimer)
    flushTimer = null
    freshTimer = null
  }

  return {
    load: load,
    mark: mark,
    star: star,
    addFeed: addFeed,
    removeFeed: removeFeed,
    runAction: runAction,
    mount: mount,
    unmount: unmount,
    dispose: dispose,
    clearSticky: function () { if (stickyRead.size) stickyRead.clear() },
    release: function (ids: readonly string[]): boolean {
      let changed = false
      for (const id of ids) if (stickyRead.delete(id)) changed = true
      return changed
    },
    get sticky() { return stickyRead },
  }
}
