/** The live stream: the frames, the retry loop, and the reconnect. */

import type { Feed, GitInfo, Item, ReaderPrefs, ScheduleJobInfo } from '../shared/types.js'
import { mergeItems, PROTOCOL, STREAM_PATH } from '../shared/stream.js'
import type { StreamDelta, StreamWelcome } from '../shared/stream.js'
import type { ReaderData } from './types.js'
import { STREAM_ATTEMPTS, STREAM_RETRY_MS, armFresh, dataOf, uiOf } from './transport-core.js'
import type { TransportRecord } from './transport-core.js'

/**
   * Publish one complete item model with the facts that came with it. Both the
   * HTTP load and the rec.stream's first frame end here, so a surface cannot tell
   * which of them delivered its rows.
   * @param items - the rows of the model.
   * @param payload - the marks and facts sent beside them.
   */
function commitModel(rec: TransportRecord,
  items: Item[],
  payload: {
    read?: string[]
    starred?: string[]
    feeds?: Feed[]
    reader?: ReaderPrefs
    /** Attention scores from the Host; absent from a Host before the log. */
    interest?: Record<string, number>
    git?: GitInfo | null
    schedule?: ScheduleJobInfo[]
    version?: string | null
    itemsVersion?: string | null
    repo?: string
    allowGit?: boolean
  },
): void {
  const before = dataOf(rec)
  const byId = new Map<string, Item>(items.map(function (item): [string, Item] { return [item.id, item] }))
  const fresh = new Set<string>()
  if (before.loadedOnce) {
    for (const item of items) if (!before.byId.has(item.id)) fresh.add(item.id)
  }
  // A refresh that lands rows under the reader's eye moves the rows below
  // them, and the fade meant to soften that reads as a blink: the count
  // moves, the rows do not.
  if (fresh.size && !rec.firstFrame && rec.ports.hold()) {
    for (const id of fresh) rec.heldArrivals.add(id)
  }
  rec.firstFrame = false
  // A full state can drop rows a held set or a retained row still names.
  for (const id of rec.heldArrivals) {
    if (!byId.has(id)) rec.heldArrivals.delete(id)
    else fresh.delete(id)
  }
  for (const id of rec.stickyRead) if (!byId.has(id)) rec.stickyRead.delete(id)
  const read = new Set<string>(Array.isArray(payload.read) ? payload.read : before.read)
  const starred = new Set<string>(Array.isArray(payload.starred) ? payload.starred : before.starred)
  const feeds: Feed[] = Array.isArray(payload.feeds) ? payload.feeds : before.feeds
  const feedMap = new Map<string, Feed>(feeds.map(function (feed): [string, Feed] { return [feed.id, feed] }))
  rec.ports.resetText()
  const current = uiOf(rec).current
  rec.ports.commit({
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
    ranks: payload.interest ? new Map(Object.entries(payload.interest)) : before.ranks,
    reader: payload.reader || before.reader,
    git: payload.git === undefined ? before.git : payload.git,
    schedule: Array.isArray(payload.schedule) ? payload.schedule : before.schedule,
    version: payload.version || before.version,
    repo: payload.repo || before.repo,
    allowGit: payload.allowGit !== false,
  }, {
    current: current && byId.has(current) ? current : null,
    listEpoch: uiOf(rec).listEpoch + 1,
  })
  if (fresh.size) armFresh(rec)
  // A fuller model can match a text filter the Host answered a moment ago.
  rec.ports.refilter()
  // The article that is open was replaced by a digest: read its body again.
  const open = uiOf(rec).current
  if (open && dataOf(rec).byId.get(open)?.bodyChars) rec.ports.refetchBody(open)
}

/**
   * Apply the whole state the rec.stream sends a surface that holds no revision it
   * can extend, or whose revision the Host no longer has.
   */
function applyWelcome(rec: TransportRecord, frame: StreamWelcome): void {
  if (frame.protocol !== PROTOCOL) {
    // A protocol this bundle does not speak: this Host is another build.
    // Stop guessing at its frames and let the retry loop find one that
    // matches, rather than rendering a frame shape that may have changed.
    rec.streaming = false
    closeStream(rec)
    streamFailed(rec, rec.t('status.offline'))
    retryStream(rec, STREAM_RETRY_MS)
    return
  }
  rec.lastRev = frame.rev
  commitModel(rec, frame.items, frame)
}

/** Apply what changed since the revision this surface holds. */
/** The item side of one delta: its rows, the id map, and the arrivals it brought. */
function itemsOfDelta(
  rec: TransportRecord, before: ReaderData, frame: StreamDelta,
): { items: Item[]; byId: Map<string, Item>; fresh: Set<string> } | null {
  if (!frame.items) return null
  const items = mergeItems(before.items, frame.items)
  const byId = new Map<string, Item>(before.byId)
  for (const item of frame.items.updated) byId.set(item.id, item)
  for (const item of frame.items.added) byId.set(item.id, item)
  for (const id of frame.items.removed) {
    byId.delete(id)
    rec.heldArrivals.delete(id)
    rec.stickyRead.delete(id)
  }
  const fresh = new Set<string>()
  if (before.loadedOnce) {
    for (const item of frame.items.added) if (!before.byId.has(item.id)) fresh.add(item.id)
  }
  if (fresh.size && !rec.firstFrame && rec.ports.hold()) {
    for (const id of fresh) rec.heldArrivals.add(id)
  }
  for (const id of rec.heldArrivals) fresh.delete(id)
  return { items: items, byId: byId, fresh: fresh }
}

