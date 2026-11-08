/** The compact reader that lives in the right Sidebar. */

import { h, useRef, useState } from "../react.js";
import { Chevron } from "../icons.js";
import { useElementWidth, useKeyboard, useMount, useOutsideClose, useReader } from "../hooks.js";
import { tf } from "../locales.js";
import type { ClientState, GitfeedRailProps } from "../types.js";
import type { Controller } from "../types.js";
import type { Translate } from "../locales.js";
import { Article } from "./Article.js";
import { FeedRail } from "./FeedRail.js";
import { ItemList } from "./ItemList.js";
import { DisplayPrefs, EmptyArticle, ErrorState, FilterTabs, SearchBox, Toasts } from "./Shared.js";

function RailMenu({ state, controller, t, onClose }: {
  state: ClientState;
  controller: Controller;
  t: Translate;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, true, onClose);
  return h("div", { className: "gf-menu gf-rail-menu", ref: ref },
    h(DisplayPrefs, { state: state, controller: controller, t: t }),
    h("div", { className: "gf-menu-sep" }),
    h("div", { className: "gf-menu-label" }, t("menu.actions")),
    h("button", {
      type: "button", className: "gf-menu-row", disabled: !!state.busy.fetch,
      onClick: function () { controller.runAction("fetch"); onClose(); }
    }, state.busy.fetch ? t("status.running") : t("action.fetch")),
    h("button", {
      type: "button", className: "gf-menu-row", disabled: !!state.busy.pull || !state.allowGit || !state.git || !state.git.repo,
      onClick: function () { controller.runAction("pull"); onClose(); }
    }, t("action.pull")),
    h("button", {
      type: "button", className: "gf-menu-row", disabled: !!state.busy.sync || !state.allowGit || !state.git || !state.git.repo,
      onClick: function () { controller.runAction("sync"); onClose(); }
    }, t("action.sync")),
    h("div", { className: "gf-menu-sep" }),
    h("div", { className: "gf-menu-label" }, t("menu.repo")),
    h("div", { className: "gf-menu-repo" }, state.repo || "~"),
    state.git && state.git.repo === false
      ? h("div", { className: "gf-menu-hint" }, t("repo.hintLocal"))
      : null);
}

export function GitfeedRail({ controller, t, useTabInfo }: GitfeedRailProps) {
  const state = useReader(controller);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [feedsOpen, setFeedsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const width = useElementWidth(rootRef);
  const wide = width >= 680;
  const tabInfo = typeof useTabInfo === "function" ? useTabInfo() : null;
  const visible = !tabInfo || !tabInfo.tab || tabInfo.tab.visible !== false;
  useMount(controller);
  useKeyboard(controller, searchRef, rootRef, visible);

  const feedLabel = state.feedId ? controller.feedTitle(state.feedId) : t("feed.all");

  return h("div", { className: "gf gf-railpage", ref: rootRef },
    h("div", { className: "gf-rail-bar" },
      h("button", {
        type: "button", className: "gf-feed-trigger", "aria-haspopup": "dialog", "aria-expanded": feedsOpen,
        onClick: function () { setFeedsOpen(!feedsOpen); setMenuOpen(false); }
      },
      h("span", { className: "name" }, feedLabel),
      h(Chevron, { open: feedsOpen })),
      h("button", {
        type: "button", className: "gf-icon-btn", title: t("action.fetch"), "aria-label": t("action.fetch"),
        disabled: !!state.busy.fetch, onClick: function () { controller.runAction("fetch"); }
      }, "↻"),
      h("button", {
        type: "button", className: "gf-icon-btn", title: t("action.more"), "aria-label": t("action.more"),
        "aria-haspopup": "menu", "aria-expanded": menuOpen,
        onClick: function () { setMenuOpen(!menuOpen); setFeedsOpen(false); }
      }, "⋯")),
    h("div", { className: "gf-rail-bar2" },
      h(FilterTabs, { filter: state.filter, controller: controller, t: t, compact: true }),
      h(SearchBox, { controller: controller, t: t, value: state.query, inputRef: searchRef, compact: true })),
    state.loadError ? h("div", { className: "gf-banner" }, tf(t, "status.banner", { error: state.loadError })) : null,
    state.status === "error" && !state.items.length
      ? h(ErrorState, { state: state, controller: controller, t: t })
      : wide
        ? h("div", { className: "gf-wide" },
          h(ItemList, { state: state, controller: controller, t: t, wide: true }),
          h("div", { className: "gf-wide-article" },
            state.current ? h(Article, { state: state, controller: controller, t: t }) : h(EmptyArticle, { state: state, t: t })))
        : state.current
          ? h("div", { className: "gf-rail-article" }, h(Article, { state: state, controller: controller, t: t, compact: true }))
          : h(ItemList, { state: state, controller: controller, t: t, wide: true }),
    feedsOpen ? h("div", { className: "gf-popover gf-feedpop" },
      h(FeedRail, {
        state: state, controller: controller, t: t, compact: true,
        onPick: function () { setFeedsOpen(false); }
      })) : null,
    menuOpen ? h(RailMenu, {
      state: state, controller: controller, t: t,
      onClose: function () { setMenuOpen(false); }
    }) : null,
    h(Toasts, { toast: state.toast }));
}
