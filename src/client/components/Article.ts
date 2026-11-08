/** One article, with the sanitized feed HTML and its actions. */

import { h, useEffect, useMemo, useRef, useState } from "../react.js";
import type { ArticleProps } from "../types.js";
import { EmptyArticle } from "./Shared.js";
import { fmtDate, sanitize } from "../util.js";

export function Article({ state, controller, t, compact }: ArticleProps) {
  const item = state.byId.get(state.current || "");
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Past the opening of the article the reading flow matters more than the
  // metadata, so a compact "next" control follows the viewport instead of
  // sitting at the top of the pane.
  const [deep, setDeep] = useState(false);
  const feed = item ? state.feedMap.get(item.feed) : null;
  const host = item && item.link && /^https?:/i.test(item.link) ? item.link : null;
  const base = host || (feed && feed.siteUrl) || window.location.href;
  const html = useMemo(function () {
    if (!item) return "";
    return sanitize(item.summary || "", base);
  }, [item && item.id, item && item.summary, base]);

  useEffect(function () {
    const el = bodyRef.current;
    if (!el) return;
    const images = el.querySelectorAll("img");
    const broken: Array<[HTMLImageElement, () => void]> = [];
    for (const img of images) {
      const handler = function () { img.style.display = "none"; };
      img.addEventListener("error", handler);
      broken.push([img, handler]);
    }
    return function () {
      for (const pair of broken) pair[0].removeEventListener("error", pair[1]);
    };
  }, [html]);

  useEffect(function () {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = function () { setDeep(el.scrollTop > 240); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return function () { el.removeEventListener("scroll", onScroll); };
  }, [item && item.id]);

  if (!item) {
    return compact ? null : h(EmptyArticle, { state: state, t: t });
  }

  const starred = state.starred.has(item.id);
  const meta: string[] = [];
  meta.push(feed ? feed.title : item.feed);
  meta.push(fmtDate(item.date));
  if (item.author) meta.push(t("article.by") + " " + item.author);

  const topBar = h("div", { className: "gf-article-top" },
    compact ? h("button", {
      type: "button", className: "gf-icon-btn", title: t("action.back"), "aria-label": t("action.back"),
      onClick: function () { controller.closeArticle(); }
    }, "\u2190") : null,
    h("div", { className: "gf-article-meta" }, meta.join(" \u00b7 ")),
    h("div", { className: "gf-article-actions" },
      h("button", {
        type: "button", className: "gf-icon-btn star" + (starred ? " on" : ""),
        title: starred ? t("action.unstar") : t("action.star"),
        "aria-label": starred ? t("action.unstar") : t("action.star"),
        onClick: function () { controller.toggleStar(); }
      }, starred ? "\u2605" : "\u2606"),
      h("button", {
        type: "button", className: "gf-icon-btn", title: t("action.markUnread"), "aria-label": t("action.markUnread"),
        onClick: function () { controller.toggleRead(); }
      }, "\u25cf"),
      host ? h("a", {
        className: "gf-btn small", href: host, target: "_blank", rel: "noopener noreferrer",
        title: t("action.openOriginal")
      }, t("action.openOriginal")) : null,
      compact ? null : h("button", {
        type: "button", className: "gf-icon-btn", title: t("action.close"), "aria-label": t("action.close"),
        onClick: function () { controller.closeArticle(); }
      }, "\u00d7")));

  const body = html.trim()
    ? h("div", { className: "gf-article-body", ref: bodyRef, dangerouslySetInnerHTML: { __html: html } })
    : h("p", { className: "gf-muted" }, t("article.noSummary"));

  const scroller = h("div", { className: "gf-article-scroll", ref: scrollRef },
    h("h1", null, host
      ? h("a", { href: host, target: "_blank", rel: "noopener noreferrer" }, item.title || "(untitled)")
      : (item.title || "(untitled)")),
    body);

  // Past the opening of the piece, offer the next article where the reader
  // already is instead of asking them to scroll back up to the metadata row.
  const nextFloat = deep
    ? h("div", { className: "gf-readfloat" },
      h("button", {
        type: "button", className: "gf-markfloat-main", title: t("action.next"),
        onClick: function () { controller.move(1); }
      },
      h("span", { className: "gf-markfloat-label" }, t("action.next")),
      h("span", { className: "gf-markfloat-count" }, "\u2192")))
    : null;

  return h("div", { className: "gf-article" + (compact ? " compact" : "") }, topBar, scroller, nextFloat);
}
