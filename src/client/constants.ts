/** Names and layout constants shared by the reader modules. */

export const NS = 'gitfeed'
export const PREFIX = '/gitfeed/api'
export const TAB_KIND = 'gitfeed'
export const TAB_ID = 'gitfeed-native'

export const LS = {
  hideEmpty: 'gitfeed.hideEmpty',
  markOnScroll: 'gitfeed.markOnScroll',
  groupBy: 'gitfeed.groupBy',
  showDigest: 'gitfeed.showDigest',
  folders: 'gitfeed.folders',
  railW: 'gitfeed.railW',
  listW: 'gitfeed.listW',
} as const

export const DEFAULT_RAIL = 220
export const DEFAULT_LIST = 430
export const ROW_H = 66
/** Row height without the digest line, used when the summary pref is off. */
export const ROW_H_PLAIN = 46
export const GROUP_H = 32
export const DIGEST_CHARS = 240
