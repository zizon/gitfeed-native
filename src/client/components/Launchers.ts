/** Session-header launcher, sidebar entry icon, and right-tab title. */

import { h } from "../react.js";
import { IconRss } from "../icons.js";
import type { Translate } from "../locales.js";
import type { HeaderButtonProps, IconProps } from "../types.js";

export function HeaderButton({ open, t }: HeaderButtonProps) {
  return h("button", {
    type: "button",
    className: "gf-header-btn",
    title: t("rail.guideTitle"),
    "aria-label": t("rail.guideTitle"),
    onClick: open
  }, h(IconRss, { size: 16 }));
}

export function SidebarIcon({ size }: IconProps) {
  return h(IconRss, { size: size });
}

export function RailTitle({ t }: { t: Translate }) {
  return h("span", { className: "gf-tab-title" }, h(IconRss, { size: 14 }), t("rail.title"));
}
