/** Reader glyphs that the shared atom set does not carry, plus the folder chevron. */

import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from './types.js'

export function IconRss({ size }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size || 16}
      height={size || 16}
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <path
        d="M3.25 3.25h4.5A5 5 0 0 1 12.75 8.25v4.5h-2v-4.5a3 3 0 0 0-3-3h-4.5z"
        fill="currentColor"
      />
      <circle cx={4.6} cy={11.4} r={1.45} fill="currentColor" />
    </svg>
  )
}

/** Star mark for the list and the article actions; the atom set has no star glyph. */
export function IconStar({ filled, size }: IconProps & { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size || 14}
      height={size || 14}
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <path
        d="M8 2.2l1.79 3.63 4 .58-2.9 2.83.69 3.99L8 11.35l-3.58 1.88.69-3.99-2.9-2.83 4-.58z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.2}
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Unread state mark: a filled dot while unread, a ring once read. */
export function IconUnreadDot({ filled, size }: IconProps & { filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size || 14}
      height={size || 14}
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <circle
        cx={8}
        cy={8}
        r={4.2}
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? 'none' : 'currentColor'}
        strokeWidth={1.2}
      />
    </svg>
  )
}

/** Folder disclosure chevron; rotates in place, the shared glyph keeps the artwork. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <span className={`gf-chevron${open ? ' open' : ''}`} aria-hidden="true">
      <IconChevronRightOutlineRegular size={12} />
    </span>
  )
}
