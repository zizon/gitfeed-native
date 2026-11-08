/** Data shapes shared by the Host service and the native reader. */

export type GroupBy = "none" | "folder" | "feed";

export interface Item {
  id: string;
  feed: string;
  title: string;
  link: string;
  date: string;
  author: string;
  summary: string;
}

export interface Feed {
  id: string;
  title: string;
  folder: string | null;
  siteUrl: string | null;
  url: string | null;
  error: string | null;
  checkedAt: string | null;
}

export interface ReaderPrefs {
  hideEmptyFeeds: boolean;
  markReadOnScroll: boolean;
  groupBy: GroupBy;
}

export interface GitInfo {
  repo: boolean;
  branch?: string;
  dirty?: boolean;
  remotes?: string[];
  ahead?: number;
  behind?: number;
  error?: string;
}

export interface LocalFetchInfo {
  enabled: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  running: boolean;
}

/** The state payload `/gitfeed/api/state` returns (full or compact). */
export interface StatePayload {
  version: string;
  unchanged?: boolean;
  items: Item[];
  read: string[];
  starred: string[];
  feeds: Feed[];
  reader: ReaderPrefs;
  repo: string;
  allowGit: boolean;
  git: GitInfo | null;
  localFetch: LocalFetchInfo;
  generatedAt: string;
  error?: string;
}

export interface FeedEntry {
  id: string;
  url: string;
  title?: string | null;
  folder?: string | null;
  disabled?: boolean;
}
