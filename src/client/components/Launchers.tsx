/** Session-header launcher, sidebar entry icon, and right-tab title. */

import { IconRss } from '../icons.js'
import type { Translate } from '../locales.js'
import type { HeaderButtonProps, IconProps } from '../types.js'
import { IconButton } from './Controls.js'

export function HeaderButton({ open, t }: HeaderButtonProps) {
  return (
    <IconButton
      icon={<IconRss size={16} />}
      label={t('rail.guideTitle')}
      onClick={function () { open() }}
    />
  )
}

export function SidebarIcon({ size }: IconProps) {
  return <IconRss size={size} />
}

export function RailTitle({ t }: { t: Translate }) {
  return (
    <span className="gf-tab-title">
      <IconRss size={14} />
      {t('rail.title')}
    </span>
  )
}
