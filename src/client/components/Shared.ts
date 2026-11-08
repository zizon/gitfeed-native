/** Small controls shared by the page, rail, and article surfaces. */

import { Fragment, h, useEffect, useRef, useState } from "../react.js";
import type { ClientState, Controller, Toast } from "../types.js";
import type { Translate } from "../locales.js";
import { tf } from "../locales.js";
import { IconRss } from "../icons.js";
import { fmtIn, fmtTime } from "../util.js";

export function FilterTabs({ filter, controller, t, compact }: {
  filter: ClientState["filter"];
  controller: Controller;
  t: Translate;
  compact?: boolean;
}) {
  const items: Array<[ClientState["filter"], string, string]> = [
    ["unread", "filter.unread", "u"],
    ["all", "filter.all", "a"],
    ["starred", "filter.starred", "s"]
  ];
  return h("div", { className: "gf-tabs" + (compact ? " compact" : ""), role: "tablist", "aria-label": t("filter.label") },
    items.map(function (entry) {
      return h("button", {
        key: entry[0],
        type: "button",
        role: "tab",
        "aria-selected": filter === entry[0],
        title: entry[2],
        className: "gf-tab" + (filter === entry[0] ? " on" : ""),
        onClick: function () { controller.setFilter(entry[0]); }
      }, t(entry[1]));
    }));
}

export function SearchBox({ controller, t, value, inputRef, compact }: {
  controller: Controller;
  t: Translate;
  value: string;
  inputRef: React.RefObject<HTMLInputElement>;
  compact?: boolean;
}) {
  const [text, setText] = useState(value);
  const timer = useRef(0);
  useEffect(function () { setText(value); }, [value]);
  useEffect(function () {
    return function () { clearTimeout(timer.current); };
  }, []);
  function onChange(event: any) {
    const next = event.target.value as string;
    setText(next);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(function () { controller.setQuery(next); }, 120);
  }
  return h("input", {
    ref: inputRef,
    className: "gf-search" + (compact ? " compact" : ""),
    type: "search",
    value: text,
    placeholder: t("search.placeholder"),
    "aria-label": t("search.placeholder"),
    spellCheck: false,
    autoComplete: "off",
    onChange: onChange
  });
}

export function Switch({ checked, onChange, label }: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return h("button", {
    type: "button",
    role: "switch",
    "aria-checked": checked ? "true" : "false",
    "aria-label": label,
    className: "gf-switch",
    onClick: function () { onChange(!checked); }
  });
}

export function DisplayPrefs({ state, controller, t }: {
  state: ClientState;
  controller: Controller;
  t: Translate;
}) {
  const groupBy = state.groupBy || state.reader.groupBy || "none";
  const hideEmpty = state.hideEmpty === null ? !!state.reader.hideEmptyFeeds : !!state.hideEmpty;
  const markOnScroll = state.markOnScroll === null ? !!state.reader.markReadOnScroll : !!state.markOnScroll;
  const showDigest = state.showDigest === null ? true : !!state.showDigest;
  return h(Fragment, null,
    h("div", { className: "gf-menu-label" }, t("pref.display")),
    h("div", { className: "gf-menu-row" },
      h(Switch, { checked: hideEmpty, onChange: function (value) { controller.setHideEmpty(value); }, label: t("pref.hideEmpty") }),
      h("span", { className: "gf-menu-text" }, t("pref.hideEmpty"))),
    h("div", { className: "gf-menu-row" },
      h(Switch, { checked: markOnScroll, onChange: function (value) { controller.setMarkOnScroll(value); }, label: t("pref.markOnScroll") }),
      h("span", { className: "gf-menu-text" }, t("pref.markOnScroll"))),
    h("div", { className: "gf-menu-row" },
      h(Switch, { checked: showDigest, onChange: function (value) { controller.setShowDigest(value); }, label: t("pref.showDigest") }),
      h("span", { className: "gf-menu-text" }, t("pref.showDigest"))),
    h("div", { className: "gf-menu-row" },
      h("span", { className: "gf-menu-text" }, t("pref.groupBy")),
      h("select", {
        className: "gf-select",
        value: groupBy,
        "aria-label": t("pref.groupBy"),
        onChange: function (event: any) { controller.setGroupBy(event.target.value); }
      },
      h("option", { value: "none" }, t("pref.none")),
      h("option", { value: "folder" }, t("pref.folder")),
      h("option", { value: "feed" }, t("pref.feed")))));
}

