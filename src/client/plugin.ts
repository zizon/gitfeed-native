/** Client plugin registration: reader surfaces, locale, and styles. */

import { NS, TAB_ID, TAB_KIND } from './constants.js'
import { createController } from './controller.js'
import { createPrefs } from './prefs.js'
import { CSS } from './styles.js'
import { DICTS } from './locales.js'
import type { Translate } from './locales.js'
import { GitfeedPage } from './components/GitfeedPage.js'
import { GitfeedRail } from './components/GitfeedRail.js'
import { HeaderButton, RailTitle, SidebarIcon } from './components/Launchers.js'
import { IconRss } from './icons.js'

interface SlotRegistration {
  name: string
  key?: string
  id?: string
  order?: number
  locale?: string
  label?: () => string
  inject?: () => Record<string, unknown>
}

interface Slots {
  inject(name: string, callback: () => () => void): void
  register(options: SlotRegistration, component: unknown): () => void
}

interface Locale {
  bind(namespace: string): Translate
  register(namespace: string, dictionaries: Record<string, unknown>): () => void
}

interface SidebarRightTabs {
  register(definition: Record<string, unknown>): () => void
}

interface SidebarRight {
  openTab(kind: string): void
}

export interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): void
  slots: Slots
  locale: Locale
  sidebarRightTabs: SidebarRightTabs
  sidebarRight: SidebarRight
}

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  const controller = createController(t, createPrefs())

  ctx.effect(function () { return ctx.locale.register(NS, DICTS) }, 'gitfeed: dictionaries')
  ctx.effect(function () {
    const style = document.createElement('style')
    style.dataset.plugin = 'gitfeed'
    style.textContent = CSS
    document.head.append(style)
    return function () { style.remove() }
  }, 'gitfeed: styles')
  ctx.effect(function () { return function () { controller.dispose() } }, 'gitfeed: controller')

  ctx.effect(function () {
    return ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: TAB_KIND,
      priority: 'extension',
      title: function () { return t('rail.title') },
      guide: [{
        id: 'feeds',
        order: 30,
        title: function () { return t('rail.guideTitle') },
        description: function () { return t('rail.guideDescription') },
        icon: IconRss,
      }],
    })
  }, 'gitfeed: right-sidebar tab type')

  ctx.slots.inject('sidebar.right.pane.tab', function () {
    return ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
      inject: function () { return { controller: controller, hooks: { reader: controller.reader } } },
    }, GitfeedRail)
  })

  ctx.slots.inject('sidebar.right.pane.tab.title', function () {
    return ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: TAB_ID,
      locale: NS,
    }, RailTitle)
  })

  ctx.slots.inject('conversation.session.header.utilities', function () {
    return ctx.slots.register({
      name: 'conversation.session.header.utilities',
      id: 'gitfeed-open',
      order: -4,
      locale: NS,
      inject: function () {
        return {
          open: function () {
            try {
              ctx.sidebarRight.openTab(TAB_KIND)
            } catch (err) {
              console.error('gitfeed: could not open the reader tab', err)
            }
          },
        }
      },
    }, HeaderButton)
  })

  ctx.slots.inject('main', function () {
    return ctx.slots.register({
      name: 'main',
      key: 'gitfeed',
      locale: NS,
      inject: function () { return { controller: controller, hooks: { reader: controller.reader } } },
    }, GitfeedPage)
  })

  ctx.slots.inject('sidebar.panellist', function () {
    return ctx.slots.register({
      name: 'sidebar.panellist',
      id: 'gitfeed',
      order: 90,
      locale: NS,
      label: function () { return t('panel') },
    }, SidebarIcon)
  })
}

export const plugin = {
  inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
  apply: apply,
}
