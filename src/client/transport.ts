/**
 * The reader's data half: every request the Client makes to its own Host, plus
 * the poll, flush, and fade timers that drive them. It owns no published state —
 * it reads and writes the controller's two halves through {@link TransportPorts}.
 */

import type { Feed, GitInfo, Item, ReaderPrefs, ScheduleJobInfo } from '../shared/types.js'
import { mergeItems, PROTOCOL, STREAM_PATH } from '../shared/stream.js'
import type { StreamDelta, StreamWelcome } from '../shared/stream.js'
import { PREFIX } from './constants.js'
import type { Translate } from './locales.js'
import type { ReaderData, ReaderUi } from './types.js'
import { messageOf } from '../shared/errors.js'

interface ApiFeed {
  title?: string
  url?: string
  folder?: string
}

interface ApiResponse {
  ok?: boolean
  error?: string
  output?: string
  version?: string
  feed?: ApiFeed
  /** Ids one query matched, in archive order. */
  ids?: string[]
}

/** Failed stream attempts before the HTTP path takes over for a while. */
const STREAM_ATTEMPTS = 3
/** How long a given-up stream waits before trying the Host again. */
const STREAM_RETRY_MS = 60000

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
  /** Whether the list is scrolled into the archive rather than sitting at its top. */
  scrolled(): boolean
  /**
   * The item model moved: a text filter the Host answered may be stale, and the
   * surface's query is the Host's to answer.
   */
  refilter(): void
  /** Drop the row text a new item model invalidates. */
  resetText(): void
  t: Translate
}

export interface Transport {
  /** Replace the stream: the only way the reader gets state again. */
  reconnect: () => void
  /**
   * Mark rows, optimistically and in the next flush.
   * @returns settled when the Host has the flush; rejected when it did not.
   */
  mark: (ids: string[], value: boolean, shown: ReadonlySet<string> | null) => Promise<void>
  star: (id: string, on: boolean) => Promise<void>
  addFeed: (url: string, folder: string) => Promise<boolean>
  removeFeed: (id: string) => Promise<boolean>
  setFeedFolder: (id: string, folder: string) => Promise<boolean>
  runAction: (name: string) => Promise<void>
  /**
   * Ask the Host which rows match a query; empty when the query is blank.
   * @param query - what the reader typed.
   * @param signal - cancels a query the reader has already replaced.
   */
  search: (query: string, signal?: AbortSignal) => Promise<string[]>
  mount: () => void
  unmount: () => void
  dispose: () => void
  clearSticky: () => void
  /** Let go of rows a finished section no longer needs kept. */
  release: (ids: readonly string[]) => boolean
  /** Rows kept on screen only so the list stays put; the view reads this. */
  readonly sticky: ReadonlySet<string>
  /** Arrivals held back until the reader leaves the position they would move. */
  readonly held: ReadonlySet<string>
  /**
   * Let those arrivals land. Answers whether anything was being held, so the
   * caller rebuilds the list only when the release actually adds rows.
   */
  releaseHeld: () => boolean
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
  /**
   * Rows a refresh brought in while the reader was scrolled into the archive.
   * A row that lands between the top edge and the rows under it pushes
   * everything below it down; the fade that softens that only makes it blink.
   * They wait here instead, and land when the reader leaves the position they
   * would have moved — the top of the list, or another scope.
   */
  const heldArrivals = new Set<string>()

  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let freshTimer: ReturnType<typeof setTimeout> | null = null
  /** Mark promises waiting for the next flush to tell them what happened. */
  let markWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
  let visibilityHandler: (() => void) | null = null
  let mounted = 0
  let disposed = false
  /**
   * The revision this surface holds, and the stream that keeps it current.
   * `lastRev` is what a reconnecting stream asks from; it is not published,
   * because a scroll or a mark must not republish the snapshot for it.
   */
  let lastRev = 0
  let stream: EventSource | null = null
  let streaming = false
  /** Failed attempts to open the stream; a Host that has none falls back for good. */
  let streamAttempts = 0
  let streamRetry: ReturnType<typeof setTimeout> | null = null