export function GitStatus({ state, t }: { state: ClientState; t: Translate }) {
  const git = state.git;
  const local = state.localFetch;
  const nodes: any[] = [];
  if (!git || !git.repo) {
    nodes.push(h("span", { key: "nogit", className: "gf-muted" }, t("status.noGit")));
  } else {
    nodes.push(h("b", { key: "branch" }, git.branch || "?"));
    if (git.behind) nodes.push(h("span", { key: "behind", className: "gf-warn" }, tf(t, "status.behind", { n: git.behind })));
    else if (git.ahead) nodes.push(h("span", { key: "ahead" }, tf(t, "status.ahead", { n: git.ahead })));
    else if (git.dirty) nodes.push(h("span", { key: "dirty", className: "gf-warn" }, t("status.dirty")));
  }
  if (local && local.enabled) {
    const detail = [t("status.lastRefresh") + ": " + (local.lastRunAt ? fmtTime(local.lastRunAt) : t("status.never"))];
    if (local.last) detail.push(tf(t, "status.fetchLine", { fresh: local.last.fresh, failed: local.last.failed }));
    nodes.push(h("span", {
      key: "auto",
      className: local.last && local.last.code !== 0 ? "gf-warn" : undefined,
      title: detail.join(" · ")
    }, "↻ " + Math.max(1, Math.round(local.intervalMs / 60000)) + "m"));
  }
  if (local && local.running) nodes.push(h("span", { key: "running", className: "gf-muted" }, t("status.running")));
  return h("div", { className: "gf-status" }, nodes);
}

export function Toasts({ toast }: { toast: Toast | null }) {
  if (!toast) return null;
  return h("div", { className: "gf-toasts" },
    h("div", {
      className: "gf-toast" + (toast.error ? " error" : ""),
      role: toast.error ? "alert" : "status"
    }, toast.text));
}

export function ErrorState({ state, controller, t }: {
  state: ClientState;
  controller: Controller;
  t: Translate;
}) {
  return h("div", { className: "gf-errorpage" },
    h(IconRss, { size: 36 }),
    h("h2", null, t("error.title")),
    h("p", null, state.error),
    state.repo ? h("p", { className: "gf-muted" }, state.repo) : null,
    h("button", { type: "button", className: "gf-btn primary", onClick: function () { controller.load({ force: true }); } }, t("action.retry")));
}

/** Compact background-refresh indicator: age of the last run, and a warn tint when it failed. */
export function RefreshState({ state, t }: { state: ClientState; t: Translate }) {
  const local = state.localFetch;
  if (!local || !local.enabled) return null;
  const run = local.last;
  // Partial failures stay quiet: the Feeds list marks those rows and the
  // tooltip carries the counts. Only a run where every feed failed is an alarm.
  const broken = run ? run.code !== 0 : false;
  const age = local.lastRunAt ? fmtTime(local.lastRunAt) : t("status.never");
  const title = [
    tf(t, "status.autoEvery", { n: Math.max(1, Math.round(local.intervalMs / 60000)) }),
    local.nextDueAt ? tf(t, "status.nextIn", { age: fmtIn(local.nextDueAt) }) : "",
    t("status.lastRefresh") + ": " + age,
    run ? tf(t, "status.feedCount", { n: run.feeds }) : "",
    run ? tf(t, "status.fetchLine", { fresh: run.fresh, failed: run.failed }) : ""
  ].filter(Boolean).join(" · ");
  return h("span", {
    className: "gf-refresh-state" + (local.running ? " running" : broken ? " warn" : ""),
    title: title,
    "aria-label": title,
    role: "status"
  }, local.running ? "⟳ …" : "⟳ " + age);
}

export function EmptyArticle({ state, t }: { state: ClientState; t: Translate }) {
  return h("div", { className: "gf-placeholder" },
    h("div", { className: "big" }, t("page.title")),
    h("p", null, tf(t, "items.count", { n: state.items.length }) + " · " + tf(t, "unread.count", { n: state.items.filter(function (item) { return !state.read.has(item.id); }).length })),
    h("p", { className: "gf-muted" }, t("empty.articleHint")));
}
