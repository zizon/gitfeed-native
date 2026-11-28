import { useId, useMemo, useRef, useState } from '../react.js'
import type { ReactNode } from '../react.js'
import { folderNames, railGroups, sourceOrder } from '../derive.js'
import type { RailGroup, SourceOrder } from '../derive.js'
import type { ClientState, Controller, FeedRailProps } from '../types.js'
import type { Feed } from '../../shared/types.js'
import type { Translate } from '../locales.js'
import { EmptyState } from './Controls.js'
import { FixedRows, AddFeedForm, FolderBlock, RailHead } from './feed-rail-parts.js'
import { SubscriptionsDialog } from './SubscriptionsDialog.js'

export interface MoveForm {
  id: string
  value: string
}

export function FeedRail({ state, controller, t, compact, onPick }: FeedRailProps) {
  const [addOpen, setAddOpen] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  const [creating, setCreating] = useState<MoveForm | null>(null)
  const [subsOpen, setSubsOpen] = useState(false)
  const listId = useId()

  // The order over sources is the one the load settled: the sources the reader
  // reads first, the rest by name. It is not recomputed from the read set, so
  // reading a source cannot re-rank the rail under the pointer.
  const order = useMemo(function () { return railOrderOf(state, t) }, [state.feeds, state.ranks, state.interestOrder, t])
  const grouped = useMemo(function () { return railGroupingOf(state, order, t) }, [state.items, state.feeds, state.read, order, t])

  const hideEmpty = state.hideEmpty === null ? state.reader.hideEmptyFeeds : state.hideEmpty
  const hiding = hideEmpty && state.filter === 'unread'
  const folders = folderNames(state.feeds)

  const { seen, folderOpenOf } = useRailTree(state)
  const { pick, confirmRemove, createFolder, openNewFolder } = useRailActions(
    controller, onPick, setPendingRemove, setCreating,
  )

  const rows: ReactNode[] = [
    <FixedRows
      key="fixed"
      state={state}
      t={t}
      total={grouped.total}
      addOpen={addOpen}
      onAll={function () { pick(null) }}
      onToggleAdd={function () { setAddOpen(!addOpen) }}
      onImport={function () { setSubsOpen(true) }}
    />,
  ]

  if (addOpen) {
    rows.push(
      <AddFeedForm
        key="form"
        controller={controller}
        t={t}
        listId={listId}
        busy={state.busy.add}
        onDone={function () { setAddOpen(false) }}
      />,
    )
  }

  for (const entry of grouped.groups) {
    const name = entry.name
    const unread = folderUnread(entry, grouped.counts)
    if (hiding && unread === 0 && !seen.folders.has(name)) continue
    seen.folders.add(name)
    const shown = visibleFeeds(entry, grouped.counts, hiding, seen.feeds)
    rows.push(
      <FolderBlock
        key={`folder:${name}`}
        name={name}
        unread={unread}
        open={folderOpenOf(name, unread)}
        feeds={shown}
        counts={grouped.counts}
        selected={state.feedId}
        busy={state.busy}
        pendingRemove={pendingRemove}
        creating={creating}
        t={t}
        controller={controller}
        folders={folders}
        onPick={pick}
        onConfirmRemove={function (id) { void confirmRemove(id) }}
        onCancelRemove={function () { setPendingRemove(null) }}
        onCreating={setCreating}
        onCreateFolder={function (id, value) { void createFolder(id, value) }}
        onNewFolder={openNewFolder}
        onRemove={function (id) { setPendingRemove(id) }}
      />,
    )
  }

  if (!state.feeds.length && !addOpen) {
    rows.push(<EmptyState key="empty" className="compact" hint={t('empty.rail')} />)
  }

  // One "Add feed" entry: the row in the list, which carries its own label.
  return (
    <div className={`gf-feedrail${compact ? ' compact' : ''}`}>
      <RailHead compact={compact} t={t} controller={controller} />
      <div className="gf-feedlist">{rows}</div>
      {subsOpen
        ? (
          <SubscriptionsDialog
            state={state}
            controller={controller}
            t={t}
            onClose={function () { setSubsOpen(false) }}
          />
        )
        : null}
      <datalist id={listId}>
        {Array.from(new Set(folders)).sort().map(function (name) {
          return <option key={name} value={name} />
        })}
      </datalist>
    </div>
  )
}

/** One folder: its head, and the rows of the sources it holds. */

/** The unread rows a folder holds, by the counts the rail was built with. */
function folderUnread(entry: RailGroup, counts: Map<string, number>): number {
  let unread = 0
  for (const feed of entry.feeds) unread += counts.get(feed.id) || 0
  return unread
}

