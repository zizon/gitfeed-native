/**
 * Local controls the shared atom set does not carry: the 28px icon button
 * recipe used by the Harness toolbars and sidebar panes, and the centered
 * empty state used by the list, the article pane, and the rail.
 */

import { h } from '../react.js'
import type { ReactNode, ReactMouseEvent } from '../react.js'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

export function IconButton({ icon, label, onClick, disabled, active, small, spin, expanded, hasPopup, danger, className }: {
  icon: ReactNode
  label: string
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  active?: boolean
  small?: boolean
  spin?: boolean
  expanded?: boolean
  hasPopup?: 'menu' | 'dialog'
  danger?: boolean
  className?: string
}) {
  const classes = [
    'gf-iconbtn',
    small ? 'sm' : '',
    active ? 'on' : '',
    spin ? 'spin' : '',
    danger ? 'danger' : '',
    className ?? '',
  ].filter(Boolean).join(' ')
  const button = h('button', {
    type: 'button',
    className: classes,
    'aria-label': label,
    'aria-haspopup': hasPopup,
    'aria-expanded': expanded === undefined ? undefined : expanded,
    disabled: !!disabled,
    onClick: onClick,
  }, icon)
  // A disabled control keeps its tooltip: the label explains why it is inert.
  return h(Tooltip, { label: label, side: 'bottom', delayMs: 500, disabled: false, children: button })
}

export function EmptyState({ icon, title, hint, action, className, children }: {
  icon?: ReactNode
  title?: string
  hint?: string
  action?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return h('div', { className: `gf-placeholder${className ? ` ${className}` : ''}` },
    icon ? h('div', { className: 'gf-placeholder-glyph' }, icon) : null,
    title ? h('div', { className: 'gf-placeholder-title' }, title) : null,
    hint ? h('p', { className: 'gf-placeholder-hint' }, hint) : null,
    children,
    action)
}
