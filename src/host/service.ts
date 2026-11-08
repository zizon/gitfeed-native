// The reader's Host state machine: committed items plus the local refresh
// cache, read/star state, subscriptions, git actions, and the scheduler.

import crypto from "node:crypto";
import path from "node:path";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { feedIdFor, normalizeUrl, readFeeds, resolveFeed, writeFeeds } from "./feeds.js";
import { loadRuntimeFeeds, runFetch } from "./fetch.js";
import { pull, readGitInfo, sync } from "./git.js";
import { applyRun, dueFeeds, nextDueAt, pruneSchedule, readSchedule, writeSchedule } from "./schedule.js";
import type { ScheduleState } from "./schedule.js";
import { pathsFor, readRepoConfig } from "./settings.js";
import { appendNdjson, ensureDir, listShards, readJson, readNdjson, writeNdjson } from "./store.js";

const MAX_BODY_IDS = 4000;

function errorText(err) {
  if (!err) return "unknown error";
  return String(err.message || err).trim() || "unknown error";
}

function plainText(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function checkedIds(ids) {
  if (!Array.isArray(ids)) return [];
  const clean = [];
  for (const id of ids.slice(0, MAX_BODY_IDS)) {
    if (typeof id !== "string" || id.length === 0 || id.length >= 64) continue;
    clean.push(id);
  }
  return clean;
}

/**
 * Create the Host-side reader for one checkout.
 * @param {object} options
 * @param {string} options.root absolute gitfeed checkout.
 * @param {{info:Function, warn:Function, error:Function}} [options.logger]
 * @returns {object} reader surface used by the HTTP API and the agent tool.
 */
export function createGitfeed(options) {
  const root = options.root;
  const logger = options.logger || console;
  const paths = pathsFor(root);
  const refreshMinutes = Number.isFinite(Number(options.refreshMinutes)) ? Math.max(0, Number(options.refreshMinutes)) : 0;
  const idleMinutes = Number(options.idleMinutes) > 0 ? Number(options.idleMinutes) : 15;
  const allowGit = options.allowGit !== false;
  const adaptive = options.adaptive !== false;
  const maxIntervalMinutes = Number.isFinite(Number(options.maxIntervalMinutes))
    ? Math.max(1, Number(options.maxIntervalMinutes))
    : 1440;

  let snapshotCache = { version: null, data: null };
  let gitCache = { at: 0, value: null };
  let writeQueue = Promise.resolve();
  let fetchChain = Promise.resolve();
  let fetchRunning = false;
  let lastFetchAt = 0;
  let lastRun = null;
  let scheduleState: ScheduleState | null = null;
  let lastActivity = Date.now();
  let disposed = false;
  let stopScheduler = null;

  function touch() {
    lastActivity = Date.now();
  }

  function invalidate() {
    snapshotCache = { version: null, data: null };
    gitCache = { at: 0, value: null };
  }

  function serialize(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.then(function () { }, function () { });
    return run;
  }

  function settings() {
    return readRepoConfig(root);
  }

  async function fileVersion() {
    const files = [paths.config, paths.feeds, paths.meta, paths.read, paths.starred, paths.localMeta];
    let feedsExists = true;
    try {
      await stat(paths.feeds);
    } catch (err) {
      feedsExists = false;
    }
    if (!feedsExists) return "uninitialized";
    files.push.apply(files, await listShards(paths.items));
    files.push.apply(files, await listShards(paths.localItems));
    const hash = crypto.createHash("sha1");
    for (const file of files) {
      try {
        const info = await stat(file);
        hash.update(file + ":" + info.size + ":" + info.mtimeMs + "\n");
      } catch (err) {
        hash.update(file + ":missing\n");
      }
    }
    return hash.digest("hex");
  }

  async function gitInfo() {
    if (gitCache.value && Date.now() - gitCache.at < 3000) return gitCache.value;
    const value = await readGitInfo(root);
    gitCache = { at: Date.now(), value: value };
    return value;
  }

  async function currentSchedule(): Promise<ScheduleState> {
    if (!scheduleState) {
      scheduleState = await readSchedule(root);
      // A restart keeps reporting the last run and does not fetch again before
      // the minimum interval has passed.
      if (scheduleState.lastRun) {
        if (!lastRun) lastRun = scheduleState.lastRun;
        const at = Date.parse(scheduleState.lastRun.at);
        if (Number.isFinite(at)) lastFetchAt = Math.max(lastFetchAt, at);
      }
    }
    return scheduleState;
  }

  async function localFetchInfo() {
    let due = null;
    if (adaptive) {
      const state = await currentSchedule();
      const feeds = await loadRuntimeFeeds(root);
      due = nextDueAt(state, feeds.map(function (feed) { return feed.id; }), Date.now());
    }
    return {
      enabled: refreshMinutes > 0,
      intervalMs: refreshMinutes * 60000,
      lastRunAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
      running: fetchRunning,
      last: lastRun,
      nextDueAt: due === null ? null : new Date(due).toISOString()
    };
  }

  async function buildSnapshot(cfg, version) {
    if (snapshotCache.version === version && snapshotCache.data) return snapshotCache.data;

    const items = [];
    const seenItems = new Set();
    const shards = (await listShards(paths.items)).concat(await listShards(paths.localItems));
    for (const file of shards) {
      const rows = await readNdjson(file);
      for (const row of rows) {
        if (!row || !row.id || !row.date || seenItems.has(row.id)) continue;
        seenItems.add(row.id);
        items.push(row);
      }
    }
    items.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });

    const read = [];
    for (const row of await readNdjson(paths.read)) if (row && row.id) read.push(row.id);
    const starred = [];
    for (const row of await readNdjson(paths.starred)) if (row && row.id) starred.push(row.id);

    const dataMeta = await readJson(paths.meta, {});
    const localMeta = await readJson(paths.localMeta, {});
    const meta = {};
    const metaIds = new Set(Object.keys(dataMeta).concat(Object.keys(localMeta)));
    for (const id of metaIds) {
      const d = dataMeta[id] || {};
      const l = localMeta[id] || {};
      const latest = (l.checkedAt || "") > (d.checkedAt || "") ? l : d;
      meta[id] = {
        title: d.title || l.title || null,
        folder: d.folder || l.folder || null,
        siteUrl: d.siteUrl || l.siteUrl || null,
        url: d.url || l.url || null,
        lastError: latest.lastError || d.lastError || l.lastError || null,
        checkedAt: latest.checkedAt || d.checkedAt || l.checkedAt || null
      };
    }

    const subscribed = await readFeeds(root);
    const feeds = subscribed.map(function (f) {
      const m = meta[f.id] || {};
      return {
        id: f.id,
        title: m.title || f.title || f.id,
        folder: f.folder || m.folder || null,
        siteUrl: m.siteUrl || null,
        url: f.url || m.url || null,
        error: m.lastError || null,
        checkedAt: m.checkedAt || null
      };
    });

    const data = {
      items: items,
      read: read,
      starred: starred,
      feeds: feeds,
      reader: cfg.reader,
      repo: root,
      allowGit: allowGit
    };
    snapshotCache = { version: version, data: data };
    return data;
  }

  /**
   * Read the complete reader state, or only its volatile facts when the caller
   * already holds this version.
   * @param {string} [knownVersion] version the caller rendered last.
   * @returns {Promise<object>} state payload.
   */
  async function getState(knownVersion) {
    touch();
    const version = await fileVersion();
    let cfg;
    try {
      cfg = settings();
    } catch (err) {
      return {
        version: version,
        error: errorText(err),
        items: [], read: [], starred: [], feeds: [],
        reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: "none" },
        git: await gitInfo(),
        localFetch: await localFetchInfo(),
        repo: root,
        allowGit: allowGit,
        generatedAt: new Date().toISOString()
      };
    }
    const base = {
      version: version,
      git: await gitInfo(),
      localFetch: await localFetchInfo(),
      repo: root,
      allowGit: allowGit,
      generatedAt: new Date().toISOString()
    };
    if (version === "uninitialized") {
      return Object.assign({}, base, {
        error: "gitfeed: no feeds.json in " + root + " — point config.repo at a gitfeed data root, or let the bundle seed an empty directory",
        items: [], read: [], starred: [], feeds: [], reader: cfg.reader
      });
    }
    if (knownVersion && knownVersion === version) return Object.assign({ unchanged: true }, base);
    const data = await buildSnapshot(cfg, version);
    return Object.assign({}, base, data);
  }

  async function setState(file, ids, value) {
    return serialize(async function () {
      const clean = checkedIds(ids);
      if (clean.length === 0) return 0;
      const rows = await readNdjson(file);
      const have = new Set(rows.map(function (r) { return r.id; }));
      if (value) {
        const add = [];
        for (const id of clean) {
          if (have.has(id)) continue;
          have.add(id);
          add.push({ id: id });
        }
        await appendNdjson(file, add);
        return add.length;
      }
      const drop = new Set(clean);
      const kept = rows.filter(function (r) { return !drop.has(r.id); });
      await writeNdjson(file, kept);
      return rows.length - kept.length;
    });
  }

  /**
   * Mark items read or unread.
   * @param {string[]} ids item ids.
   * @param {boolean} read target state.
   * @returns {Promise<{ok:boolean, changed:number, version:string}>} settled result.
   */
  async function mark(ids, read) {
    touch();
    const changed = await setState(paths.read, ids, read !== false);
    invalidate();
    return { ok: true, changed: changed, version: await fileVersion() };
  }

  /**
   * Star or unstar items.
   * @param {string[]} ids item ids.
   * @param {boolean} starred target state.
   * @returns {Promise<{ok:boolean, changed:number, version:string}>} settled result.
   */
  async function star(ids, starred) {
    touch();
    const changed = await setState(paths.starred, ids, starred !== false);
    invalidate();
    return { ok: true, changed: changed, version: await fileVersion() };
  }

  async function ensureLocalMeta() {
    await mkdir(paths.localItems, { recursive: true });
    try {
      await stat(paths.localMeta);
    } catch (err) {
      try {
        await copyFile(paths.meta, paths.localMeta);
      } catch (e) {
        // no committed meta yet; the first run just takes longer
      }
    }
  }

  /**
   * Run the fetcher into the gitignored `.local/` cache.
   * @param {{only?: string, feeds?: string[]}} [opts] restrict the run.
   * @returns {Promise<object>} fetcher result.
   */
  function runLocalFetch(opts?: { only?: string; feeds?: string[] }) {
    const only = opts && opts.only;
    const feeds = opts && opts.feeds;
    const task = fetchChain.then(async function () {
      if (disposed) throw new Error("gitfeed is unloading");
      await ensureLocalMeta();
      fetchRunning = true;
      try {
        const result = await runFetch({ root: root, dataDir: ".local", only: only, feeds: feeds });
        lastFetchAt = Date.now();
        lastRun = {
          at: new Date(lastFetchAt).toISOString(),
          summary: result.summary,
          fresh: result.fresh,
          failed: result.failed,
          code: result.code,
          feeds: result.feeds
        };
        if (disposed) return result;
        const state = await currentSchedule();
        const subscribed = await loadRuntimeFeeds(root);
        const ids = subscribed.map(function (feed) { return feed.id; });
        const dropped = pruneSchedule(state, ids);
        if (dropped) logger.info("gitfeed: dropped " + dropped + " feed(s) from the refresh schedule");
        applyRun(state, result.perFeed, {
          nowMs: lastFetchAt,
          baseMin: Math.max(1, refreshMinutes),
          maxMin: maxIntervalMinutes
        });
        state.lastRun = lastRun;
        await writeSchedule(root, state);
        invalidate();
        return result;
      } finally {
        fetchRunning = false;
        lastFetchAt = Date.now();
      }
    });
    fetchChain = task.then(function () { }, function () { });
    return task;
  }

  /**
   * Subscribe to a feed URL, or to a site URL whose feed is discovered.
   * @param {{url?: string, folder?: string}} input subscription request.
   * @returns {Promise<object>} the new feed entry.
   */
  async function addFeed(input) {
    touch();
    const raw = String((input && input.url) || "").trim();
    if (!raw) throw new Error("a feed or site URL is required");
    const resolved = await resolveFeed(raw);

    const feeds = await readFeeds(root);
    const key = normalizeUrl(resolved.url);
    for (const f of feeds) {
      if (normalizeUrl(f.url) === key) throw new Error("already subscribed to " + resolved.url);
    }

    let id = feedIdFor(resolved.url);
    const used = new Set(feeds.map(function (f) { return f.id; }));
    const base = id;
    let n = 2;
    while (used.has(id)) id = base + "-" + n++;

    const folder = String((input && input.folder) || "").trim() || "Uncategorized";
    const entry = { id: id, url: resolved.url, title: resolved.title || id, folder: folder };
    feeds.push(entry);
    await writeFeeds(root, feeds);
    invalidate();

    // Pull this one feed into the local cache so it appears immediately. A
    // failure here still leaves the subscription in place.
    try {
      await runLocalFetch({ only: id });
    } catch (err) {
      logger.warn("gitfeed: initial fetch for " + id + " failed: " + errorText(err));
    }
    return entry;
  }

  /**
   * Unsubscribe and remove that feed's items from both stores.
   * @param {string} id feed id.
   * @returns {Promise<{ok:boolean, removed:string}>} settled result.
   */
  async function removeFeed(id) {
    touch();
    const key = String(id || "");
    if (!key) throw new Error("feed id is required");
    const feeds = await readFeeds(root);
    const next = feeds.filter(function (f) { return f.id !== key; });
    if (next.length === feeds.length) throw new Error("no such feed");
    await writeFeeds(root, next);

    for (const dir of [paths.items, paths.localItems]) {
      for (const file of await listShards(dir)) {
        const rows = await readNdjson(file);
        const kept = rows.filter(function (row) { return row && row.feed !== key; });
        if (kept.length !== rows.length) await writeNdjson(file, kept);
      }
    }
    invalidate();
    return { ok: true, removed: key };
  }

  async function gitAction(name) {
    touch();
    if (!allowGit) throw new Error("git actions are disabled by the gitfeed plugin config (allowGit)");
    const info = await readGitInfo(root);
    if (!info.repo) {
      throw new Error(
        "gitfeed: " + root + " is a local copy, not a git working tree — clone your own repository there " +
        "(or point config.repo at one) to " + name
      );
    }
    if (name === "sync" && (info.remotes || []).indexOf("origin") === -1) {
      throw new Error("gitfeed: " + root + " has no `origin` remote — add one with `git remote add origin <url>` and try Sync again");
    }
    const result = name === "pull" ? await pull(root) : await sync(root);
    invalidate();
    return result;
  }

  async function snapshotNow() {
    const version = await fileVersion();
    if (version === "uninitialized") throw new Error("gitfeed: no feeds.json in " + root);
    const cfg = settings();
    return { cfg: cfg, version: version, data: await buildSnapshot(cfg, version) };
  }

  async function listForTool(input) {
    const opts = input || {};
    const { data } = await snapshotNow();
    const query = String(opts.query || "").trim().toLowerCase();
    const feedId = String(opts.feed || opts.feedId || "").trim();
    const unreadOnly = opts.unreadOnly === true;
    const starredOnly = opts.starredOnly === true;
    const limit = Math.max(1, Math.min(100, Number(opts.limit) || 30));
    const readSet = new Set(data.read);
    const starredSet = new Set(data.starred);
    const feedNames = new Map(data.feeds.map(function (f) { return [f.id, f.title]; }));
    const hits = [];
    for (const item of data.items) {
      if (feedId && item.feed !== feedId) continue;
      if (unreadOnly && readSet.has(item.id)) continue;
      if (starredOnly && !starredSet.has(item.id)) continue;
      if (query) {
        const hay = (item.title + " " + plainText(item.summary) + " " + (feedNames.get(item.feed) || item.feed)).toLowerCase();
        if (hay.indexOf(query) === -1) continue;
      }
      hits.push({
        id: item.id,
        title: item.title,
        feed: item.feed,
        feedTitle: feedNames.get(item.feed) || item.feed,
        date: item.date,
        link: item.link || null,
        unread: !readSet.has(item.id),
        starred: starredSet.has(item.id),
        summary: plainText(item.summary).slice(0, 240)
      });
      if (hits.length >= limit) break;
    }
    return {
      total: hits.length,
      unread: data.items.reduce(function (n, item) { return readSet.has(item.id) ? n : n + 1; }, 0),
      feeds: data.feeds.length,
      items: hits
    };
  }

  async function getForTool(id) {
    const { data } = await snapshotNow();
    const item = data.items.find(function (candidate) { return candidate.id === id; });
    if (!item) throw new Error("no item with id " + id);
    const readSet = new Set(data.read);
    const starredSet = new Set(data.starred);
    return {
      id: item.id,
      title: item.title,
      feed: item.feed,
      date: item.date,
      link: item.link || null,
      author: item.author || null,
      unread: !readSet.has(item.id),
      starred: starredSet.has(item.id),
      summary: plainText(item.summary).slice(0, 12000)
    };
  }

  async function statusForTool() {
    const { data, version } = await snapshotNow();
    const readSet = new Set(data.read);
    const unread = data.items.reduce(function (n, item) { return readSet.has(item.id) ? n : n + 1; }, 0);
    return {
      repo: root,
      version: version,
      feeds: data.feeds.length,
      items: data.items.length,
      unread: unread,
      starred: data.starred.length,
      failingFeeds: data.feeds.filter(function (f) { return !!f.error; }).length,
      git: await gitInfo(),
      localFetch: await localFetchInfo(),
      allowGit: allowGit
    };
  }

  function schedule() {
    if (stopScheduler) stopScheduler();
    if (!(refreshMinutes > 0)) return function () { };
    const refreshMs = refreshMinutes * 60000;
    const idleMs = Math.max(1, idleMinutes) * 60000;
    let warm = null;
    let timer = null;
    let stopped = false;

    let ticking = false;

    async function tick() {
      if (stopped || disposed || fetchRunning || ticking) return;
      if (Date.now() - lastActivity > idleMs) return;
      if (lastFetchAt && Date.now() - lastFetchAt < refreshMs) return;
      ticking = true;
      try {
        if (!adaptive) {
          await runLocalFetch();
          return;
        }
        // Only the feeds whose own interval elapsed; a quiet source backs off
        // on its own clock, so most runs touch a handful of feeds.
        const state = await currentSchedule();
        const subscribed = await loadRuntimeFeeds(root);
        const ids = subscribed.map(function (feed) { return feed.id; });
        const due = dueFeeds(state, ids, Date.now());
        if (!due.length) return;
        await runLocalFetch({ feeds: due });
      } catch (err) {
        logger.warn("gitfeed: scheduled refresh failed: " + errorText(err));
      } finally {
        ticking = false;
      }
    }

    warm = setTimeout(function () { tick(); }, 12000);
    timer = setInterval(function () { tick(); }, 15000);
    if (typeof warm.unref === "function") warm.unref();
    if (typeof timer.unref === "function") timer.unref();
    stopScheduler = function () {
      stopped = true;
      clearTimeout(warm);
      clearInterval(timer);
      stopScheduler = null;
    };
    return stopScheduler;
  }

  function dispose() {
    disposed = true;
    if (stopScheduler) stopScheduler();
    stopScheduler = null;
    invalidate();
  }

  return {
    root: root,
    getState: getState,
    mark: mark,
    star: star,
    addFeed: addFeed,
    removeFeed: removeFeed,
    runLocalFetch: runLocalFetch,
    pull: function () { return gitAction("pull"); },
    sync: function () { return gitAction("sync"); },
    settings: settings,
    listForTool: listForTool,
    getForTool: getForTool,
    statusForTool: statusForTool,
    schedule: schedule,
    dispose: dispose
  };
}
