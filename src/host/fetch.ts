// Fetch every feed in feeds.json, append genuinely new items to the date-sharded
// NDJSON log, and update the conditional-GET metadata.
//
// Exported as a function so the Host plugin, the CLI, and a scheduler all run
// the same implementation. `dataDir` selects the committed `data/` tree or the
// gitignored `.local/` refresh cache.

import crypto from "node:crypto";
import path from "node:path";
import { readdir, unlink } from "node:fs/promises";
import { parseFeed } from "./xml.js";
import { pathsFor, readRepoConfig } from "./settings.js";
import { feedIdFor, slug } from "./feeds.js";
import { appendNdjson, ensureDir, listShards, readJson, readNdjson, writeJson, writeNdjson } from "./store.js";

const UA = "gitfeed/2.0 (+https://github.com; personal RSS reader)";

function itemId(feedId, key) {
  return crypto.createHash("sha1").update(feedId + "|" + key).digest("hex").slice(0, 16);
}

function parseDate(raw, now) {
  if (!raw) return null;
  const d = new Date(String(raw).trim());
  if (Number.isNaN(d.getTime())) return null;
  const t = d.getTime();
  // Clamp nonsense: future timestamps and pre-web dates are treated as
  // "undated" so the shard they land in stays predictable.
  if (t > now.getTime() + 86400000) return null;
  if (t < Date.UTC(1995, 0, 1)) return null;
  return d;
}

async function loadFeeds(root) {
  const raw = await readJson(pathsFor(root).feeds, null);
  if (!raw || !Array.isArray(raw.feeds)) {
    throw new Error("feeds.json is missing or has no \"feeds\" array");
  }
  const used = new Set();
  const feeds = [];
  for (let i = 0; i < raw.feeds.length; i++) {
    const entry = raw.feeds[i];
    if (!entry || !entry.url || entry.disabled) continue;
    let id;
    try {
      id = entry.id ? slug(entry.id) : feedIdFor(entry.url);
    } catch (err) {
      continue;
    }
    let unique = id;
    let n = 2;
    while (used.has(unique)) unique = id + "-" + n++;
    used.add(unique);
    feeds.push({ id: unique, url: entry.url, title: entry.title || null, folder: entry.folder || null });
  }
  return feeds;
}

function parseXml(text) {
  const head = text.slice(0, 4000).replace(/^\uFEFF/, "");
  return /<(rss|feed|rdf:RDF|channel)\b/i.test(head);
}

async function fetchOne(feed, prev, now, settings) {
  const headers = {
    "user-agent": UA,
    accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    "accept-language": "en;q=0.8, *;q=0.5"
  };
  if (prev && prev.etag) headers["if-none-match"] = prev.etag;
  if (prev && prev.lastModified) headers["if-modified-since"] = prev.lastModified;

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, settings.fetch.timeoutMs);
  let res;
  try {
    res = await fetch(feed.url, { headers: headers, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 304) {
    return {
      notModified: true,
      meta: Object.assign({}, prev, { checkedAt: now.toISOString(), status: 304 })
    };
  }
  if (!res.ok) throw new Error("HTTP " + res.status);

  const body = await res.text();
  if (!parseXml(body)) throw new Error("response is not an XML feed");

  const parsed = parseFeed(body);
  if (parsed.items.length === 0) throw new Error("no items in feed");

  const seen = new Set();
  const items = [];
  for (let i = 0; i < parsed.items.length; i++) {
    const it = parsed.items[i];
    const key = it.guid || it.link || (it.title + "|" + it.date);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Feeds without dates would otherwise all land on the same timestamp.
    // Cascade them by feed position, newest first.
    const date = parseDate(it.date, now) || new Date(now.getTime() - i * 60000);
    items.push({
      id: itemId(feed.id, key),
      feed: feed.id,
      title: (it.title || "(untitled)").slice(0, 300),
      link: it.link || "",
      date: date.toISOString(),
      // Some feeds put a profile URL in <author>; it renders as noise.
      author: String(it.author || "").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 120),
      summary: (it.summary || "").slice(0, settings.fetch.maxSummaryChars)
    });
  }

  return {
    items: items,
    meta: {
      title: parsed.title || feed.title || feed.id,
      folder: feed.folder || null,
      siteUrl: parsed.siteUrl || null,
      etag: res.headers.get("etag") || null,
      lastModified: res.headers.get("last-modified") || null,
      checkedAt: now.toISOString(),
      status: res.status
    }
  };
}

