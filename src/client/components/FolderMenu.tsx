/**
 * The folder picker: the folders the reader already has, as rows, and — where
 * naming one fits — the way to name a new one.
 *
 * It is a menu rather than a text field on purpose. A folder is picked from
 * the list that exists, in one click; the current one is marked and cannot be
 * picked again; and a new name is its own row, so "pick" and "create" never
 * look like the same control.
 */

import { useState } from 'react'
import { IconPlusOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconFolder } from '../icons.js'
import type { Translate } from '../locales.js'
import { IconButton } from './Controls.js'

/** The row id the "name a new folder" entry carries; not a folder name. */
const NEW = '\u0000new'
/** Every folder row's id is its name behind this prefix, so names stay free-form. */
const FOLDER = 'f:'

export interface FolderMenuProps {
  /** The folder the source is in now, as `feeds.json` stores it. */
  folder: string | null
  /** Every folder name in use, from `folderNames`. */
  folders: readonly string[]
  /** The menu's heading, and the trigger's label unless `title` says more. */
  label: string
  /** The trigger's own label, e.g. which source it would move. */
  title?: string
  t: Translate
  /** Whether the menu offers to name a new folder. */
  allowNew?: boolean
  side?: 'bottom' | 'top' | 'right'
  align?: 'start' | 'end'
  /** Move the source to this folder. */
  onMove: (folder: string) => void
  /** Ask the caller for a new name: naming a folder needs a field, not a row. */
  onNew?: () => void
}

export function FolderMenu(props: FolderMenuProps) {
  const [open, setOpen] = useState(false)
  const t = props.t
  // The stored name, not the label a folderless source is grouped under: the
  // rows below are the names a pick writes back.
  const current = props.folder || ''
  const items: MenuEntry[] = [{ type: 'label', id: 'head', text: props.label }]
  for (const name of props.folders) {
    items.push({ id: `${FOLDER}${name}`, label: name, disabled: name === current })
  }
  const canCreate = props.allowNew === true && typeof props.onNew === 'function'
  if (canCreate) {
    items.push({ type: 'separator', id: 'sep' })
    items.push({
      id: NEW,
      label: t('action.newFolder'),
      icon: <IconPlusOutlineRegular size={14} />,
    })
  }
  function select(id: string) {
    setOpen(false)
    if (id === NEW) {
      if (props.onNew) props.onNew()
      return
    }
    const name = id.slice(FOLDER.length)
    if (name !== current) props.onMove(name)
  }
  return (
    <Menu
      open={open}
      className="gf-foldermenu"
      anchor={(
        <IconButton
          icon={<IconFolder size={14} />}
          label={props.title || props.label}
          small
          hasPopup="menu"
          expanded={open}
          onClick={function (event) {
            // The row under the trigger selects the source; the trigger is an
            // action on that row, not a way into it.
            event.stopPropagation()
            setOpen(!open)
          }}
        />
      )}
      items={items}
      selectedId={`${FOLDER}${current}`}
      onSelect={select}
      onClose={function () { setOpen(false) }}
      side={props.side || 'bottom'}
      align={props.align || 'start'}
      // The trigger sits in a scrolling list (and, in the Sidebar, inside the
      // feeds popover); an in-place list would be clipped by both.
      portal
      dense
    />
  )
}
