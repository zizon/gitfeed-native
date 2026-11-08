/**
 * Runtime types for the shared client atoms.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is seeded into the Harness browser
 * module table, so this bundle requires it at runtime instead of shipping it
 * (`build.mjs` marks it external). The package is not published to npm, so the
 * build cannot read its shipped declarations; this file mirrors the props of
 * the components the reader uses, and is the one place to update when that
 * surface changes.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement, ReactNode, Ref } from 'react'

  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  export interface ButtonProps {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string
    disabled?: boolean
    title?: string
    type?: 'button' | 'submit'
    onClick?: () => void
    'aria-label'?: string
    'aria-haspopup'?: 'menu' | 'dialog' | boolean
    'aria-expanded'?: boolean
  }

  export const Button: (props: ButtonProps) => ReactElement

  export interface PillProps {
    active?: boolean
    className?: string
    disabled?: boolean
    title?: string
    onClick?: () => void
    'aria-pressed'?: boolean
  }

  export const Pill: (props: PillProps) => ReactElement

  export interface InputProps {
    ref?: Ref<HTMLInputElement>
    icon?: ReactNode
    className?: string
    type?: string
    value?: string
    placeholder?: string
    disabled?: boolean
    required?: boolean
    spellCheck?: boolean
    autoComplete?: string
    list?: string
    'aria-label'?: string
    onChange?: (event: { target: { value: string } }) => void
  }

  export const Input: (props: InputProps) => ReactElement

  export interface SwitchProps {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
    className?: string
  }

  export const Switch: (props: SwitchProps) => ReactElement

  export interface TooltipProps {
    label: string
    side?: 'top' | 'bottom' | 'left' | 'right'
    delayMs?: number
    disabled?: boolean
    portal?: boolean
    maxWidth?: number
    children: ReactNode
  }

  export const Tooltip: (props: TooltipProps) => ReactElement

  export interface MenuSeparator {
    type: 'separator'
    id: string
  }

  export interface MenuLabel {
    type: 'label'
    id: string
    text: string
  }

  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    danger?: boolean
    icon?: ReactNode
    submenu?: readonly MenuEntry[]
  }

  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

  export interface MenuProps {
    open: boolean
    anchor: ReactNode
    items?: readonly MenuEntry[]
    children?: ReactNode
    footer?: readonly MenuEntry[]
    selectedId?: string
    selectedIds?: readonly string[]
    onSelect?: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    autoFocus?: boolean
    dense?: boolean
    compact?: boolean
    className?: string
    listClassName?: string
  }

  export const Menu: (props: MenuProps) => ReactElement

  export interface MenuItemButtonProps {
    disabled?: boolean
    disabledReason?: string
    danger?: boolean
    separatorBefore?: boolean
    onSelect: () => void
  }

  export const MenuItemButton: (props: MenuItemButtonProps) => ReactElement

  export interface MenuSurfaceProps {
    ref?: Ref<HTMLDivElement>
    className?: string
    compact?: boolean
    phase?: 'enter' | 'dismiss' | 'replace'
  }

  export const MenuSurface: (props: MenuSurfaceProps) => ReactElement

  export interface ToastAction {
    label: string
    prefix?: string
    onClick: () => void
  }

  export interface ToastProps {
    text: string
    icon?: ReactNode
    tone?: 'success'
    holdMs?: number
    actions?: readonly ToastAction[]
    onDone: () => void
  }

  export const Toast: (props: ToastProps) => ReactElement

  export interface IconProps {
    size?: number
    className?: string
  }

  export type Icon = (props: IconProps) => ReactElement

  export const IconSearchOutlineRegular: Icon
  export const IconCheckOutlineRegular: Icon
  export const IconCloseOutlineRegular: Icon
  export const IconChevronRightOutlineRegular: Icon
  export const IconChevronLeftOutlineRegular: Icon
  export const IconChevronDownOutlineRegular: Icon
  export const IconPlusOutlineRegular: Icon
  export const IconRefreshOutlineRegular: Icon
  export const IconDownloadOutlineRegular: Icon
  export const IconEllipsisOutlineRegular: Icon
  export const IconWarningOutlineRegular: Icon
  export const IconRightUpOutlineRegular: Icon
  export const IconSlidersTwoOutlineRegular: Icon
  export const IconTrashOutlineRegular: Icon
}
