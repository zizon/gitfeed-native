/** The compact reader that lives in the right Sidebar. */

import { h, useRef, useState } from "../react.js";
import { Chevron } from "../icons.js";
import { DEFAULT_LIST } from "../constants.js";
import { useElementWidth, useKeyboard, useMount, useOutsideClose, useReader } from "../hooks.js";
import { tf } from "../locales.js";
import { fmtIn, fmtTime } from "../util.js";
import type { ClientState, GitfeedRailProps } from "../types.js";
import type { Controller } from "../types.js";
import type { Translate } from "../locales.js";
import { clamp } from "../util.js";
import { Article } from "./Article.js";
import { FeedRail } from "./FeedRail.js";
import { ItemList } from "./ItemList.js";
import { DisplayPrefs, EmptyArticle, ErrorState, FilterTabs, RefreshState, SearchBox, Toasts } from "./Shared.js";

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
    h("div", { className: "gf-menu-label" }, t("menu.refresh")),
    h("div", { className: "gf-menu-repo" },
      state.localFetch && state.localFetch.enabled
        ? tf(t, "status.autoEvery", { n: Math.max(1, Math.round(state.localFetch.intervalMs / 60000)) })
          + (state.localFetch.nextDueAt
            ? " · " + tf(t, "status.nextIn", { age: fmtIn(state.localFetch.nextDueAt) })
            : "")
        : t("status.autoOff")),
    state.localFetch
      ? h("div", { className: "gf-menu-repo" },
        (state.localFetch.running ? t("status.running") : t("status.lastRefresh") + ": " + (state.localFetch.lastRunAt ? fmtTime(state.localFetch.lastRunAt) : t("status.never")))
        + (state.localFetch.last && !state.localFetch.running
          ? " · " + tf(t, "status.feedCount", { n: state.localFetch.last.feeds })
            + " · " + tf(t, "status.fetchLine", { fresh: state.localFetch.last.fresh, failed: state.localFetch.last.failed })
          : ""))
      : null,
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

  // The list keeps at least 320px for the article, so the stored width is
  // clamped to this Surface's own width instead of only to its global range.
  const wideListW = clamp(state.listW, 260, Math.max(260, width - 325));

  function startResize() {
    return function (event: any) {
      event.preventDefault();
      const startX = event.clientX;
      const start = wideListW;
      const total = rootRef.current ? rootRef.current.clientWidth : width;
      const max = Math.max(260, Math.min(900, total - 325));
      function move(moveEvent: any) {
        controller.setWidths({ listW: clamp(start + (moveEvent.clientX - startX), 260, max) });
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
  }

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
        type: "button",
        className: "gf-icon-btn" + (state.busy.fetch || (state.localFetch && state.localFetch.running) ? " spin" : ""),
        title: state.localFetch && state.localFetch.running ? t("status.running") : t("action.fetch"),
        "aria-label": t("action.fetch"),
        disabled: !!state.busy.fetch || !!(state.localFetch && state.localFetch.running),
        onClick: function () { controller.runAction("fetch"); }
      }, "↻"),
      h("button", {
        type: "button", className: "gf-icon-btn", title: t("action.more"), "aria-label": t("action.more"),
        "aria-haspopup": "menu", "aria-expanded": menuOpen,
        onClick: function () { setMenuOpen(!menuOpen); setFeedsOpen(false); }
      }, "⋯")),
    h("div", { className: "gf-rail-bar2" },
      h(FilterTabs, { filter: state.filter, controller: controller, t: t, compact: true }),
      h(SearchBox, { controller: controller, t: t, value: state.query, inputRef: searchRef, compact: true }),
      h(RefreshState, { state: state, t: t })),
    state.loadError ? h("div", { className: "gf-banner" }, tf(t, "status.banner", { error: state.loadError })) : null,
    state.status === "error" && !state.items.length
      ? h(ErrorState, { state: state, controller: controller, t: t })
      : wide
        ? h("div", {
          className: "gf-wide",
          style: { "--gf-list": wideListW + "px" } as any
        },
        h(ItemList, { state: state, controller: controller, t: t, wide: true }),
        h("div", {
          className: "gf-splitter", role: "separator", "aria-orientation": "vertical",
          title: t("action.resize"),
          onPointerDown: startResize(),
          onDoubleClick: function () { controller.setWidths({ listW: DEFAULT_LIST }); }
        }),
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
