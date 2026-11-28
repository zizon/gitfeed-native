/** The list's rendered pieces: rows, headers, chrome, and the mark bar. */

import { useState } from '../react.js'
import type { ReactNode, RefObject } from '../react.js'
import {
  Button,
  IconChevronDownOutlineRegular,
  Menu,
  MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { folderNames } from '../derive.js'
import type { Entry, GroupEntry } from '../derive.js'
import type { ClientState, Controller, MarkCounts, MarkScope } from '../types.js'
import { windowOf } from '../window.js'
import type { GroupBy, Item } from '../../shared/types.js'
import type { Translate } from '../locales.js'
import { fmtTime } from '../util.js'
import { IconStar } from '../icons.js'
import { EmptyState, IconButton } from './Controls.js'
import { FolderMenu } from './FolderMenu.js'

/** Rows the first paint fakes: more than any pane of this list holds. */
const SKELETON_ROWS = 8

function ListPlaceholder({ className, header, t, rowH, digest, loading, hint }: {
  className: string
  header: ReactNode
  t: Translate
  rowH: number
  digest: boolean
  loading?: boolean
  hint?: string
}) {
  return (
    <div className={className} aria-busy={loading ? 'true' : undefined}>
      {header}
      {loading
        ? <Skeleton height={rowH} digest={digest} label={t('status.loading')} />
        : <EmptyState className="compact" hint={hint || ''} />}
    </div>
  )
}

function everythingRows(
  t: Translate, all: number, scopeCount: number, armed: boolean, onArm: () => void, onMark: () => void,
): ReactNode[] {
  if (all === 0 || all === scopeCount) return []
  return [
    <MenuItemButton
      key="everything"
      danger
      onSelect={function () {
        if (!armed) {
          onArm()
          return
        }
        onMark()
      }}
    >
      {scopeLabel(armed ? t('action.markAllConfirm', { n: all }) : t('action.markEverything'), all)}
    </MenuItemButton>,
  ]
}

function scopeLabel(label: string, n: number) {
  return (
    <span className="gf-menu-row">
      <span>{label}</span>
      <span className="gf-menu-count">{String(n)}</span>
    </span>
  )
}

function SectionHeader({ entry, groupBy, state, controller, t, pendingUnsub, onPending }: {
  entry: GroupEntry
  groupBy: GroupBy
  state: ClientState
  controller: Controller
  t: Translate
  pendingUnsub: string | null
  onPending: (id: string | null) => void
}) {
  const groupUnread = entry.group.items.filter(function (item) { return !state.read.has(item.id) }).length
  const feedId = groupBy === 'feed' ? entry.group.key : ''
  const confirming = feedId !== '' && pendingUnsub === feedId
  return (
    <>
      <span className="gf-group-name">
        {confirming ? t('confirm.unsubscribe') : entry.group.label}
      </span>
      <div className="gf-group-actions">
        {confirming
          ? <ConfirmActions t={t} busy={state.busy.remove} onCancel={function () { onPending(null) }} onRemove={function () {
            onPending(null)
            void controller.removeFeed(feedId)
          }} />
          : (
            <HeaderActions
              feedId={feedId}
              feed={feedId ? state.feedMap.get(feedId) || null : null}
              state={state}
              controller={controller}
              t={t}
              groupKey={entry.group.key}
              groupUnread={groupUnread}
              onPending={onPending}
            />
          )}
      </div>
    </>
  )
}

function ConfirmActions({ t, busy, onCancel, onRemove }: {
  t: Translate
  busy: boolean
  onCancel: () => void
  onRemove: () => void
}) {
  return (
    <>
      <Button
        key="cancel"
        variant="ghost"
        size="sm"
        className="gf-group-read"
        onClick={onCancel}
      >
        {t('action.cancel')}
      </Button>
      <Button
        key="remove"
        variant="ghost"
        size="sm"
        className="gf-group-read gf-danger"
        disabled={busy}
        title={t('confirm.unsubscribeHint')}
        onClick={onRemove}
      >
        {t('action.remove')}
      </Button>
    </>
  )
}

function HeaderActions({ feedId, feed, state, controller, t, groupKey, groupUnread, onPending }: {
  feedId: string
  feed: { folder: string | null } | null
  state: ClientState
  controller: Controller
  t: Translate
  groupKey: string
  groupUnread: number
  onPending: (id: string | null) => void
}) {
  return (
    <>
      {feedId
        ? (
          <FolderMenu
            folder={feed ? feed.folder : null}
            folders={folderNames(state.feeds)}
            label={t('action.moveFolder')}
            t={t}
            align="end"
            onMove={function (name) {
              onPending(null)
              void controller.setFeedFolder(feedId, name)
            }}
            trigger={function (picker) {
              return (
                <Button
                  variant="ghost"
                  size="sm"
                  className="gf-group-read"
                  title={t('action.moveSource')}
                  onClick={picker.toggle}
                >
                  {t('action.move')}
                </Button>
              )
            }}
          />
        )
        : null}
      {feedId
        ? (
          <Button
            variant="ghost"
            size="sm"
            className="gf-group-unsub"
            title={t('confirm.unsubscribeHint')}
            onClick={function () { onPending(feedId) }}
          >
            {t('action.remove')}
          </Button>
        )
        : null}
      <Button
        variant="ghost"
        size="sm"
        className="gf-group-read"
        disabled={!groupUnread}
        title={t('action.markGroup')}
        onClick={function () { controller.markGroup(groupKey) }}
      >
        {groupUnread ? t('action.markGroupCount', { n: groupUnread }) : t('action.markGroup')}
      </Button>
    </>
  )
}

function ItemRow({ item, groupBy, state, controller, t, showDigest, digest, gone }: {
  item: Item
  groupBy: GroupBy
  state: ClientState
  controller: Controller
  t: Translate
  showDigest: boolean
  digest: string
  gone: string
}) {
  const unread = !state.read.has(item.id)
  const starred = state.starred.has(item.id)
  return (
    <div
      className={`gf-row${unread ? ' unread' : ''}${state.current === item.id ? ' active' : ''}${state.fresh.has(item.id) ? ' gf-row-in' : ''}${gone}`}
    >
      {/* The row is the container; the row's own target is the button, so the
          star beside it is never announced as part of the row's name. */}
      <button
        type="button"
        className="gf-row-main"
        tabIndex={-1}
        aria-current={state.current === item.id ? 'true' : undefined}
        onClick={function () { controller.select(item.id) }}
      >
        <span className="gf-row-title">
          {unread ? <span className="gf-dot" aria-hidden="true" /> : null}
          <span className="t">{item.title || '(untitled)'}</span>
        </span>
        <span className="gf-row-meta">
          {/* Every row under a source section would repeat the name the sticky
              header already carries; only an ungrouped list needs it per row. */}
          {groupBy === 'feed' ? null : <span className="feed-name">{controller.feedTitle(item.feed)}</span>}
          <span className="when">{fmtTime(item.date)}</span>
        </span>
        {/* The digest line is part of the row's shape: an entry with no summary
            keeps an empty line there, so a row without a preview is the same
            three lines as the rest rather than a shorter variant. */}
        {showDigest ? <span className="gf-row-digest">{digest}</span> : null}
      </button>
      {/* The star is an action on the row, not a way into it: it sits on every
          row so an item can be kept without opening the article, and it holds
          its space so the title never re-wraps on hover. */}
      <span className={`gf-row-actions${starred ? ' on' : ''}`}>
        <IconButton
          icon={<IconStar filled={starred} size={13} />}
          label={starred ? t('action.unstar') : t('action.star')}
          small
          active={starred}
          // The rows are reached with j/k, not the tab key; a tab stop per row
          // would put hundreds of them between the reader and the controls
          // that are actually tabbed to.
          tabIndex={-1}
          onClick={function () { controller.toggleStar(item.id) }}
        />
      </span>
    </div>
  )
}

export function ListHeader({ t, remaining, heldCount, atTop, onRelease }: {
  t: Translate
  remaining: number
  heldCount: number
  atTop: boolean
  onRelease: () => void
}) {
  return (
    <div className="gf-listbar">
      <span className="gf-count-label">{t('items.count', { n: remaining })}</span>
      {/* At the top, arrivals are held rather than pushing the newest row down.
          This is how they are asked for; anywhere else the reader gets them by
          coming back to the top, which is why the control only appears here. */}
      {heldCount > 0 && atTop
        ? (
          <button
            type="button"
            className="gf-newitems"
            title={t('list.newHint')}
            onClick={onRelease}
          >
            {t('list.newItems', { n: heldCount })}
          </button>
        )
        : null}
    </div>
  )
}

function MarkBar({ t, scope, open, rows, onRun, onOpen, onClose }: {
  t: Translate
  scope: MarkScope
  open: boolean
  rows: ReactNode[]
  onRun: () => void
  onOpen: () => void
  onClose: () => void
}) {
  return (
    <div className={`gf-markfloat${scope.n ? '' : ' off'}`}>
      <Button
        variant="ghost"
        size="sm"
        className="gf-markfloat-main"
        disabled={!scope.n}
        title={scope.label}
        onClick={onRun}
      >
        <span className="gf-markfloat-label">{scope.label}</span>
        <span className="gf-markfloat-count">{String(scope.n)}</span>
      </Button>
      {rows.length > 0
        ? (
          <Menu
            open={open}
            side="top"
            align="end"
            onClose={onClose}
            className="gf-markfloat-more"
            anchor={(
              <IconButton
                icon={<IconChevronDownOutlineRegular size={14} />}
                label={t('action.markPick')}
                small
                hasPopup="menu"
                expanded={open}
                onClick={onOpen}
              />
            )}
          >
            {rows}
          </Menu>
        )
        : null}
    </div>
  )
}

function Skeleton({ height, digest, label }: { height: number; digest: boolean; label: string }) {
  return (
    <div className="gf-skel" role="status" aria-label={label}>
      {Array.from({ length: SKELETON_ROWS }, function (_, i) {
        return (
          <div key={i} className="gf-skel-row" style={{ height: height }}>
            <div className="gf-skel-line" style={{ width: '62%' }} />
            <div className="gf-skel-line" style={{ width: '34%' }} />
            {digest ? <div className="gf-skel-line" style={{ width: '88%' }} /> : null}
          </div>
        )
      })}
    </div>
  )
}

function leavingOf(index: number, finishedSet: Set<string>, groupFloor: number[], entries: Entry[]): boolean {
  if (!finishedSet.size) return false
  const floor = groupFloor[index]
  if (floor < 0) return false
  const header = entries[floor]
  return header.kind === 'group' && finishedSet.has(header.group.key)
}

export function listRowsOf(input: {
  slice: Entry[]
  band: ReturnType<typeof windowOf>
  entries: Entry[]
  groupFloor: number[]
  finishedSet: Set<string>
  groupBy: GroupBy
  state: ClientState
  controller: Controller
  t: Translate
  pendingUnsub: string | null
  onPending: (id: string | null) => void
  showDigest: boolean
}): ReactNode[] {
  return input.slice.map(function (entry, offset) {
    const gone = leavingOf(input.band.start + offset, input.finishedSet, input.groupFloor, input.entries) ? ' gf-fade' : ''
    if (entry.kind === 'group') {
      return (
        <div key={entry.key} className={`gf-group${gone}`}>
          <SectionHeader
            entry={entry}
            groupBy={input.groupBy}
            state={input.state}
            controller={input.controller}
            t={input.t}
            pendingUnsub={input.pendingUnsub}
            onPending={input.onPending}
          />
        </div>
      )
    }
    const item = entry.item
    return (
      <ItemRow
        key={entry.key}
        item={item}
        groupBy={input.groupBy}
        state={input.state}
        controller={input.controller}
        t={input.t}
        showDigest={input.showDigest}
        digest={input.showDigest ? input.controller.digest(item) : ''}
        gone={gone}
      />
    )
  })
}

export function MarkArea({ t, counts, scope, controller }: {
  t: Translate
  counts: MarkCounts
  scope: MarkScope
  controller: Controller
}) {
  const [open, setOpen] = useState(false)
  /** Only the whole-library entry needs a second, differently placed click. */
  const [armed, setArmed] = useState(false)

  function close() {
    setOpen(false)
    setArmed(false)
  }

  function run() {
    if (!scope.n) return
    if (scope.kind === 'all') controller.markEverything()
    else controller.markAll()
  }

  // The button marks the view; the menu holds the one scope the view does not
  // reach — every unread item in the library — and only when that differs.
  const rows = everythingRows(
    t,
    counts.all,
    scope.n,
    armed,
    function () { setArmed(true) },
    function () { close(); controller.markEverything() },
  )

  return (
    <MarkBar
      t={t}
      scope={scope}
      open={open}
      rows={rows}
      onRun={run}
      onOpen={function () {
        if (open) close()
        else { setOpen(true); setArmed(false) }
      }}
      onClose={close}
    />
  )
}

export function bandParts(
  entries: Entry[], offsets: number[], band: ReturnType<typeof windowOf>, total: number,
): { slice: Entry[]; lead: number; trail: number; pinned: Entry | undefined } {
  return {
    slice: entries.slice(band.start, band.end),
    lead: offsets[band.start] || 0,
    trail: Math.max(0, total - (offsets[band.end] || total)),
    pinned: band.headerIndex === null ? undefined : entries[band.headerIndex],
  }
}

export function placeholderOf({ state, count, paneClass, header, t, rowH, digest }: {
  state: ClientState
  count: number
  paneClass: string
  header: ReactNode
  t: Translate
  rowH: number
  digest: boolean
}): ReactNode | null {
  if (state.status === 'loading' && !state.items.length) {
    return <ListPlaceholder className={paneClass} header={header} t={t} rowH={rowH} digest={digest} loading />
  }
  if (state.status === 'error' && !state.items.length) {
    return (
      <ListPlaceholder
        className={paneClass}
        header={header}
        t={t}
        rowH={rowH}
        digest={digest}
        hint={state.error || t('status.error')}
      />
    )
  }
  if (count) return null
  return (
    <ListPlaceholder
      className={paneClass}
      header={header}
      t={t}
      rowH={rowH}
      digest={digest}
      hint={state.items.length ? t('empty.nothing') : t('empty.noItems')}
    />
  )
}

export function ListBody({
  paneClass, header, markBar, viewportRef, onScroll, lead, trail, listRows, viewportH,
  pinned, finishedSet, groupBy, state, controller, t, pendingUnsub, onPending,
}: {
  paneClass: string
  header: ReactNode
  markBar: ReactNode
  viewportRef: RefObject<HTMLDivElement>
  onScroll: (event: { currentTarget: HTMLDivElement }) => void
  lead: number
  trail: number
  listRows: ReactNode[]
  viewportH: number
  pinned: Entry | undefined
  finishedSet: Set<string>
  groupBy: GroupBy
  state: ClientState
  controller: Controller
  t: Translate
  pendingUnsub: string | null
  onPending: (id: string | null) => void
}) {
  return (
    <div className={paneClass}>
      {header}
      <div className="gf-scrollwrap">
        <div className="gf-scroll" ref={viewportRef} onScroll={onScroll}>
          <div style={{ height: lead }} />
          {listRows}
          <div style={{ height: trail }} />
          {/* One viewport of scroll past the last row. The rows the list ends on
              could otherwise never leave the viewport, so they stayed unread;
              this is also where the reader learns the list is over. */}
          <div className="gf-endnote" style={{ height: viewportH ? viewportH + 1 : undefined }}>{t('list.end')}</div>
        </div>
        {pinned && pinned.kind === 'group'
          ? (
            <div className={`gf-group gf-group-pinned${finishedSet.has(pinned.group.key) ? ' gf-fade' : ''}`}>
              <SectionHeader
                entry={pinned}
                groupBy={groupBy}
                state={state}
                controller={controller}
                t={t}
                pendingUnsub={pendingUnsub}
                onPending={onPending}
              />
            </div>
          )
          : null}
      </div>
      {markBar}
    </div>
  )
}
