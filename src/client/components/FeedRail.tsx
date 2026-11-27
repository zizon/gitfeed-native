/** Feed folders, subscriptions, and the add/unsubscribe controls. */

import { useEffect, useId, useMemo, useRef, useState } from '../react.js'
import type { ReactNode } from '../react.js'
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
import { folderNames, railGroups, sourceOrder } from '../derive.js'
import { FolderMenu } from './FolderMenu.js'
import type { FeedRailProps } from '../types.js'
import { EmptyState, IconButton } from './Controls.js'

export function FeedRail({ state, controller, t, compact, onPick }: FeedRailProps) {
  const [addOpen, setAddOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [folder, setFolder] = useState('')
  const [pendingRemove, setPendingRemove] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ id: string; value: string } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState<{ name: string; text: string } | null>(null)
  const [importReplace, setImportReplace] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const creatingId = creating ? creating.id : null
  const nameRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // "New folder…" asks for a name, so the field it asks with holds the
  // keyboard as soon as it appears; typing is the next thing that happens.
  useEffect(function () {
    if (creatingId) nameRef.current?.focus()
  }, [creatingId])

  // The order over sources is the one the load settled: the sources the reader
  // reads first, the rest by name. It is not recomputed from the read set, so
  // reading a source cannot re-rank the rail under the pointer.
  const interestOrder = state.interestOrder === null ? true : state.interestOrder
  const order = useMemo(function () {
    const scores = interestOrder ? state.ranks : null
    return sourceOrder(state.feeds, scores, t('feed.uncategorized'))
  }, [state.feeds, state.ranks, interestOrder, t])

  const grouped = useMemo(function () {
    const counts = new Map<string, number>()
    let total = 0
    for (const item of state.items) {
      if (state.read.has(item.id)) continue
      counts.set(item.feed, (counts.get(item.feed) || 0) + 1)
      total += 1
    }
    return {
      counts: counts,
      total: total,
      groups: railGroups(state.feeds, order, t('feed.uncategorized')),
    }
  }, [state.items, state.feeds, state.read, order, t])

  const hideEmpty = state.hideEmpty === null ? state.reader.hideEmptyFeeds : state.hideEmpty
  const hiding = hideEmpty && state.filter === 'unread'
  const folders = folderNames(state.feeds)

  // A folder opens or closes only when it first appears or when the reader
  // toggles it. Deriving the state from the live unread count made the list
  // collapse and expand on every background refresh while it was on screen.
  // A feed or folder that was on screen stays on screen until the scope
  // changes. Dropping rows the moment their last unread item is marked read
  // made the whole tree shift under the pointer mid-click.
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
   * @param {string} id feed id.
   * @param {string} value the name the reader typed.
   */
  async function createFolder(id: string, value: string) {
    const name = value.trim()
    if (!name) return
    const ok = await controller.setFeedFolder(id, name)
    if (ok) setCreating(null)
  }

  /**
   * Read the file the reader picked, and keep it until they choose a strategy.
   *
   * The document is read here rather than on submit so a file that cannot be
   * read is an empty picker, not a failed import.
   * @param event the file field's change.
   */
  async function pickImport(event: { target: { files?: FileList | null; value: string } }) {
    const file = event.target.files && event.target.files[0]
    // Clearing the field lets the reader pick the same file again after a
    // failed import; the element's own value would otherwise keep it.
    event.target.value = ''
    if (!file) return
    try {
      setImportFile({ name: file.name, text: await file.text() })
    } catch {
      setImportFile(null)
    }
  }

  function closeImport() {
    setImportOpen(false)
    setImportFile(null)
    setImportReplace(false)
  }

  async function submitImport() {
    if (!importFile) return
    const ok = await controller.importOpml(importFile.text, importReplace)
    if (ok) closeImport()
  }

  async function submitAdd(event: { preventDefault: () => void }) {
    event.preventDefault()
    const value = url.trim()
    if (!value) return
    const ok = await controller.addFeed(value, folder)
    if (ok) {
      setUrl('')
      setFolder('')
      setAddOpen(false)
    }
  }

  const rows: ReactNode[] = [
    <div key="all" className={`gf-feed${state.feedId ? '' : ' on'}`}>
      <button type="button" className="gf-feed-main" onClick={function () { pick(null) }}>
        <span className="name">{t('feed.all')}</span>
      </button>
      <span className="count">{grouped.total ? String(grouped.total) : ''}</span>
    </div>,
  ]

  rows.push(
    <div key="add" className="gf-feed gf-addbtn">
      <button type="button" className="gf-feed-main" onClick={function () { setAddOpen(!addOpen) }}>
        <IconPlusOutlineRegular size={14} />
        <span className="name">{t('action.addFeed')}</span>
      </button>
    </div>,
  )

  rows.push(
    <div key="import" className="gf-feed gf-addbtn">
      <button type="button" className="gf-feed-main" onClick={function () { if (importOpen) closeImport(); else setImportOpen(true) }}>
        <IconUploadOutlineRegular size={14} />
        <span className="name">{t('action.importOpml')}</span>
      </button>
    </div>,
  )

  if (importOpen) {
    rows.push(
      <div key="importform" className="gf-importform">
        <input
          ref={fileRef}
          className="gf-importfile"
          type="file"
          accept=".opml,.xml,application/xml,text/xml,text/x-opml"
          aria-label={t('import.choose')}
          onChange={function (event) { void pickImport(event) }}
        />
        <div className="gf-importrow">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={function () { if (fileRef.current) fileRef.current.click() }}
          >
            {t('import.choose')}
          </Button>
          <span className="gf-importname" title={importFile ? importFile.name : undefined}>
            {importFile ? importFile.name : t('import.none')}
          </span>
        </div>
        <div className="gf-importmode" role="group" aria-label={t('import.mode')}>
          <Button
            type="button"
            variant={importReplace ? 'ghost' : 'primary'}
            size="sm"
            onClick={function () { setImportReplace(false) }}
          >
            {t('import.merge')}
          </Button>
          <Button
            type="button"
            variant={importReplace ? 'primary' : 'ghost'}
            size="sm"
            onClick={function () { setImportReplace(true) }}
          >
            {t('import.replace')}
          </Button>
        </div>
        <p className="gf-importhint">{importReplace ? t('import.replaceHint') : t('import.mergeHint')}</p>
        <div className="gf-addrow">
          <Button type="button" variant="ghost" size="sm" onClick={function () { closeImport() }}>
            {t('action.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!importFile || state.busy.import}
            onClick={function () { void submitImport() }}
          >
            {state.busy.import ? t('import.importing') : t('import.do')}
          </Button>
        </div>
      </div>,
    )
  }

  if (addOpen) {
    rows.push(
      <form key="form" className="gf-addform" onSubmit={function (event) { void submitAdd(event) }}>
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
          <Button type="button" variant="ghost" size="sm" onClick={function () { setAddOpen(false) }}>
            {t('action.cancel')}
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={state.busy.add}>
            {state.busy.add ? t('action.adding') : t('action.add')}
          </Button>
        </div>
      </form>,
    )
  }

  for (const entry of grouped.groups) {
    const name = entry.name
    const feeds = entry.feeds
    let unread = 0
    for (const feed of feeds) unread += grouped.counts.get(feed.id) || 0
    if (hiding && unread === 0 && !seen.folders.has(name)) continue
    seen.folders.add(name)
    const open = folderOpenOf(name, unread)
    const children: ReactNode[] = []
    for (const feed of feeds) {
      const count = grouped.counts.get(feed.id) || 0
      if (hiding && count === 0 && !seen.feeds.has(feed.id)) continue
      seen.feeds.add(feed.id)
      if (pendingRemove === feed.id) {
        children.push(
          <div key={feed.id} className="gf-feed gf-confirm">
            <span className="name">{t('confirm.unsubscribe')}</span>
            <Button
              variant="ghost"
              size="sm"
              className="gf-danger"
              disabled={state.busy.remove}
              onClick={function () { void confirmRemove(feed.id) }}
            >
              {t('action.remove')}
            </Button>
            <Button variant="ghost" size="sm" onClick={function () { setPendingRemove(null) }}>
              {t('action.cancel')}
            </Button>
          </div>,
        )
        continue
      }
      if (creating !== null && creating.id === feed.id) {
        children.push(
          <form
            key={feed.id}
            className="gf-moveform"
            onSubmit={function (event) { event.preventDefault(); void createFolder(feed.id, creating.value) }}
          >
            <span className="gf-moveform-name" title={feed.title}>
              {t('action.newFolderTitle', { name: feed.title })}
            </span>
            <Input
              ref={nameRef}
              className="gf-addinput"
              type="text"
              value={creating.value}
              placeholder={t('pref.folder')}
              aria-label={t('action.newFolder')}
              autoComplete="off"
              spellCheck={false}
              onChange={function (event) { setCreating({ id: feed.id, value: event.target.value }) }}
            />
            <div className="gf-addrow">
              <Button type="button" variant="ghost" size="sm" onClick={function () { setCreating(null) }}>
                {t('action.cancel')}
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={state.busy.folder || !creating.value.trim()}>
                {t('action.move')}
              </Button>
            </div>
          </form>,
        )
        continue
      }
      children.push(
        <div
          key={feed.id}
          className={`gf-feed${state.feedId === feed.id ? ' on' : ''}${feed.error ? ' error' : ''}`}
        >
          <button
            type="button"
            className="gf-feed-main"
            title={feed.error || feed.url || ''}
            onClick={function () { pick(feed.id) }}
          >
            <span className="name">{feed.title}</span>
            {feed.error
              ? <span className="gf-danger" title={feed.error}><IconWarningOutlineRegular size={12} /></span>
              : null}
          </button>
          <span className="count">{count ? String(count) : ''}</span>
          <FolderMenu
            folder={feed.folder}
            folders={folders}
            label={t('action.moveFolder')}
            t={t}
            allowNew
            onMove={function (name) {
              setCreating(null)
              void controller.setFeedFolder(feed.id, name)
            }}
            onNew={function () {
              setPendingRemove(null)
              setCreating({ id: feed.id, value: '' })
            }}
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
            onClick={function () { setCreating(null); setPendingRemove(feed.id) }}
          />
        </div>,
      )
    }
    rows.push(
      <div key={`folder:${name}`} className="gf-folder">
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
        {open ? children : null}
      </div>,
    )
  }

  if (!state.feeds.length && !addOpen) {
    rows.push(<EmptyState key="empty" className="compact" hint={t('empty.rail')} />)
  }

  // One "Add feed" entry: the row in the list, which carries its own label.
  return (
    <div className={`gf-feedrail${compact ? ' compact' : ''}`}>
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
      <div className="gf-feedlist">{rows}</div>
      <datalist id={listId}>
        {Array.from(new Set(folders)).sort().map(function (name) {
          return <option key={name} value={name} />
        })}
      </datalist>
    </div>
  )
}