  function request(route: string, body?: unknown, signal?: AbortSignal): Promise<ApiResponse> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
      credentials: 'same-origin',
    }
    if (signal) init.signal = signal
    return fetch(PREFIX + route, init).then(async function (res) {
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

  /** Stop calling a row new once the fade that introduced it is done. */
  function armFresh(): void {
    if (freshTimer) clearTimeout(freshTimer)
    freshTimer = setTimeout(function () {
      freshTimer = null
      if (data().fresh.size) ports.setData({ fresh: new Set() })
    }, 1600)
  }

  /**
   * Publish one complete item model with the facts that came with it. Both the
   * HTTP load and the stream's first frame end here, so a surface cannot tell
   * which of them delivered its rows.
   * @param items - the rows of the model.
   * @param payload - the marks and facts sent beside them.
   */
  function commitModel(
    items: Item[],
    payload: {
      read?: string[]
      starred?: string[]
      feeds?: Feed[]
      reader?: ReaderPrefs
      git?: GitInfo | null
      schedule?: ScheduleJobInfo[]
      version?: string | null
      itemsVersion?: string | null
      repo?: string
      allowGit?: boolean
    },
  ): void {
    const before = data()
    const byId = new Map<string, Item>(items.map(function (item): [string, Item] { return [item.id, item] }))
    const fresh = new Set<string>()
    if (before.loadedOnce) {
      for (const item of items) if (!before.byId.has(item.id)) fresh.add(item.id)
    }
    // A refresh that lands rows under the reader's eye moves the rows below
    // them, and the fade meant to soften that reads as a blink: the count
    // moves, the rows do not.
    if (fresh.size && ports.scrolled()) {
      for (const id of fresh) heldArrivals.add(id)
    }
    const read = new Set<string>(Array.isArray(payload.read) ? payload.read : before.read)
    const starred = new Set<string>(Array.isArray(payload.starred) ? payload.starred : before.starred)
    const feeds: Feed[] = Array.isArray(payload.feeds) ? payload.feeds : before.feeds
    const feedMap = new Map<string, Feed>(feeds.map(function (feed): [string, Feed] { return [feed.id, feed] }))
    ports.resetText()
    const current = ui().current
    ports.commit({
      status: 'ready',
      error: null,
      loadError: null,
      loadedOnce: true,
      items: items,
      byId: byId,
      itemsVersion: payload.itemsVersion || before.itemsVersion,
      fresh: fresh,
      feeds: feeds,
      feedMap: feedMap,
      read: read,
      starred: starred,
      reader: payload.reader || before.reader,
      git: payload.git === undefined ? before.git : payload.git,
      schedule: Array.isArray(payload.schedule) ? payload.schedule : before.schedule,
      version: payload.version || before.version,
      repo: payload.repo || before.repo,
      allowGit: payload.allowGit !== false,
    }, {
      current: current && byId.has(current) ? current : null,
      listEpoch: ui().listEpoch + 1,
    })
    if (fresh.size) armFresh()
    // A fuller model can match a text filter the Host answered a moment ago.
    ports.refilter()
  }

  /**
   * Ask the Host which rows match a query. The body text is the Host's to
   * search: it holds it whole, and the reader holds the list's half of it.
   * @param query - what the reader typed.
   * @returns the matching ids, in archive order.
   */
  function search(query: string, signal?: AbortSignal): Promise<string[]> {
    if (!query.trim()) return Promise.resolve([])
    return request('/search', { query: query }, signal).then(function (payload) {
      return Array.isArray(payload.ids) ? payload.ids : []
    })
  }

  /**
   * Apply the whole state the stream sends a surface that holds no revision it
   * can extend, or whose revision the Host no longer has.
   */
  function applyWelcome(frame: StreamWelcome): void {
    if (frame.protocol !== PROTOCOL) {
      // A protocol this bundle does not speak: this Host is another build.
      // Stop guessing at its frames and let the retry loop find one that
      // matches, rather than rendering a frame shape that may have changed.
      streaming = false
      closeStream()
      streamFailed(t('status.offline'))
      retryStream(STREAM_RETRY_MS)
      return
    }
    lastRev = frame.rev
    commitModel(frame.items, frame)
  }

  /** Apply what changed since the revision this surface holds. */
  function applyDelta(frame: StreamDelta): void {
    if (frame.rev <= lastRev) return
    lastRev = frame.rev
    const before = data()
    const patch: Partial<ReaderData> = {
      status: 'ready',
      error: null,
      loadError: null,
      loadedOnce: true,
      itemsVersion: frame.itemsVersion || before.itemsVersion,
      version: frame.version || before.version,
    }
    let epoch = false
    const fresh = new Set<string>()
    if (frame.items) {
      const items = mergeItems(before.items, frame.items)
      const byId = new Map<string, Item>(before.byId)
      for (const item of frame.items.updated) byId.set(item.id, item)
      for (const item of frame.items.added) byId.set(item.id, item)
      for (const id of frame.items.removed) {
        byId.delete(id)
        heldArrivals.delete(id)
        stickyRead.delete(id)
      }
      if (before.loadedOnce) {
        for (const item of frame.items.added) if (!before.byId.has(item.id)) fresh.add(item.id)
      }
      if (fresh.size && ports.scrolled()) {
        for (const id of fresh) heldArrivals.add(id)
      }
      for (const id of heldArrivals) fresh.delete(id)
      patch.items = items
      patch.byId = byId
      epoch = true
    }
    if (frame.read) {
      const read = new Set(before.read)
      let moved = false
      for (const id of frame.read.add) {
        if (read.has(id)) continue
        read.add(id)
        moved = true
      }
      for (const id of frame.read.remove) if (read.delete(id)) moved = true
      if (moved) {
        patch.read = read
        epoch = true
      }
    }
    if (frame.starred) {
      const starred = new Set(before.starred)
      let moved = false
      for (const id of frame.starred.add) {
        if (starred.has(id)) continue
        starred.add(id)
        moved = true
      }
      for (const id of frame.starred.remove) if (starred.delete(id)) moved = true
      if (moved) {
        patch.starred = starred
        epoch = true
      }
    }
    if (frame.feeds) {
      patch.feeds = frame.feeds
      patch.feedMap = new Map<string, Feed>(frame.feeds.map(function (feed): [string, Feed] { return [feed.id, feed] }))
      epoch = true
    }
    if (frame.reader) {
      patch.reader = frame.reader
      epoch = true
    }
    if (frame.git !== undefined) patch.git = frame.git
    if (frame.schedule) patch.schedule = frame.schedule
    if (frame.repo) patch.repo = frame.repo
    if (frame.allowGit !== undefined) patch.allowGit = frame.allowGit
    if (fresh.size) {
      const fading = new Set(before.fresh)
      for (const id of fresh) fading.add(id)
      patch.fresh = fading
    }
    const current = ui().current
    const rows = patch.byId || before.byId
    ports.commit(patch, {
      current: current && rows.has(current) ? current : null,
      listEpoch: epoch ? ui().listEpoch + 1 : ui().listEpoch,
    })
    if (fresh.size) armFresh()
    // The rows moved under an active text filter: the Host answers that query,
    // and its old answer may no longer describe this model.
    if (frame.items) ports.refilter()
  }

  function closeStream(): void {
    streaming = false
    if (streamRetry) {
      clearTimeout(streamRetry)
      streamRetry = null
    }
    if (!stream) return
    const source = stream
    stream = null
    source.close()
  }

  /**
   * Try the stream again later, after it could not be opened. A Host that was
   * restarted mid-session starts serving it again; a Host that never will costs
   * one attempt a minute.
   */
  function retryStream(delayMs: number): void {
    if (disposed || streamRetry) return
    streamRetry = setTimeout(function () {
      streamRetry = null
      if (!disposed && mounted > 0) openStream()
    }, delayMs)
  }

  /**
   * The stream could not carry the state. With no second path, the reader says
   * what is wrong where it can be seen: on the empty pane before the first
   * frame, as a banner after it.
   * @param message - why; the generic "not connected" text when empty.
   */
  function streamFailed(message: string): void {
    streaming = false
    const text = message || t('status.offline')
    if (data().loadedOnce) ports.toast(text, true)
    else ports.setData({ status: 'error', error: text })
  }

  /**
   * Replace the stream. The reader has no state request to make, so getting its
   * state again means reconnecting; a surface that is already streaming can use
   * it to ask for a fresh whole state (the Retry button after a Host restart).
   */
  function reconnect(): void {
    if (disposed) return
    closeStream()
    openStream()
  }

  /**
   * Open the surface's stream. This is the only path: the Host sends the whole
   * state once and then only what changed, and a page whose client bundle is
   * newer than the running Host says so instead of showing an empty list.
   */
  function openStream(): void {
    closeStream()
    streamAttempts = 0
    if (!data().loadedOnce && data().status !== 'error') ports.setData({ status: 'loading' })
    if (disposed) return
    if (typeof EventSource === 'undefined') {
      streamFailed(t('status.offline'))
      return
    }
    const source = new EventSource(`${STREAM_PATH}?rev=${lastRev}`)
    stream = source
    source.addEventListener('open', function () {
      if (stream !== source) return
      streamAttempts = 0
      streaming = true
    })
    source.addEventListener('welcome', function (event: Event) {
      if (stream !== source) return
      applyWelcome(JSON.parse(String((event as MessageEvent).data)) as StreamWelcome)
    })
    source.addEventListener('delta', function (event: Event) {
      if (stream !== source) return
      applyDelta(JSON.parse(String((event as MessageEvent).data)) as StreamDelta)
    })
    source.addEventListener('error', function (event: Event) {
      if (stream !== source) return
      const text: unknown = (event as MessageEvent).data
      if (typeof text === 'string' && text) {
        streamFailed(text)
        return
      }
      // A transport failure. The browser's own retry gets a few chances, then
      // the stream is given up for a while: a Host that has not been restarted
      // has no such route, and hammering it every few seconds helps nobody.
      streaming = false
      streamAttempts += 1
      if (streamAttempts >= STREAM_ATTEMPTS) {
        streamAttempts = 0
        closeStream()
        streamFailed(t('status.offline'))
        retryStream(STREAM_RETRY_MS)
      }
    })
  }

  /**
   * Reload after an act the reader asked for. Rows a refresh was holding land
   * with it: the reader moved the list, so the rows may move now too.
   */
  function showAll(): Promise<void> {
    heldArrivals.clear()
    // The Host announces what the action changed; there is nothing to ask for.
    return Promise.resolve()
  }

  function flushMarks(): void {
    flushTimer = null
    const readIds = Array.from(pendingRead)
    const unreadIds = Array.from(pendingUnread)
    pendingRead.clear()
    pendingUnread.clear()
    // Every mark queued since the last flush settles with it: one write is one
    // answer, and the caller's promise means "the Host has this".
    const waiting = markWaiters
    markWaiters = []
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
      ports.toast(t('toast.readFailed', { error: messageOf(err) }), true)
      reconnect()
    })
  }

  /**
   * Apply one mark locally and queue it for the Host.
   * @param ids item ids, already validated by the caller.
   * @param value target state.
   * @param shown the rows on screen when an implicit mark keeps them; null when
   * the mark should drop them.
   */
  function mark(ids: string[], value: boolean, shown: ReadonlySet<string> | null): Promise<void> {
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
    return new Promise(function (resolve, reject) {
      markWaiters.push({ resolve: resolve, reject: reject })
    })
  }

  function star(id: string, on: boolean): Promise<void> {
    // The load that follows is what settles the version: the answer to the
    // star names the root, not the state this reader is holding.
    return request('/star', { ids: [id], star: on }).then(function () { })
  }

  async function addFeed(url: string, folder: string): Promise<boolean> {
    if (ui().busy.add) return false
    ports.setBusy('add', true)
    try {
      const payload = await request('/feeds', { url: url, folder: folder })
      if (payload.ok === false) throw new Error(payload.error || 'could not add feed')
      ports.toast(t('toast.subscribed', { name: (payload.feed && (payload.feed.title || payload.feed.url)) || url }))
      await showAll()
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
      await showAll()
      return true
    } catch (err) {
      ports.toast(t('toast.failed', { error: messageOf(err) }), true)
      return false
    } finally {
      ports.setBusy('remove', false)
    }
  }

  /**
   * Move one subscription to another folder and reload the list of sources.
   * @param id feed id.
   * @param folder folder to move it to; an empty name means Uncategorized.
   * @returns whether the move was accepted.
   */
  async function setFeedFolder(id: string, folder: string): Promise<boolean> {
    if (!id || ui().busy.folder) return false
    ports.setBusy('folder', true)
    try {
      const payload = await request('/feeds/folder', { id: id, folder: folder })
      if (payload.ok === false) throw new Error(payload.error || 'could not move feed')
      const name = (payload.feed && payload.feed.folder) || t('feed.uncategorized')
      ports.toast(t('toast.moved', { name: ports.titleOf(id), folder: name }))
      await showAll()
      return true
    } catch (err) {
      ports.toast(t('toast.failed', { error: messageOf(err) }), true)
      return false
    } finally {
      ports.setBusy('folder', false)
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
      await showAll()
    } catch (err) {
      ports.toast(t('toast.failed', { error: messageOf(err) }), true)
    } finally {
      ports.setBusy(name, false)
    }
  }

  function mount(): void {
    mounted += 1
    if (mounted > 1) return
    openStream()
    // A tab that was away may come back to a stream the browser dropped.
    visibilityHandler = function () {
      if (document.visibilityState !== 'visible') return
      if (streaming) return
      openStream()
    }
    document.addEventListener('visibilitychange', visibilityHandler)
  }

  function unmount(): void {
    mounted = Math.max(0, mounted - 1)
    if (mounted > 0) return
    closeStream()
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
    closeStream()
    mounted = 0
    unmount()
    if (flushTimer) clearTimeout(flushTimer)
    if (freshTimer) clearTimeout(freshTimer)
    if (streamRetry) clearTimeout(streamRetry)
    flushTimer = null
    freshTimer = null
    streamRetry = null
  }

  return {
    reconnect: reconnect,
    search: search,
    mark: mark,
    star: star,
    addFeed: addFeed,
    removeFeed: removeFeed,
    setFeedFolder: setFeedFolder,
    runAction: runAction,
    mount: mount,
    unmount: unmount,
    dispose: dispose,
    clearSticky: function () { if (stickyRead.size) stickyRead.clear() },
    releaseHeld: function (): boolean {
      if (!heldArrivals.size) return false
      heldArrivals.clear()
      return true
    },
    release: function (ids: readonly string[]): boolean {
      let changed = false
      for (const id of ids) if (stickyRead.delete(id)) changed = true
      return changed
    },
    get sticky() { return stickyRead },
    get held() { return heldArrivals },
  }
}
