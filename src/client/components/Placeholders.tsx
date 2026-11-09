/** What a surface shows when it has nothing to show, or could not load. */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientState, Controller } from '../types.js'
import type { Translate } from '../locales.js'
import { IconRss } from '../icons.js'
import { EmptyState } from './Controls.js'

export function ErrorState({ state, controller, t }: {
  state: ClientState
  controller: Controller
  t: Translate
}) {
  return (
    <EmptyState
      icon={<IconRss size={28} />}
      title={t('error.title')}
      action={(
        <Button
          variant="primary"
          size="sm"
          onClick={function () { controller.reconnect() }}
        >
          {t('action.retry')}
        </Button>
      )}
    >
      <p className="gf-placeholder-hint error">{state.error}</p>
      {state.repo ? <p className="gf-placeholder-hint">{state.repo}</p> : null}
    </EmptyState>
  )
}

export function EmptyArticle({ t }: { t: Translate }) {
  // The list bar already states the counts; this pane only needs to say what to
  // do next.
  return (
    <EmptyState icon={<IconRss size={28} />} title={t('page.title')}>
      <p className="gf-placeholder-hint">{t('empty.articleHint')}</p>
    </EmptyState>
  )
}