/** The read and starred side of one delta: only the sets that moved. */
function marksOfDelta(before: ReaderData, frame: StreamDelta): { read?: Set<string>; starred?: Set<string> } {
  const out: { read?: Set<string>; starred?: Set<string> } = {}
  if (frame.read) {
    const read = new Set(before.read)
    let moved = false
    for (const id of frame.read.add) {
      if (read.has(id)) continue
      read.add(id)
      moved = true
    }
    for (const id of frame.read.remove) if (read.delete(id)) moved = true
    if (moved) out.read = read
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
    if (moved) out.starred = starred
  }
  return out
}

function applyDelta(rec: TransportRecord, frame: StreamDelta): void {
  if (frame.rev <= rec.lastRev) return
  rec.lastRev = frame.rev
  const before = dataOf(rec)
  const patch: Partial<ReaderData> = {
    status: 'ready',
    error: null,
    loadError: null,
    loadedOnce: true,
    itemsVersion: frame.itemsVersion || before.itemsVersion,
    version: frame.version || before.version,
  }
  let epoch = false
  const rows = itemsOfDelta(rec, before, frame)
  const fresh = rows ? rows.fresh : new Set<string>()
  if (rows) {
    patch.items = rows.items
    patch.byId = rows.byId
    epoch = true
  }
  const marks = marksOfDelta(before, frame)
  if (marks.read) {
    patch.read = marks.read
    epoch = true
  }
  if (marks.starred) {
    patch.starred = marks.starred
    epoch = true
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
  const current = uiOf(rec).current
  const liveRows = patch.byId || before.byId
  rec.ports.commit(patch, {
    current: current && liveRows.has(current) ? current : null,
    listEpoch: epoch ? uiOf(rec).listEpoch + 1 : uiOf(rec).listEpoch,
  })
  rec.firstFrame = false
  if (fresh.size) armFresh(rec)
  if (frame.items) {
    // The rows moved under an active text filter: the Host answers that query,
    // and its old answer may no longer describe this model.
    rec.ports.refilter()
    // The open article's row arrived as a digest again; read its body once more
    // rather than leaving the reader with the first 400 characters.
    const open = uiOf(rec).current
    if (open && dataOf(rec).byId.get(open)?.bodyChars) rec.ports.refetchBody(open)
  }
}

export function closeStream(rec: TransportRecord): void {
  rec.streaming = false
  if (rec.streamRetry) {
    clearTimeout(rec.streamRetry)
    rec.streamRetry = null
  }
  if (!rec.stream) return
  const source = rec.stream
  rec.stream = null
  source.close()
}

/**
   * Try the rec.stream again later, after it could not be opened. A Host that was
   * restarted mid-session starts serving it again; a Host that never will costs
   * one attempt a minute.
   */
function retryStream(rec: TransportRecord, delayMs: number): void {
  if (rec.disposed || rec.streamRetry) return
  rec.streamRetry = setTimeout(function () {
    rec.streamRetry = null
    if (!rec.disposed && rec.mounted > 0) openStream(rec)
  }, delayMs)
}

/**
   * The rec.stream could not carry the state. With no second path, the reader says
   * what is wrong where it can be seen: on the empty pane before the first
   * frame, as a banner after it.
   * @param message - why; the generic "not connected" text when empty.
   */
function streamFailed(rec: TransportRecord, message: string): void {
  rec.streaming = false
  const text = message || rec.t('status.offline')
  if (dataOf(rec).loadedOnce) rec.ports.toast(text, true)
  else rec.ports.setData({ status: 'error', error: text })
}

/**
   * Replace the rec.stream. The reader has no state request to make, so getting its
   * state again means reconnecting; a surface that is already rec.streaming can use
   * it to ask for a fresh whole state (the Retry button after a Host restart).
   */
export function reconnect(rec: TransportRecord): void {
  if (rec.disposed) return
  closeStream(rec)
  openStream(rec)
}

/**
   * Open the surface's rec.stream. This is the only path: the Host sends the whole
   * state once and then only what changed, and a page whose client bundle is
   * newer than the running Host says so instead of showing an empty list.
   */
export function openStream(rec: TransportRecord): void {
  closeStream(rec)
  rec.streamAttempts = 0
  // The rec.stream starts over: its first frame is the state this surface will
  // hold, not a change to the one it had.
  rec.firstFrame = true
  if (!dataOf(rec).loadedOnce && dataOf(rec).status !== 'error') rec.ports.setData({ status: 'loading' })
  if (rec.disposed) return
  if (typeof EventSource === 'undefined') {
    streamFailed(rec, rec.t('status.offline'))
    return
  }
  const source = new EventSource(`${STREAM_PATH}?rev=${rec.lastRev}`)
  rec.stream = source
  source.addEventListener('open', function () {
    if (rec.stream !== source) return
    rec.streamAttempts = 0
    rec.streaming = true
  })
  source.addEventListener('welcome', function (event: Event) {
    if (rec.stream !== source) return
    applyWelcome(rec, JSON.parse(String((event as MessageEvent).data)) as StreamWelcome)
  })
  source.addEventListener('delta', function (event: Event) {
    if (rec.stream !== source) return
    applyDelta(rec, JSON.parse(String((event as MessageEvent).data)) as StreamDelta)
  })
  source.addEventListener('error', function (event: Event) {
    if (rec.stream !== source) return
    const text: unknown = (event as MessageEvent).data
    if (typeof text === 'string' && text) {
      streamFailed(rec, text)
      return
    }
    // A transport failure. The browser's own retry gets a few chances, then
    // the rec.stream is given up for a while: a Host that has not been restarted
    // has no such route, and hammering it every few seconds helps nobody.
    rec.streaming = false
    rec.streamAttempts += 1
    if (rec.streamAttempts >= STREAM_ATTEMPTS) {
      rec.streamAttempts = 0
      closeStream(rec)
      streamFailed(rec, rec.t('status.offline'))
      retryStream(rec, STREAM_RETRY_MS)
    }
  })
}
