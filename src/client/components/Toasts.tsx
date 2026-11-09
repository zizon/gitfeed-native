/** The one transient banner: the shared Toast, with the mark undo as its action. */

import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Controller, Toast as ToastState } from '../types.js'
import type { Translate } from '../locales.js'

/**
 * One transient banner. The shared Toast owns its own lifetime and places
 * itself at the top of the page; the mark undo rides its inline action.
 */
export function Toasts({ toast, controller, t }: {
  toast: ToastState | null
  controller: Controller
  t: Translate
}) {
  if (!toast) return null
  const actions = toast.undo
    ? [{
      label: t('toast.undo'),
      onClick: function () {
        controller.dismissToast()
        controller.undoMark()
      },
    }]
    : undefined
  return (
    <Toast
      key={String(toast.at)}
      text={toast.text}
      icon={toast.error ? <IconWarningOutlineRegular size={16} /> : undefined}
      holdMs={toast.undo ? 7000 : 4000}
      actions={actions}
      onDone={function () { controller.dismissToast() }}
    />
  )
}
