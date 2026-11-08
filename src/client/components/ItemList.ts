/** Fixed-height virtualized item list with group headers and read-on-scroll. */

import { h, useCallback, useEffect, useMemo, useRef, useState } from "../react.js";
import type { Item } from "../../shared/types.js";
import { GROUP_H, ROW_H, ROW_H_PLAIN } from "../constants.js";
import { lowerBound, useOutsideClose } from "../hooks.js";
import { tf } from "../locales.js";
import type { ItemListProps } from "../types.js";
import { fmtTime } from "../util.js";

interface Group {
  key: string;
  label: string;
  items: Item[];
}

interface RowEntry {
  kind: "row";
  key: string;
  item: Item;
  h: number;
}

interface GroupEntry {
  kind: "group";
  key: string;
  group: Group;
  h: number;
}

type Entry = RowEntry | GroupEntry;

export function ItemList({ state, controller, t, wide }: ItemListProps) {
  const list = controller.getList();
  const groupBy = state.groupBy || state.reader.groupBy || "none";
  const markOnScroll = state.markOnScroll === null ? !!state.reader.markReadOnScroll : !!state.markOnScroll;
  const showDigest = state.showDigest === null ? true : !!state.showDigest;
  const rowH = showDigest ? ROW_H : ROW_H_PLAIN;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 24 });
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const raf = useRef(0);
  const lastKey = useRef("");
  const lastSelected = useRef<string | null>(null);
  /** Scroll offset the previous compute saw, to know what the viewport passed. */
  const lastTop = useRef(0);
  /** Scroll offset this surface moved to on its own, which must not mark anything. */
  const programmatic = useRef<number | null>(null);
  /** The scope menu for marking read; it shows its counts before acting. */
  const markRef = useRef<HTMLDivElement>(null);
  const [markOpen, setMarkOpen] = useState(false);
  /** Only the whole-library entry needs a second, differently placed click. */
  const [markArmed, setMarkArmed] = useState(false);
  function closeMark() {
    setMarkOpen(false);
    setMarkArmed(false);
  }
  useOutsideClose(markRef, markOpen, closeMark);

  /** Counts for the mark menu; recomputed when the list or the read set moves. */
  const counts = useMemo(function () {
    return controller.markCounts();
  }, [state.items, state.read, state.version, state.listEpoch, state.feedId, state.query, state.filter, controller]);

  const entries = useMemo<Entry[]>(function () {
    if (groupBy === "none") {
      return list.map(function (item) { return { kind: "row", key: item.id, item: item, h: rowH }; });
    }
    const groups = new Map<string, Group>();
    for (const item of list) {
      const key = groupBy === "feed" ? item.feed : controller.feedFolder(item.feed);
      if (!groups.has(key)) {
        groups.set(key, {
          key: key,
          label: groupBy === "feed" ? controller.feedTitle(item.feed) : key,
          items: []
        });
      }
      groups.get(key)!.items.push(item);
    }
    const ordered = Array.from(groups.values()).sort(function (a, b) {
      return b.items.length - a.items.length || a.label.localeCompare(b.label);
    });
    const out: Entry[] = [];
    for (const group of ordered) {
      out.push({ kind: "group", key: "group:" + group.key, group: group, h: GROUP_H });
      for (const item of group.items) out.push({ kind: "row", key: item.id, item: item, h: rowH });
    }
    return out;
  }, [list, groupBy, controller, state.feedMap, rowH]);

  const offsets = useMemo(function () {
    const out = new Array<number>(entries.length + 1);
    out[0] = 0;
    for (let i = 0; i < entries.length; i++) out[i + 1] = out[i] + entries[i].h;
    return out;
  }, [entries]);

  const itemIndex = useMemo(function () {
    const map = new Map<string, number>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.kind === "row") map.set(entry.item.id, i);
    }
    return map;
  }, [entries]);

  const total = offsets[entries.length] || 0;

  // Scroll position this surface wrote itself (a filter reset, revealing the
  // selected item) must not count as the reader scrolling past those rows.
  function scrollTo(el: HTMLDivElement, value: number) {
    el.scrollTop = value;
    programmatic.current = el.scrollTop;
  }

  const compute = useCallback(function () {
    const el = viewportRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const prevTop = lastTop.current;
    lastTop.current = top;
    const height = el.clientHeight || 600;
    const visibleStart = lowerBound(offsets, top);
    const visibleEnd = Math.min(entries.length, lowerBound(offsets, top + height) + 1);
    const start = Math.max(0, visibleStart - 4);
    const end = Math.min(entries.length, visibleEnd + 4);
    setRange(function (current) {
      return current.start === start && current.end === end ? current : { start: start, end: end };
    });
    let jumped = false;
    if (programmatic.current !== null) {
      jumped = Math.abs(programmatic.current - top) < 1;
      programmatic.current = null;
    }
    if (!markOnScroll || jumped) return;
    // Rows the viewport top passed on the way down are read, including the
    // ones a scrollbar drag skipped over without ever rendering them.
    if (top <= prevTop) return;
    const from = lowerBound(offsets, prevTop);
    const to = lowerBound(offsets, top);
    const markIds: string[] = [];
    for (let i = from; i < to; i++) {
      const entry = entries[i];
      if (entry && entry.kind === "row" && !state.read.has(entry.item.id)) markIds.push(entry.item.id);
    }
    if (markIds.length) controller.mark(markIds, true);
  }, [offsets, entries, markOnScroll, state.read, controller]);

  const onScroll = useCallback(function () {
    if (raf.current) return;
    raf.current = requestAnimationFrame(function () {
      raf.current = 0;
      compute();
    });
  }, [compute]);

  useEffect(function () {
    const key = groupBy + "\u0000" + state.query + "\u0000" + state.feedId;
    if (lastKey.current !== key) {
      lastKey.current = key;
      const el = viewportRef.current;
      if (el) scrollTo(el, 0);
    }
    compute();
  }, [compute, groupBy, state.query, state.feedId, state.version]);

  useEffect(function () {
    const el = viewportRef.current;
    if (!el) return;
    let alive = true;
    const observer = new ResizeObserver(function () { if (alive) compute(); });
    observer.observe(el);
    return function () {
      alive = false;
      observer.disconnect();
    };
  }, [compute]);

  // Reveal a newly selected item, but never move the viewport because the
  // background refresh rebuilt the entries: the user may be reading elsewhere
  // in the list while new items land.
  useEffect(function () {
    const id = state.current;
    if (!id) {
      lastSelected.current = null;
      return;
    }
    if (lastSelected.current === id) return;
    lastSelected.current = id;
    const index = itemIndex.get(id);
    if (index === undefined) return;
    const currentRange = rangeRef.current;
    if (index >= currentRange.start && index < currentRange.end) return;
    const el = viewportRef.current;
    if (el) scrollTo(el, Math.max(0, offsets[index] - 32));
  }, [state.current, itemIndex, offsets]);

  const slice = entries.slice(range.start, range.end);
  const top = offsets[range.start] || 0;
  const bottom = Math.max(0, total - (offsets[range.end] || total));

  const listRows = slice.map(function (entry) {
    if (entry.kind === "group") {
      const groupUnread = entry.group.items.filter(function (item) { return !state.read.has(item.id); }).length;
      return h("div", { key: entry.key, className: "gf-group" },
        h("span", { className: "gf-group-name" }, entry.group.label),
        h("span", { className: "gf-group-count" }, String(entry.group.items.length)),
        h("button", {
          type: "button",
          className: "gf-group-read",
          disabled: !groupUnread,
          title: t("action.markGroup"),
          onClick: function () { controller.markGroup(entry.group.key); }
        }, groupUnread ? tf(t, "action.markGroupCount", { n: groupUnread }) : t("action.markGroup")));
    }
    const item = entry.item;
    const unread = !state.read.has(item.id);
    const starred = state.starred.has(item.id);
    const digest = showDigest ? controller.digest(item) : "";
    return h("div", {
      key: entry.key,
      className: "gf-row" + (unread ? " unread" : "") + (state.current === item.id ? " active" : ""),
      role: "button",
      tabIndex: -1,
      "aria-current": state.current === item.id ? "true" : undefined,
      onClick: function () { controller.select(item.id); }
    },
    h("div", { className: "gf-row-title" },
      unread ? h("span", { className: "gf-dot", "aria-hidden": true }) : null,
      h("span", { className: "t" }, item.title || "(untitled)"),
      starred ? h("span", { className: "gf-star", title: t("action.unstar") }, "★") : null),
    h("div", { className: "gf-row-meta" },
      h("span", { className: "feed-name" }, controller.feedTitle(item.feed)),
      h("span", { className: "when" }, fmtTime(item.date))),
    digest ? h("div", { className: "gf-row-digest" }, digest) : null);
  });

  const count = list.length;
  const paneClass = "gf-listpane" + (wide ? " wide" : "") + (showDigest ? "" : " rows-plain");

  function markRow(label: string, n: number, run: () => void, extraClass?: string) {
    return h("button", {
      type: "button",
      className: "gf-menu-row" + (extraClass ? " " + extraClass : ""),
      disabled: !n,
      role: "menuitem",
      onClick: function () { closeMark(); run(); }
    },
    h("span", { className: "gf-menu-text" }, label),
    h("span", { className: "gf-menu-count" }, String(n)));
  }

  // Every scope names its own count, so the biggest action is never a
  // neighbour that looks like the smallest one.
  const markRows: any[] = [];
  if (counts.results > 0 || count > 0) {
    markRows.push(markRow(t("action.markResults"), counts.results, function () { controller.markAll(); }));
  }
  if (state.feedId && counts.source > 0) {
    markRows.push(markRow(t("action.markSource"), counts.source, function () { controller.markFeed(state.feedId as string); }));
  }
  if (state.feedId && counts.folderName && counts.folder > counts.source) {
    markRows.push(markRow(t("action.markFolder"), counts.folder, function () {
      if (counts.folderName) controller.markFolder(counts.folderName);
    }));
  }
  if (counts.all > 0 && counts.all !== counts.results) {
    markRows.push(h("div", { key: "sep", className: "gf-menu-sep" }));
    markRows.push(h("button", {
      type: "button",
      className: "gf-menu-row danger" + (markArmed ? " armed" : ""),
      role: "menuitem",
      onClick: function () {
        if (!markArmed) {
          setMarkArmed(true);
          return;
        }
        closeMark();
        controller.markEverything();
      }
    },
    h("span", { className: "gf-menu-text" },
      markArmed ? tf(t, "action.markAllConfirm", { n: counts.all }) : t("action.markEverything")),
    h("span", { className: "gf-menu-count" }, String(counts.all))));
  }

  const header = h("div", { className: "gf-listbar" },
    h("span", { className: "gf-count-label" }, tf(t, "items.count", { n: count })),
    h("div", { className: "gf-markwrap", ref: markRef },
      h("button", {
        type: "button", className: "gf-linkbtn", disabled: !counts.all && !count,
        "aria-haspopup": "menu", "aria-expanded": markOpen,
        onClick: function () {
          if (markOpen) closeMark();
          else { setMarkOpen(true); setMarkArmed(false); }
        }
      }, t("action.markMenu") + " ▾"),
      markOpen
        ? h("div", { className: "gf-menu gf-markmenu", role: "menu" }, markRows)
        : null));

  if (state.status === "loading" && !state.items.length) {
    return h("div", { className: paneClass }, header, h("div", { className: "gf-empty" }, t("status.loading")));
  }
  if (state.status === "error" && !state.items.length) {
    return h("div", { className: paneClass }, header,
      h("div", { className: "gf-empty" }, state.error || t("status.error")));
  }
  if (!count) {
    return h("div", { className: paneClass }, header,
      h("div", { className: "gf-empty" }, state.items.length ? t("empty.nothing") : t("empty.noItems")));
  }

  return h("div", { className: paneClass },
    header,
    h("div", { className: "gf-scroll", ref: viewportRef, onScroll: onScroll },
      h("div", { style: { height: top } }),
      listRows,
      h("div", { style: { height: bottom } })));
}