async function pool(list, limit, worker) {
  const out = new Array(list.length);
  let next = 0;
  const runners = [];
  const size = Math.max(1, Math.min(limit, list.length));
  for (let i = 0; i < size; i++) {
    runners.push((async function () {
      while (true) {
        const idx = next++;
        if (idx >= list.length) return;
        out[idx] = await worker(list[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
  return out;
}

async function runFeed(feed, prev, now, settings) {
  try {
    const result = await fetchOne(feed, prev, now, settings);
    return Object.assign({ feed: feed }, result);
  } catch (err) {
    return { feed: feed, error: (err && err.message) || String(err) };
  }
}

function cutoffKey(now, keepMonths) {
  if (!(keepMonths > 0)) return "0000-00";
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - keepMonths, 1));
  return cutoff.toISOString().slice(0, 7);
}

async function prune(itemsDir, now, keepMonths) {
  if (!(keepMonths > 0)) return 0;
  const floor = cutoffKey(now, keepMonths);
  let names;
  try {
    names = await readdir(itemsDir);
  } catch (err) {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^\d{4}-\d{2}\.ndjson$/.test(name)) continue;
    if (name.slice(0, 7) >= floor) continue;
    await unlink(path.join(itemsDir, name));
    removed++;
  }
  return removed;
}

// Unsubscribing (or re-deriving ids after an OPML import) leaves metadata and
// items behind. Drop both so the sidebar does not grow phantom feeds.
async function dropOrphans(itemsDir, live) {
  let items = 0;
  for (const file of await listShards(itemsDir)) {
    const rows = await readNdjson(file);
    const kept = rows.filter(function (r) { return r && live.has(r.feed); });
    if (kept.length !== rows.length) {
      items += rows.length - kept.length;
      await writeNdjson(file, kept);
    }
  }
  return items;
}

/**
 * Fetch one or every feed and write what changed.
 * @param {object} options
 * @param {string} options.root gitfeed checkout.
 * @param {string} [options.dataDir] output directory relative to `root`; defaults to `data`.
 * @param {string} [options.only] fetch exactly one feed id.
 * @param {boolean} [options.dryRun] fetch and report without writing.
 * @param {(line: string) => void} [options.onLog] receives every progress line.
 * @returns {Promise<{code:number, logs:string[], summary:string, feeds:number, fresh:number, unchanged:number, expired:number, failed:number}>}
 */
export async function runFetch(options) {
  const opts = options || {};
  const root = opts.root;
  const settings = readRepoConfig(root);
  const paths = pathsFor(root);
  const dataRoot = opts.dataDir ? path.resolve(root, opts.dataDir) : paths.data;
  const itemsDir = path.join(dataRoot, "items");
  const metaFile = path.join(dataRoot, "meta.json");
  const only = String(opts.only || "");
  const dryRun = opts.dryRun === true;
  const logs = [];
  const log = function (line) {
    logs.push(line);
    if (typeof opts.onLog === "function") opts.onLog(line);
  };

  let feeds = await loadFeeds(root);
  if (only) feeds = feeds.filter(function (feed) { return feed.id === only; });
  if (feeds.length === 0) {
    const message = only ? "no feed with id " + only : "feeds.json contains no usable feeds";
    log(message);
    return { code: 1, logs: logs, summary: message, feeds: 0, fresh: 0, unchanged: 0, expired: 0, failed: 0 };
  }

  await ensureDir(itemsDir);
  const meta = await readJson(metaFile, {});
  const live = new Set(feeds.map(function (feed) { return feed.id; }));
  let staleFeeds = 0;
  // A single-feed run must not judge every other feed "unsubscribed".
  if (!only) {
    for (const key of Object.keys(meta)) {
      if (live.has(key)) continue;
      delete meta[key];
      staleFeeds++;
    }
  }

  const known = new Set();
  for (const file of await listShards(itemsDir)) {
    const rows = await readNdjson(file);
    for (const row of rows) if (row && row.id) known.add(row.id);
  }

  const now = new Date();
  log("gitfeed " + now.toISOString() + "  " + feeds.length + " feeds");
  if (staleFeeds) log("  drop " + staleFeeds + " stale feed(s) from meta.json");
  if (!dryRun && !only) {
    const dropped = await dropOrphans(itemsDir, live);
    if (dropped) log("  drop " + dropped + " item(s) from removed feeds");
  }

  const results = await pool(feeds, settings.fetch.concurrency, function (feed) {
    return runFeed(feed, meta[feed.id], now, settings);
  });

  const floor = cutoffKey(now, settings.fetch.keepMonths);
  const fresh = [];
  let failed = 0;
  let unchanged = 0;
  let expired = 0;
  for (const r of results) {
    if (r.error) {
      failed++;
      log("  err  " + r.feed.id.padEnd(18) + " " + r.error);
      const prevMeta = meta[r.feed.id] || {};
      meta[r.feed.id] = Object.assign({}, prevMeta, {
        title: prevMeta.title || r.feed.title || r.feed.id,
        folder: r.feed.folder || prevMeta.folder || null,
        url: r.feed.url,
        lastError: r.error,
        checkedAt: now.toISOString()
      });
      continue;
    }
    meta[r.feed.id] = Object.assign({ url: r.feed.url, folder: r.feed.folder || null }, r.meta);
    if (r.notModified) {
      unchanged++;
      log("  ok   " + r.feed.id.padEnd(18) + " unchanged");
      continue;
    }
    let added = 0;
    for (const item of r.items) {
      if (known.has(item.id)) continue;
      // Older than the retention window: never write it, and let prune() drop
      // any shard already fully out of range.
      if (item.date.slice(0, 7) < floor) {
        known.add(item.id);
        expired++;
        continue;
      }
      known.add(item.id);
      fresh.push(item);
      added++;
    }
    log("  ok   " + r.feed.id.padEnd(18) + " +" + added + " (" + r.items.length + " seen)");
  }

  if (fresh.length > 0 && !dryRun) {
    const byMonth = new Map();
    for (const item of fresh) {
      const key = item.date.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(item);
    }
    const months = Array.from(byMonth.keys()).sort();
    for (const key of months) {
      const rows = byMonth.get(key).sort(function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      });
      await appendNdjson(path.join(itemsDir, key + ".ndjson"), rows);
      log("  write " + path.relative(root, path.join(itemsDir, key + ".ndjson")) + "  +" + rows.length);
    }
  }

  if (!dryRun) {
    const sorted = {};
    Object.keys(meta).sort().forEach(function (key) { sorted[key] = meta[key]; });
    await writeJson(metaFile, sorted);
    const dropped = await prune(itemsDir, now, settings.fetch.keepMonths);
    if (dropped) log("  prune " + dropped + " shard(s) older than " + settings.fetch.keepMonths + " months");
  }

  const summary =
    (dryRun ? "dry-run: " : "") + fresh.length + " new item(s), " +
    unchanged + " unchanged, " + expired + " past retention, " + failed + " failed";
  log(summary);
  return {
    code: failed === feeds.length ? 1 : 0,
    logs: logs,
    summary: summary,
    feeds: feeds.length,
    fresh: fresh.length,
    unchanged: unchanged,
    expired: expired,
    failed: failed
  };
}
