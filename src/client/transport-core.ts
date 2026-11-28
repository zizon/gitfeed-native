/** The transport's shared record, its API shapes, and its request helpers. */

import { PREFIX } from './constants.js'
import type { Item } from '../shared/types.js'
import type { Translate } from './locales.js'
import type { ReaderData, ReaderUi } from './types.js'

interface ApiFeed {
  title?: string
  url?: string
  folder?: string
}

export interface ApiResponse {
  ok?: boolean
  error?: string
  output?: string
  version?: string
  feed?: ApiFeed
  /** Ids one query matched, in archive order. */
  ids?: string[]
  /** One row with its body whole, when an article asked for it. */
  item?: Item | null
  /** What an OPML import changed. */
  summary?: {
    total?: number
    added?: number
    updated?: number
    kept?: number
  }
}

/** Failed stream attempts before the HTTP path takes over for a while. */
export const STREAM_ATTEMPTS = 3
/** How long a given-up stream waits before trying the Host again. */
export const STREAM_RETRY_MS = 60000

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
  /**
   * Whether a surface is showing a list it does not want a refresh to move.
   * That is any list with rows on it: the reader is looking at one, at the top
   * as much as in the middle, and rows that land above it push it down.
   */
  hold(): boolean
  /**
   * The item model moved: a text filter the Host answered may be stale, and the
   * surface's query is the Host's to answer.
   */
  refilter(): void
  /**
   * The open article's row arrived as a digest again: read its body once more
   * rather than leaving the reader with the first 400 characters.
   * @param id - the row the article is showing.
   */
  refetchBody(id: string): void
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
  /**
   * Tell the Host the reader opened or starred a row. The order that log feeds
   * is a convenience, not the reader's state: a lost act costs a day of
   * ranking, and a failure here is not worth a banner over the article.
   */
  attention: (kind: 'open' | 'star', item: string, feed: string) => void
  addFeed: (url: string, folder: string) => Promise<boolean>
  /**
   * Merge or replace the subscription list from an OPML document.
   * @param opml - the document's text.
   * @param replace - whether it becomes the whole list instead of merging.
   */
  importOpml: (opml: string, replace: boolean) => Promise<boolean>
  /** Download the subscription list as an OPML file. */
  exportOpml: () => Promise<boolean>
  removeFeed: (id: string) => Promise<boolean>
  setFeedFolder: (id: string, folder: string) => Promise<boolean>
  runAction: (name: string) => Promise<void>
  /**
   * Ask the Host which rows match a query; empty when the query is blank.
   * @param query - what the reader typed.
   * @param signal - cancels a query the reader has already replaced.
   */
  search: (query: string, signal?: AbortSignal) => Promise<string[]>
  /** One row with its body whole, for the article that is open. */
  body: (id: string, signal?: AbortSignal) => Promise<Item | null>
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
/** What the transport keeps between calls: queues, timers, and the stream. */
export interface TransportRecord {
  ports: TransportPorts
  t: Translate
  pendingRead: Set<string>
  pendingUnread: Set<string>
  /** Read rows that stay in the Unread list until the scope changes. */
  stickyRead: Set<string>
  /** Rows a refresh brought in while a surface was showing a list. */
  heldArrivals: Set<string>
  /** The first frame a (re)opened stream delivers is the baseline, not a change. */
  firstFrame: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
  freshTimer: ReturnType<typeof setTimeout> | null
  /** Mark promises waiting for the next flush to tell them what happened. */
  markWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>
  visibilityHandler: (() => void) | null
  mounted: number
  disposed: boolean
  /** The revision this surface holds, and the stream that keeps it current. */
  lastRev: number
  stream: EventSource | null
  streaming: boolean
  /** Failed attempts to open the stream; a Host that has none falls back for good. */
  streamAttempts: number
  streamRetry: ReturnType<typeof setTimeout> | null
}
export function dataOf(rec: TransportRecord): ReaderData {
  return rec.ports.read().data
}

export function uiOf(rec: TransportRecord): ReaderUi {
  return rec.ports.read().ui
}

export async function request(route: string, body?: unknown, signal?: AbortSignal): Promise<ApiResponse> {
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
    // The one place an answer becomes a failure: a status the Host could not
    // serve, or a 200 that says `ok: false` (a fetch that ran and failed is an
    // answer, not a status). Every command above throws from here, which is
    // why none of them checks the field itself.
    if (!res.ok || payload.ok === false) {
      throw new Error(payload.error || payload.output || (res.ok ? 'the Host refused the action' : `HTTP ${res.status}`))
    }
    return payload
  })
}

export function armFresh(rec: TransportRecord): void {
  if (rec.freshTimer) clearTimeout(rec.freshTimer)
  rec.freshTimer = setTimeout(function () {
    rec.freshTimer = null
    if (dataOf(rec).fresh.size) rec.ports.setData({ fresh: new Set() })
  }, 1600)
}
