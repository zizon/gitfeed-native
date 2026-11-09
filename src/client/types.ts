/** State and controller shapes shared by the reader components. */

import type { Feed, GroupBy, GitInfo, Item, ReaderPrefs, ScheduleJobInfo } from '../shared/types.js'
import type { Translate } from './locales.js'

export type Filter = 'unread' | 'all' | 'starred'
export type Status = 'idle' | 'loading' | 'ready' | 'error'

export interface Toast {
  text: string
  error: boolean
  at: number
  /** The toast carries an undo for the mark that produced it. */
  undo?: boolean
}

/**
 * What the data root answered: the archive, the marks, the repository facts,
 * and how the last load went. The transport half of the snapshot.
 */
export interface ReaderData {
  status: Status
  error: string | null
  loadError: string | null
  loadedOnce: boolean
  items: Item[]
  byId: Map<string, Item>
  /** Version of the item model these rows came from; marks do not move it. */
  itemsVersion: string | null
  /** Rows that arrived while the reader was open, so their first paint fades. */
  fresh: Set<string>
  read: Set<string>
  starred: Set<string>
  feeds: Feed[]
  feedMap: Map<string, Feed>
  reader: ReaderPrefs
  git: GitInfo | null
  schedule: ScheduleJobInfo[]
  version: string | null
  repo: string
  allowGit: boolean
}

/** What the reader is looking at, and what the surface is doing while it looks. */
export interface ReaderUi {
  filter: Filter
  query: string
  /**
   * The ids the Host matched for the current query, or null while none has
   * answered yet. The body text is the Host's to search; the reader filters by
   * these ids.
   */
  searchIds: Set<string> | null
  feedId: string | null
  current: string | null
  groupBy: GroupBy | null
  hideEmpty: boolean | null
  markOnScroll: boolean | null
  showDigest: boolean | null
  folderOpen: Record<string, boolean>
  railW: number
  listW: number
  listEpoch: number
  busy: Record<string, boolean>
  toast: Toast | null
}

/** The published snapshot both halves merge into: what a surface reads. */
export type ClientState = ReaderData & ReaderUi

export interface Controller {
  get(): ClientState
  subscribe(listener: () => void): () => void
  /**
   * The published snapshot the renderer binds into a `useReader(selector)`
   * prop; a reader never writes through it.
   */
  reader: ReaderSource
  getList(): Item[]
  load(options?: { force?: boolean }): Promise<void>
  mark(ids: string[], value: boolean, keepList?: boolean): void
  select(id: string): void
  closeArticle(): void
  selectFeed(id: string | null): void
  setFilter(filter: Filter): void
  setQuery(query: string): void
  move(offset: number): void
  toggleRead(): void
  /** Star or unstar one item; the open article when no id is given. */
  toggleStar(id?: string): void
  openCurrent(): void
  escape(): void
  markAll(): void
  markCounts(): MarkCounts
  markEverything(): void
  undoMark(): void
  /** Clear the transient banner, called when the shared toast has finished. */
  dismissToast(): void
  /** Let go of rows a section the reader finished was holding on screen. */
  releaseSticky(ids: string[]): void
  /** Let go of rows a scroll left behind, rebuilding only if it held any. */
  trimSticky(ids: string[]): void
  /** Tell the reader whether the list is scrolled into the archive. */
  setScrolled(value: boolean): void
  /** Let the arrivals a refresh held back land, rebuilding if it added rows. */
  releaseHeld(): void
  /** How many rows the current view has, counted from the archive. */
  countInView(): number
  markGroup(key: string): void
  markFeed(feedId: string): void
  markFolder(folder: string): void
  setGroupBy(value: string): void
  setHideEmpty(value: boolean): void
  setMarkOnScroll(value: boolean): void
  setShowDigest(value: boolean): void
  digest(item: Item): string
  setFolderOpen(name: string, open: boolean): void
  setWidths(patch: { railW?: number; listW?: number }): void
  addFeed(url: string, folder: string): Promise<boolean>
  removeFeed(id: string): Promise<boolean>
  setFeedFolder(id: string, folder: string): Promise<boolean>
  runAction(name: string): Promise<void>
  mount(): void
  unmount(): void
  dispose(): void
  feedTitle(id: string): string
  feedFolder(id: string): string
  groupKey(item: Item): string
}

/** What each marking scope would touch, shown in the mark-read menu. */
export interface MarkCounts {
  /** Unread rows in the list as filtered, searched, and scoped right now. */
  results: number
  /** Unread items of the selected source. */
  source: number
  /** Unread items of the selected source's folder. */
  folder: number
  folderName: string | null
  /** Unread items in the whole reader. */
  all: number
}

/** One marking target the floating bar can switch to as the reader scrolls. */
export interface MarkScope {
  kind: 'all' | 'results'
  label: string
  n: number
}

/** The selector hook the renderer synthesizes from the registration's hooks. */
export type ReaderHook = <S>(selector: (state: ClientState) => S) => S

/** The bare snapshot source a registration publishes for that hook. */
export interface ReaderSource {
  getSnapshot(): ClientState
  subscribe(listener: () => void): () => void
}

export interface SlotProps {
  controller: Controller
  t: Translate
}

export type GitfeedPageProps = SlotProps & { useReader: ReaderHook }

export interface GitfeedRailProps extends SlotProps {
  useReader: ReaderHook
  useTabInfo?: () => { tab?: { visible?: boolean } } | null
}

export interface HeaderButtonProps {
  open: () => void
  t: Translate
}

export interface IconProps {
  size?: number
}

export interface FeedRailProps extends SlotProps {
  state: ClientState
  compact?: boolean
  onPick?: () => void
}

export interface ItemListProps extends SlotProps {
  state: ClientState
  compact?: boolean
  wide?: boolean
}

export interface ArticleProps extends SlotProps {
  state: ClientState
  compact?: boolean
}
