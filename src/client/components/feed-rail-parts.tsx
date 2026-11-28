import { useEffect, useRef, useState } from '../react.js'
import {
  Button,
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconPlusOutlineRegular,
  IconUploadOutlineRegular,
  IconWarningOutlineRegular,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Chevron, IconFolder } from '../icons.js'
import { FolderMenu } from './FolderMenu.js'
import type { MoveForm } from './FeedRail.js'
import type { ClientState, Controller } from '../types.js'
import type { Feed } from '../../shared/types.js'
import type { Translate } from '../locales.js'
import { IconButton } from './Controls.js'

export function FixedRows({ state, t, total, addOpen, onAll, onToggleAdd, onImport }: {
  state: ClientState
  t: Translate
  total: number
  addOpen: boolean
  onAll: () => void
  onToggleAdd: () => void
  onImport: () => void
}) {
  return (
    <>
      <div className={`gf-feed${state.feedId ? '' : ' on'}`}>
        <button type="button" className="gf-feed-main" onClick={onAll}>
          <span className="name">{t('feed.all')}</span>
        </button>
        <span className="count">{total ? String(total) : ''}</span>
      </div>
      <div className="gf-feed gf-addbtn">
        <button type="button" className="gf-feed-main" onClick={onToggleAdd} aria-expanded={addOpen}>
          <IconPlusOutlineRegular size={14} />
          <span className="name">{t('action.addFeed')}</span>
        </button>
      </div>
      <div className="gf-feed gf-addbtn">
        <button type="button" className="gf-feed-main" onClick={onImport}>
          <IconUploadOutlineRegular size={14} />
          <span className="name">{t('action.importExport')}</span>
        </button>
      </div>
    </>
  )
}

export function RailHead({ compact, t, controller }: {
  compact?: boolean
  t: Translate
  controller: Controller
}) {
  return (
    <div className="gf-rail-head">
      <span className="gf-rail-title">{t('rail.guideTitle')}</span>
      {/* The list folds from its own corner. The compact rail lives inside the
          Sidebar's own popover, where the page's panels are not its business,
          so it carries no fold control. */}
      {compact
        ? null
        : (
          <IconButton
            icon={<IconPanelLeftOutlineRegular size={16} />}
            label={t('action.collapseSources')}
            small
            onClick={function () { controller.setRailHidden(true) }}
          />
        )}
    </div>
  )
}

export function AddFeedForm({ controller, t, listId, busy, onDone }: {
  controller: Controller
  t: Translate
  listId: string
  busy: boolean
  onDone: () => void
}) {
  const [url, setUrl] = useState('')
  const [folder, setFolder] = useState('')

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault()
    const value = url.trim()
    if (!value) return
    const ok = await controller.addFeed(value, folder)
    if (!ok) return
    setUrl('')
    setFolder('')
    onDone()
  }

  return (
    <form className="gf-addform" onSubmit={function (event) { void submit(event) }}>
      <Input
        className="gf-addinput"
        type="url"
        value={url}
        required
        placeholder="https://example.com/feed.xml"
        aria-label={t('action.addFeed')}
        autoComplete="off"
        spellCheck={false}
        onChange={function (event: { target: { value: string } }) { setUrl(event.target.value) }}
      />
      <Input
        className="gf-addinput"
        type="text"
        value={folder}
        placeholder={t('pref.folder')}
        aria-label={t('pref.folder')}
        list={listId}
        autoComplete="off"
        onChange={function (event: { target: { value: string } }) { setFolder(event.target.value) }}
      />
      <div className="gf-addrow">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? t('action.adding') : t('action.add')}
        </Button>
      </div>
    </form>
  )
}

function FolderHead({ name, unread, open, t, controller }: {
  name: string
  unread: number
  open: boolean
  t: Translate
  controller: Controller
}) {
  return (
    <div className="gf-folder-head">
      <button
        type="button"
        className="gf-folder-main"
        aria-expanded={open}
        onClick={function () { controller.setFolderOpen(name, !open) }}
      >
        <Chevron open={open} />
        <span className="gf-folder-name">{name}</span>
      </button>
      {unread ? (
        <IconButton
          icon={<IconCheckOutlineRegular size={14} />}
          label={`${t('action.markFolder')}: ${name}`}
          small
          className="gf-rail-check"
          onClick={function () { controller.markFolder(name) }}
        />
      ) : null}
      <span className="count">{unread ? String(unread) : ''}</span>
    </div>
  )
}

function ConfirmRow({ busy, t, onConfirm, onCancel }: {
  busy: boolean
  t: Translate
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="gf-feed gf-confirm">
      <span className="name">{t('confirm.unsubscribe')}</span>
      <Button variant="ghost" size="sm" className="gf-danger" disabled={busy} onClick={onConfirm}>
        {t('action.remove')}
      </Button>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        {t('action.cancel')}
      </Button>
    </div>
  )
}

