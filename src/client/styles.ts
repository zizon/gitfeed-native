/**
 * Reader layout and the few surfaces the shared atoms do not cover.
 *
 * Controls (buttons, inputs, menus, switches, toasts, icons) come from
 * `@deepseek-ai/dsh-client-ui-primitives`; this sheet only carries the reader's
 * own geometry and is written against the documented `--dsw-*` tokens. It is
 * three sheets joined in the order the page draws them.
 */

import { SHELL } from './styles/shell.js'
import { PANES } from './styles/panes.js'
import { LIST } from './styles/list.js'

export const CSS = [SHELL, PANES, LIST].join('')
