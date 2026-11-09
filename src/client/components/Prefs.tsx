/** The display-preference panel: three switches and the grouping chips. */

import type { ReactNode } from '../react.js'
import { Pill, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientState, Controller } from '../types.js'
import type { Translate } from '../locales.js'

function prefRow(label: string, control: ReactNode) {
  return (
    <div className="gf-prefrow">
      <span className="gf-prefrow-label">{label}</span>
      {control}
    </div>
  )
}

export function DisplayPrefs({ state, controller, t }: {
  state: ClientState
  controller: Controller
  t: Translate
}) {
  const groupBy = state.groupBy || state.reader.groupBy || 'none'
  const hideEmpty = state.hideEmpty === null ? state.reader.hideEmptyFeeds : state.hideEmpty
  const markOnScroll = state.markOnScroll === null ? state.reader.markReadOnScroll : state.markOnScroll
  const showDigest = state.showDigest === null ? true : state.showDigest
  const modes: Array<[string, string]> = [
    ['none', 'pref.none'],
    ['folder', 'pref.folder'],
    ['feed', 'pref.feed'],
  ]
  return (
    <>
      <div className="gf-prefgroup">
        <div className="gf-prefgroup-label">{t('pref.display')}</div>
        {prefRow(t('pref.hideEmpty'), (
          <Switch
            checked={hideEmpty}
            label={t('pref.hideEmpty')}
            onChange={function (value) { controller.setHideEmpty(value) }}
          />
        ))}
        {prefRow(t('pref.markOnScroll'), (
          <Switch
            checked={markOnScroll}
            label={t('pref.markOnScroll')}
            onChange={function (value) { controller.setMarkOnScroll(value) }}
          />
        ))}
        {prefRow(t('pref.showDigest'), (
          <Switch
            checked={showDigest}
            label={t('pref.showDigest')}
            onChange={function (value) { controller.setShowDigest(value) }}
          />
        ))}
      </div>
      <div className="gf-prefgroup">
        <div className="gf-prefgroup-label">{t('pref.groupBy')}</div>
        <div className="gf-pills">
          {modes.map(function (entry) {
            return (
              <Pill
                key={entry[0]}
                active={groupBy === entry[0]}
                aria-pressed={groupBy === entry[0]}
                onClick={function () { controller.setGroupBy(entry[0]) }}
              >
                {t(entry[1])}
              </Pill>
            )
          })}
        </div>
      </div>
    </>
  )
}
