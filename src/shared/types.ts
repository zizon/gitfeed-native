/** Data shapes shared by the Host service and the native reader. */

export type GroupBy = 'none' | 'folder' | 'feed'

/**
 * How a subscription's URL becomes items: an RSS/Atom document, or a script in
 * the data root's `sources/` that produces a pseudo feed. `rss` is the default
 * and needs no declaration.
 */
export type SourceKind = 'rss' | 'custom'

export interface Item {
  id: string
  feed: string
  title: string
  link: string
  date: string
  author: string
  summary: string
}

export interface Feed {
  id: string
  title: string
  folder: string | null
  siteUrl: string | null
  url: string | null
  error: string | null
  checkedAt: string | null
  /** How the entry is fetched; absent on payloads from before custom sources. */
  kind?: SourceKind
}

export interface ReaderPrefs {
  hideEmptyFeeds: boolean
  markReadOnScroll: boolean
  groupBy: GroupBy
}

export interface GitInfo {
  repo: boolean
  branch?: string | null
  dirty?: boolean
  remotes?: string[]
  ahead?: number
  behind?: number
  error?: string
}

/** One completed run of a scheduled job. */
export interface ScheduleJobRun {
  at: string
  ok: boolean
  /** The run produced new work: items, commits, or pulled changes. */
  fresh: boolean
  summary: string
  /** Job-specific counters for the status line (fetch: added/failed/feeds). */
  detail?: Record<string, number>
}

/** One job of the reader's adaptive scheduler, as `/gitfeed/api/state` reports it. */
export interface ScheduleJobInfo {
  id: string
  label: string
  /** False when the job is registered but cannot run, for example without an origin remote. */
  enabled: boolean
  /** The interval the job currently uses, after backoff. */
  intervalMs: number
  /** Earliest run, or null when the job is disabled or never scheduled. */
  nextDueAt: string | null
  lastRunAt: string | null
  running: boolean
  last: ScheduleJobRun | null
  /** Why the job cannot run, when it is disabled. */
  error: string | null
}

export interface FeedEntry {
  id: string
  url: string
  title?: string | null
  folder?: string | null
  disabled?: boolean
  /** `custom` reads this entry through a script; absent means an RSS/Atom feed. */
  type?: string
  /** The script's file name under the data root's `sources/`. */
  script?: string
  /** Handed to the script untouched. */
  options?: unknown
}
