/** State and controller shapes shared by the reader components. */

import type { Feed, GroupBy, GitInfo, Item, LocalFetchInfo, ReaderPrefs } from "../shared/types.js";
import type { Translate } from "./locales.js";

export type Filter = "unread" | "all" | "starred";
export type Status = "idle" | "loading" | "ready" | "error";

export interface Toast {
  text: string;
  error: boolean;
  at: number;
}

export interface ClientState {
  status: Status;
  error: string | null;
  loadError: string | null;
  loadedOnce: boolean;
  items: Item[];
  byId: Map<string, Item>;
  read: Set<string>;
  starred: Set<string>;
  feeds: Feed[];
  feedMap: Map<string, Feed>;
  reader: ReaderPrefs;
  git: GitInfo | null;
  localFetch: LocalFetchInfo | null;
  version: string | null;
  repo: string;
  allowGit: boolean;
  filter: Filter;
  query: string;
  feedId: string | null;
  current: string | null;
  groupBy: GroupBy | null;
  hideEmpty: boolean | null;
  markOnScroll: boolean | null;
  showDigest: boolean | null;
  folderOpen: Record<string, boolean>;
  railW: number;
  listW: number;
  listEpoch: number;
  busy: Record<string, boolean>;
  toast: Toast | null;
}

export interface Controller {
  get(): ClientState;
  subscribe(listener: () => void): () => void;
  getList(): Item[];
  load(options?: { force?: boolean }): Promise<void>;
  mark(ids: string[], value: boolean, keepList?: boolean): void;
  select(id: string): void;
  closeArticle(): void;
  selectFeed(id: string | null): void;
  setFilter(filter: Filter): void;
  setQuery(query: string): void;
  move(offset: number): void;
  toggleRead(): void;
  toggleStar(): void;
  openCurrent(): void;
  escape(): void;
  markAll(): void;
  markCounts(): MarkCounts;
  markEverything(): void;
  markGroup(key: string): void;
  markFeed(feedId: string): void;
  markFolder(folder: string): void;
  setGroupBy(value: string): void;
  setHideEmpty(value: boolean): void;
  setMarkOnScroll(value: boolean): void;
  setShowDigest(value: boolean): void;
  digest(item: Item): string;
  setFolderOpen(name: string, open: boolean): void;
  setWidths(patch: { railW?: number; listW?: number }): void;
  addFeed(url: string, folder: string): Promise<boolean>;
  removeFeed(id: string): Promise<boolean>;
  runAction(name: string): Promise<void>;
  mount(): void;
  unmount(): void;
  dispose(): void;
  feedTitle(id: string): string;
  feedFolder(id: string): string;
  groupKey(item: Item): string;
}

/** What each marking scope would touch, shown in the mark-read menu. */
export interface MarkCounts {
  /** Unread rows in the list as filtered, searched, and scoped right now. */
  results: number;
  /** Unread items of the selected source. */
  source: number;
  /** Unread items of the selected source's folder. */
  folder: number;
  folderName: string | null;
  /** Unread items in the whole reader. */
  all: number;
}

export interface SlotProps {
  controller: Controller;
  t: Translate;
}

export type GitfeedPageProps = SlotProps;

export interface GitfeedRailProps extends SlotProps {
  useTabInfo?: () => { tab?: { visible?: boolean } } | null;
}

export interface HeaderButtonProps {
  open: () => void;
  t: Translate;
}

export interface IconProps {
  size?: number;
}

export interface FeedRailProps extends SlotProps {
  state: ClientState;
  compact?: boolean;
  onPick?: () => void;
}

export interface ItemListProps extends SlotProps {
  state: ClientState;
  compact?: boolean;
  wide?: boolean;
}

export interface ArticleProps extends SlotProps {
  state: ClientState;
  compact?: boolean;
}