/**
 * The sources a folder still shows: with "hide empty" on and the unread filter,
 * a source with nothing unread leaves only when it has not been on screen yet —
 * dropping it mid-read would move the tree under the pointer.
 */
function visibleFeeds(entry: RailGroup, counts: Map<string, number>, hiding: boolean, seen: Set<string>): Feed[] {
  const shown: Feed[] = []
  for (const feed of entry.feeds) {
    const count = counts.get(feed.id) || 0
    if (hiding && count === 0 && !seen.has(feed.id)) continue
    seen.add(feed.id)
    shown.push(feed)
  }
  return shown
}

/** The rail's order over sources: the one the load settled, not the read set. */
function railOrderOf(state: ClientState, t: Translate): SourceOrder {
  const interestOrder = state.interestOrder === null ? true : state.interestOrder
  const scores = interestOrder ? state.ranks : null
  return sourceOrder(state.feeds, scores, t('feed.uncategorized'))
}

/** The unread counts, the total, and the folder groups the rail draws. */
function railGroupingOf(state: ClientState, order: SourceOrder, t: Translate): {
  counts: Map<string, number>
  total: number
  groups: RailGroup[]
} {
  const counts = new Map<string, number>()
  let total = 0
  for (const item of state.items) {
    if (state.read.has(item.id)) continue
    counts.set(item.feed, (counts.get(item.feed) || 0) + 1)
    total += 1
  }
  return { counts: counts, total: total, groups: railGroups(state.feeds, order, t('feed.uncategorized')) }
}

/**
 * A folder opens or closes only when it first appears or when the reader toggles
 * it. Deriving the state from the live unread count made the list collapse and
 * expand on every background refresh while it was on screen. A feed or folder
 * that was on screen stays on screen until the scope changes: dropping rows the
 * moment their last unread item is marked read moves the tree under the pointer.
 */
function useRailTree(state: ClientState): {
  seen: { feeds: Set<string>; folders: Set<string> }
  folderOpenOf: (name: string, unread: number) => boolean
} {
  const scopeKey = `${state.filter}\u0000${state.feedId || ''}`
  const seenRef = useRef<{ key: string; feeds: Set<string>; folders: Set<string> }>({
    key: '', feeds: new Set(), folders: new Set(),
  })
  if (seenRef.current.key !== scopeKey) {
    seenRef.current = { key: scopeKey, feeds: new Set(), folders: new Set() }
  }
  const seen = seenRef.current
  const seededOpen = useRef<Map<string, boolean>>(new Map())
  function folderOpenOf(name: string, unread: number): boolean {
    if (Object.prototype.hasOwnProperty.call(state.folderOpen, name)) return state.folderOpen[name]
    const seeded = seededOpen.current
    if (!seeded.has(name)) seeded.set(name, unread > 0)
    return seeded.get(name) === true
  }
  return { seen: seen, folderOpenOf: folderOpenOf }
}

/** The rail's own commands: the row picks, the confirm, and the two folder forms. */
function useRailActions(
  controller: Controller,
  onPick: (() => void) | undefined,
  setPendingRemove: (id: string | null) => void,
  setCreating: (next: MoveForm | null) => void,
): {
  pick: (id: string | null) => void
  confirmRemove: (id: string) => Promise<void>
  createFolder: (id: string, value: string) => Promise<void>
  openNewFolder: (id: string) => void
} {
  function pick(id: string | null) {
    controller.selectFeed(id)
    if (onPick) onPick()
  }

  async function confirmRemove(id: string) {
    const ok = await controller.removeFeed(id)
    setPendingRemove(null)
    if (ok && onPick) onPick()
  }

  /**
   * Name a folder and put the feed in it. This is the one path that needs a
   * field: picking a folder that already exists is the menu's job.
   */
  async function createFolder(id: string, value: string) {
    const name = value.trim()
    if (!name) return
    const ok = await controller.setFeedFolder(id, name)
    if (ok) setCreating(null)
  }

  /** Ask for a new folder name: the field the row replaces itself with. */
  function openNewFolder(id: string) {
    setPendingRemove(null)
    setCreating({ id: id, value: '' })
  }

  return { pick: pick, confirmRemove: confirmRemove, createFolder: createFolder, openNewFolder: openNewFolder }
}

/** The rows above the folders: the whole library, and the two ways to add one. */

/** The rail's own head: its title, and the fold control the full rail carries. */

/** The add-feed form: a URL, an optional folder, and the two buttons. */

/** One folder's heading: its name, its count, and the mark for the folder. */

/** The confirm a source row swaps into before it is removed. */

/** The field that names a new folder for one source. */

/** The actions a source row carries: move, mark the source read, unsubscribe. */

/** One source row: the source's own actions, or the confirm and name forms it swaps into. */
