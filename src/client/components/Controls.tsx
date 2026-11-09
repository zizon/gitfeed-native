/**
 * Local controls the shared atom set does not carry: the 28px icon button
 * recipe used by the Harness toolbars and sidebar panes, and the centered
 * empty state used by the list, the article pane, and the rail.
 */

import type { ReactNode, ReactMouseEvent } from '../react.js'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

export function IconButton({ icon, label, onClick, disabled, active, small, spin, expanded, hasPopup, danger, tabIndex, className }: {
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
  /** Override the tab stop, e.g. -1 for a button inside a list of rows. */
  tabIndex?: number
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
  // A disabled control keeps its tooltip: the label explains why it is inert.
  return (
    <Tooltip label={label} side="bottom" delayMs={500} disabled={false}>
      <button
        type="button"
        className={classes}
        aria-label={label}
        aria-haspopup={hasPopup}
        aria-expanded={expanded === undefined ? undefined : expanded}
        disabled={!!disabled}
        tabIndex={tabIndex}
        onClick={onClick}
      >
        {icon}
      </button>
    </Tooltip>
  )
}

export function EmptyState({ icon, title, hint, action, className, children }: {
  icon?: ReactNode
  title?: string
  hint?: string
  action?: ReactNode
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={`gf-placeholder${className ? ` ${className}` : ''}`}>
      {icon ? <div className="gf-placeholder-glyph">{icon}</div> : null}
      {title ? <div className="gf-placeholder-title">{title}</div> : null}
      {hint ? <p className="gf-placeholder-hint">{hint}</p> : null}
      {children}
      {action}
    </div>
  )
}