function MoveForm({ feed, value, busy, t, onChange, onSubmit, onCancel }: {
  feed: Feed
  value: string
  busy: boolean
  t: Translate
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const nameRef = useRef<HTMLInputElement>(null)
  /** The field the reader is typing a folder name into holds the keyboard. */
  useEffect(function () {
    nameRef.current?.focus()
  }, [])

  return (
    <form className="gf-moveform" onSubmit={function (event) { event.preventDefault(); onSubmit() }}>
      <span className="gf-moveform-name" title={feed.title}>
        {t('action.newFolderTitle', { name: feed.title })}
      </span>
      <Input
        ref={nameRef}
        className="gf-addinput"
        type="text"
        value={value}
        placeholder={t('pref.folder')}
        aria-label={t('action.newFolder')}
        autoComplete="off"
        spellCheck={false}
        onChange={function (event: { target: { value: string } }) { onChange(event.target.value) }}
      />
      <div className="gf-addrow">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={busy || !value.trim()}>
          {t('action.move')}
        </Button>
      </div>
    </form>
  )
}

function FeedActions({ feed, count, t, controller, folders, onCreating, onNewFolder, onRemove }: {
  feed: Feed
  count: number
  t: Translate
  controller: Controller
  folders: readonly string[]
  onCreating: (next: MoveForm | null) => void
  onNewFolder: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <>
      <FolderMenu
        folder={feed.folder}
        folders={folders}
        label={t('action.moveFolder')}
        t={t}
        allowNew
        onMove={function (name) {
          onCreating(null)
          void controller.setFeedFolder(feed.id, name)
        }}
        onNew={function () { onNewFolder(feed.id) }}
        trigger={function (picker) {
          return (
            <IconButton
              icon={<IconFolder size={14} />}
              label={`${t('action.moveFolder')}: ${feed.title}`}
              small
              hasPopup="menu"
              expanded={picker.open}
              onClick={picker.toggle}
            />
          )
        }}
      />
      {count ? (
        <IconButton
          icon={<IconCheckOutlineRegular size={14} />}
          label={`${t('action.markSource')}: ${feed.title}`}
          small
          className="gf-rail-check"
          onClick={function () { controller.markFeed(feed.id) }}
        />
      ) : null}
      <IconButton
        icon={<IconCloseOutlineRegular size={14} />}
        label={`${t('action.remove')}: ${feed.title}`}
        small
        className="gf-rail-x"
        onClick={function () { onCreating(null); onRemove(feed.id) }}
      />
    </>
  )
}

function FeedRow({
  feed, count, on, pending, creating, busy, t, controller, folders, onPick,
  onConfirmRemove, onCancelRemove, onCreating, onCreateFolder, onNewFolder, onRemove,
}: {
  feed: Feed
  count: number
  on: boolean
  pending: boolean
  creating: MoveForm | null
  busy: Record<string, boolean>
  t: Translate
  controller: Controller
  folders: readonly string[]
  onPick: (id: string) => void
  onConfirmRemove: (id: string) => void
  onCancelRemove: () => void
  onCreating: (next: MoveForm | null) => void
  onCreateFolder: (id: string, value: string) => void
  onNewFolder: (id: string) => void
  onRemove: (id: string) => void
}) {
  const nameRef = useRef<HTMLInputElement>(null)
  /** The field the reader is typing a folder name into holds the keyboard. */
  useEffect(function () {
    if (creating && creating.id === feed.id) nameRef.current?.focus()
  }, [creating, feed.id])

  if (pending) {
    return (
      <ConfirmRow
        busy={busy.remove}
        t={t}
        onConfirm={function () { onConfirmRemove(feed.id) }}
        onCancel={onCancelRemove}
      />
    )
  }

  if (creating && creating.id === feed.id) {
    return (
      <MoveForm
        feed={feed}
        value={creating.value}
        busy={busy.folder}
        t={t}
        onChange={function (value) { onCreating({ id: feed.id, value: value }) }}
        onSubmit={function () { onCreateFolder(feed.id, creating.value) }}
        onCancel={function () { onCreating(null) }}
      />
    )
  }

  return (
    <div className={`gf-feed${on ? ' on' : ''}${feed.error ? ' error' : ''}`}>
      <button
        type="button"
        className="gf-feed-main"
        title={feed.error || feed.url || ''}
        onClick={function () { onPick(feed.id) }}
      >
        <span className="name">{feed.title}</span>
        {feed.error
          ? <span className="gf-danger" title={feed.error}><IconWarningOutlineRegular size={12} /></span>
          : null}
      </button>
      <span className="count">{count ? String(count) : ''}</span>
      <FeedActions
        feed={feed}
        count={count}
        t={t}
        controller={controller}
        folders={folders}
        onCreating={onCreating}
        onNewFolder={onNewFolder}
        onRemove={onRemove}
      />
      <IconButton
        icon={<IconCloseOutlineRegular size={14} />}
        label={`${t('action.remove')}: ${feed.title}`}
        small
        className="gf-rail-x"
        onClick={function () { onCreating(null); onRemove(feed.id) }}
      />
    </div>
  )
}

export function FolderBlock({
  name, unread, open, feeds, counts, selected, busy, pendingRemove, creating, t, controller, folders,
  onPick, onConfirmRemove, onCancelRemove, onCreating, onCreateFolder, onNewFolder, onRemove,
}: {
  name: string
  unread: number
  open: boolean
  feeds: readonly Feed[]
  counts: Map<string, number>
  selected: string | null
  busy: Record<string, boolean>
  pendingRemove: string | null
  creating: MoveForm | null
  t: Translate
  controller: Controller
  folders: readonly string[]
  onPick: (id: string) => void
  onConfirmRemove: (id: string) => void
  onCancelRemove: () => void
  onCreating: (next: MoveForm | null) => void
  onCreateFolder: (id: string, value: string) => void
  onNewFolder: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="gf-folder">
      <FolderHead name={name} unread={unread} open={open} t={t} controller={controller} />
      {open
        ? feeds.map(function (feed) {
          return (
            <FeedRow
              key={feed.id}
              feed={feed}
              count={counts.get(feed.id) || 0}
              on={selected === feed.id}
              pending={pendingRemove === feed.id}
              creating={creating}
              busy={busy}
              t={t}
              controller={controller}
              folders={folders}
              onPick={onPick}
              onConfirmRemove={onConfirmRemove}
              onCancelRemove={onCancelRemove}
              onCreating={onCreating}
              onCreateFolder={onCreateFolder}
              onNewFolder={onNewFolder}
              onRemove={onRemove}
            />
          )
        })
        : null}
    </div>
  )
}
