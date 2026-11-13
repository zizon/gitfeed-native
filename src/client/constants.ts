/** Names and layout constants shared by the reader modules. */

export const NS = 'gitfeed'
export const PREFIX = '/gitfeed/api'
export const TAB_KIND = 'gitfeed'
export const TAB_ID = 'gitfeed-native'

export const DEFAULT_RAIL = 220
export const DEFAULT_LIST = 430
/** The stored range of a pane; a surface may offer less of it, never more. */
export const RAIL_MIN = 150
export const RAIL_MAX = 460
export const LIST_MIN = 260
export const LIST_MAX = 900
export const ROW_H = 66
/** Row height without the digest line, used when the summary pref is off. */
export const ROW_H_PLAIN = 46
export const GROUP_H = 32
export const DIGEST_CHARS = 240
/**
 * How close to zero the viewport still counts as being at the top of the list.
 * The top is the one place with no entry under its edge to hold, so the rules
 * that keep a rebuild from moving the reader start just below it.
 */
export const AT_TOP = 12
