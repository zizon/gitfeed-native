/** One article, with the sanitized feed HTML and its actions. */

import { h, useEffect, useMemo, useRef } from "../react.js";
import type { ArticleProps } from "../types.js";
import { EmptyArticle } from "./Shared.js";
import { fmtDate, sanitize } from "../util.js";

export function Article({ state, controller, t, compact }: ArticleProps) {
  const item = state.byId.get(state.current || "");
  const bodyRef = useRef<HTMLDivElement>(null);
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

  if (!item) {
    return compact ? null : h(EmptyArticle, { state: state, t: t });
  }

  const starred = state.starred.has(item.id);
  const meta: string[] = [];
  meta.push(feed ? feed.title : item.feed);
  meta.push(fmtDate(item.date));
  if (item.author) meta.push(t("article.by") + " " + item.author);

  return h("div", { className: "gf-article" + (compact ? " compact" : "") },
    h("div", { className: "gf-article-top" },
      compact ? h("button", {
        type: "button", className: "gf-icon-btn", title: t("action.back"), "aria-label": t("action.back"),
        onClick: function () { controller.closeArticle(); }
      }, "←") : null,
      h("div", { className: "gf-article-meta" }, meta.join(" · ")),
      h("div", { className: "gf-article-actions" },
        h("button", {
          type: "button", className: "gf-icon-btn star" + (starred ? " on" : ""),
          title: starred ? t("action.unstar") : t("action.star"),
          "aria-label": starred ? t("action.unstar") : t("action.star"),
          onClick: function () { controller.toggleStar(); }
        }, starred ? "★" : "☆"),
        h("button", {
          type: "button", className: "gf-icon-btn", title: t("action.markUnread"), "aria-label": t("action.markUnread"),
          onClick: function () { controller.toggleRead(); }
        }, "●"),
        host ? h("a", {
          className: "gf-btn small", href: host, target: "_blank", rel: "noopener noreferrer",
          title: t("action.openOriginal")
        }, t("action.openOriginal")) : null,
        compact ? null : h("button", {
          type: "button", className: "gf-icon-btn", title: t("action.close"), "aria-label": t("action.close"),
          onClick: function () { controller.closeArticle(); }
        }, "×"))),
    h("div", { className: "gf-article-scroll" },
      h("h1", null, host
        ? h("a", { href: host, target: "_blank", rel: "noopener noreferrer" }, item.title || "(untitled)")
        : (item.title || "(untitled)")),
      html.trim()
        ? h("div", { className: "gf-article-body", ref: bodyRef, dangerouslySetInnerHTML: { __html: html } })
        : h("p", { className: "gf-muted" }, t("article.noSummary"))));
}
