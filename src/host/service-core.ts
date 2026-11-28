// The reader's Host state machine: committed items plus the local refresh
// cache, read/star state, subscriptions, git actions, and the job runner.

import type { JobHandle, JobRunner, JobTimers } from './runner.js'
import { pathsFor } from './settings.js'
import { createLiveState } from './live.js'
import type { Logger, ReaderStateData, ReadyState } from './types.js'
import type { GitInfo, Item } from '../shared/types.js'
import { decodeEntities } from './xml.js'



/** A local mark is pushed after this much quiet, so scrolling marks coalesce. */
export const AUTO_SYNC_DEBOUNCE_MS = 20000
/** Longest a continuously marking reader waits before a sync. */
export const AUTO_SYNC_MAX_WAIT_MS = 5 * 60000
/** Rows whose searchable text is built between yields to the event loop. */
export const SEARCH_CHUNK = 64
/**
 * How long the git facts behind the status line stay usable before they are
 * read again. A fetch run changes nothing git tracks — the cache it writes is
 * ignored — so it must not pay for `git status`; a pull, a commit, or a
 * subscription change invalidates the facts explicitly.
 */
export const GIT_FACTS_MS = 5 * 60000

export type StateResponse = Omit<ReadyState, keyof ReaderStateData> & Partial<ReaderStateData>

export interface GitfeedOptions {
  root: string
  logger?: Logger
  /** Where the jobs' wake-ups come from: the Host's timer service. */
  timers: JobTimers
  refreshMinutes?: number
  idleMinutes?: number
  allowGit?: boolean
  adaptive?: boolean
  maxIntervalMinutes?: number
  /** Minutes between read-state syncs; 0 disables auto-sync. */
  syncMinutes?: number
  /** Ceiling of the sync backoff. */
  syncMaxMinutes?: number
}

export interface MetaEntry {
  title?: string | null
  folder?: string | null
  siteUrl?: string | null
  url?: string | null
  lastError?: string | null
  checkedAt?: string | null
}

export interface ListToolInput {
  query?: unknown
  feed?: unknown
  feedId?: unknown
  unreadOnly?: unknown
  starredOnly?: unknown
  limit?: unknown
}

/** A feed body as plain text, stripped first and decoded with the parser's own
 * table: the agent's search then finds the same `&mdash;` and numeric
 * references the reader's search does. */
export function plainText(html: string | null | undefined): string {
  return decodeEntities((html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function checkedIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const clean: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || id.length >= 64) continue
    clean.push(id)
  }
  return clean
}

/**
 * Newest first, with the id as a tie-break: two items that share a timestamp
 * would otherwise keep whatever order the shards happened to read in, and a
 * refresh could swap them under the reader.
 */
export function compareItems(a: Item, b: Item): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/**
 * Create the Host-side reader for one checkout.
 * @param {object} options
 * @param {string} options.root absolute gitfeed checkout.
 * @param {{info:Function, warn:Function, error:Function}} [options.logger]
 * @returns {object} reader surface used by the HTTP API and the agent tool.
 */
/** What the service keeps between calls: caches, the live copy, and the jobs. */
export interface ServiceRecord {
  root: string
  logger: Logger
  paths: ReturnType<typeof pathsFor>
  refreshMinutes: number
  idleMinutes: number
  allowGit: boolean
  adaptive: boolean
  maxIntervalMinutes: number
  syncMinutes: number
  syncMaxMinutes: number
  timers: JobTimers
  itemsCache: { version: string | null; items: Item[] | null }
  shardRows: Map<string, { stamp: string; rows: Item[] }>
  gitCache: { at: number; value: GitInfo | null }
  gitFacts: { at: number; value: GitInfo | null } | null
  searchTexts: Map<string, string> | null
  searchTitles: string
  writeQueue: Promise<void>
  disposed: boolean
  /** Stops a fetch run when the plugin unloads. */
  stopping: AbortController
  live: ReturnType<typeof createLiveState>
  /** Surfaces currently pulling frames; the probe only runs while one is. */
  attached: number
  probeWaker: (() => void) | null
  runner: JobRunner
  refreshJob: JobHandle
  syncJob: JobHandle
}
