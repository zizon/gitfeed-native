/** Names and layout constants shared by the reader modules. */

export const NS = "gitfeed";
export const PREFIX = "/gitfeed/api";
export const TAB_KIND = "gitfeed";
export const TAB_ID = "gitfeed-native";

export const LS = {
  hideEmpty: "gitfeed.hideEmpty",
  markOnScroll: "gitfeed.markOnScroll",
  groupBy: "gitfeed.groupBy",
  folders: "gitfeed.folders",
  railW: "gitfeed.railW",
  listW: "gitfeed.listW"
} as const;

export const DEFAULT_RAIL = 220;
export const DEFAULT_LIST = 430;
export const ROW_H = 46;
export const GROUP_H = 32;
