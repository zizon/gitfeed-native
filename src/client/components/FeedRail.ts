/** Feed folders, subscriptions, and the add/unsubscribe controls. */

import { h, useId, useMemo, useState } from "../react.js";
import { Chevron } from "../icons.js";
import type { Feed } from "../../shared/types.js";
import type { FeedRailProps } from "../types.js";

export function FeedRail({ state, controller, t, compact, onPick }: FeedRailProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const listId = useId();

  const grouped = useMemo(function () {
    const counts = new Map<string, number>();
    let total = 0;
    for (const item of state.items) {
      if (state.read.has(item.id)) continue;
      counts.set(item.feed, (counts.get(item.feed) || 0) + 1);
      total += 1;
    }
    const groups = new Map<string, Feed[]>();
    for (const feed of state.feeds) {
      const key = feed.folder || t("feed.uncategorized");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(feed);
    }
    for (const list of groups.values()) {
      list.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    }
    return {
      counts: counts,
      total: total,
      groups: Array.from(groups.entries()).sort(function (a, b) { return a[0].localeCompare(b[0]); })
    };
  }, [state.items, state.feeds, state.read, t]);

  const hideEmpty = state.hideEmpty === null ? !!state.reader.hideEmptyFeeds : !!state.hideEmpty;
  const hiding = hideEmpty && state.filter === "unread";
  const folders = state.feeds.map(function (feed) { return feed.folder; }).filter(Boolean);

  function pick(id: string | null) {
    controller.selectFeed(id);
    if (onPick) onPick();
  }

  async function submitAdd(event: any) {
    event.preventDefault();
    const value = url.trim();
    if (!value) return;
    const ok = await controller.addFeed(value, folder);
    if (ok) {
      setUrl("");
      setFolder("");
      setAddOpen(false);
    }
  }

  const rows: any[] = [h("div", {
    key: "all",
    className: "gf-feed" + (state.feedId ? "" : " on"),
    role: "button",
    tabIndex: 0,
    onClick: function () { pick(null); },
    onKeyDown: function (event: any) { if (event.key === "Enter" || event.key === " ") pick(null); }
  },
  h("span", { className: "name" }, t("feed.all")),
  h("span", { className: "count" }, String(grouped.total || "")))];

  rows.push(h("div", {
    key: "add",
    className: "gf-feed gf-addbtn",
    role: "button",
    tabIndex: 0,
    onClick: function () { setAddOpen(!addOpen); },
    onKeyDown: function (event: any) { if (event.key === "Enter" || event.key === " ") setAddOpen(!addOpen); }
  }, h("span", { className: "name" }, "＋ " + t("action.addFeed"))));

  if (addOpen) {
    rows.push(h("form", { key: "form", className: "gf-addform", onSubmit: submitAdd },
      h("input", {
        className: "gf-input", type: "url", value: url, required: true,
        placeholder: "https://example.com/feed.xml", "aria-label": t("action.addFeed"),
        autoComplete: "off", spellCheck: false,
        onChange: function (event: any) { setUrl(event.target.value); }
      }),
      h("input", {
        className: "gf-input", type: "text", value: folder,
        placeholder: t("pref.folder"), "aria-label": t("pref.folder"),
        list: listId, autoComplete: "off",
        onChange: function (event: any) { setFolder(event.target.value); }
      }),
      h("datalist", { id: listId }, Array.from(new Set(folders)).map(function (name) {
        return h("option", { key: name, value: name });
      })),
      h("div", { className: "gf-addrow" },
        h("button", { type: "submit", className: "gf-btn primary", disabled: !!state.busy.add },
          state.busy.add ? t("action.adding") : t("action.add")),
        h("button", { type: "button", className: "gf-btn", onClick: function () { setAddOpen(false); } }, t("action.cancel")))));
  }

  for (const entry of grouped.groups) {
    const name = entry[0];
    const feeds = entry[1];
    let unread = 0;
    for (const feed of feeds) unread += grouped.counts.get(feed.id) || 0;
    if (hiding && unread === 0) continue;
    const open = name in state.folderOpen ? !!state.folderOpen[name] : unread > 0;
    const children: any[] = [];
    for (const feed of feeds) {
      const count = grouped.counts.get(feed.id) || 0;
      if (hiding && count === 0) continue;
      if (pendingRemove === feed.id) {
        children.push(h("div", { key: feed.id, className: "gf-feed gf-confirm" },
          h("span", { className: "name" }, t("confirm.unsubscribe")),
          h("button", {
            type: "button", className: "gf-linkbtn danger", disabled: !!state.busy.remove,
            onClick: async function () {
              const ok = await controller.removeFeed(feed.id);
              setPendingRemove(null);
              if (ok && onPick) onPick();
            }
          }, t("action.remove")),
          h("button", { type: "button", className: "gf-linkbtn", onClick: function () { setPendingRemove(null); } }, t("action.cancel"))));
        continue;
      }
      children.push(h("div", {
        key: feed.id,
        className: "gf-feed" + (state.feedId === feed.id ? " on" : "") + (feed.error ? " error" : ""),
        role: "button",
        tabIndex: 0,
        title: feed.error || feed.url || "",
        onClick: function () { pick(feed.id); },
        onKeyDown: function (event: any) { if (event.key === "Enter" || event.key === " ") pick(feed.id); }
      },
      h("span", { className: "name" }, feed.title),
      feed.error ? h("span", { className: "gf-dot-error", title: feed.error }, "!") : null,
      h("span", { className: "count" }, String(count || "")),
      h("button", {
        type: "button", className: "gf-feed-x", title: t("action.remove"),
        "aria-label": t("action.remove") + ": " + feed.title,
        onClick: function (event: any) { event.stopPropagation(); setPendingRemove(feed.id); }
      }, "×")));
    }
    rows.push(h("div", { key: "folder:" + name, className: "gf-folder" },
      h("div", {
        className: "gf-folder-head",
        role: "button",
        tabIndex: 0,
        "aria-expanded": open,
        onClick: function () { controller.setFolderOpen(name, !open); },
        onKeyDown: function (event: any) { if (event.key === "Enter" || event.key === " ") controller.setFolderOpen(name, !open); }
      },
      h(Chevron, { open: open }),
      h("span", { className: "gf-folder-name" }, name),
      h("span", { className: "count" }, String(unread || ""))),
      open ? children : null));
  }

  if (!state.feeds.length && !addOpen) {
    rows.push(h("div", { key: "empty", className: "gf-rail-empty" }, t("empty.rail")));
  }

  return h("div", { className: "gf-feedrail" + (compact ? " compact" : "") },
    h("div", { className: "gf-rail-head" },
      h("span", { className: "gf-rail-title" }, t("rail.guideTitle")),
      h("button", {
        type: "button", className: "gf-icon-btn", title: t("action.addFeed"),
        "aria-label": t("action.addFeed"), onClick: function () { setAddOpen(!addOpen); }
      }, "＋")),
    h("div", { className: "gf-feedlist" }, rows));
}
