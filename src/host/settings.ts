// One place for every knob the plugin shares with the data root.
//
// The data root's config.json stays authoritative for fetching and reader
// defaults, exactly as it is for the GitHub Actions job in the data
// repository. Environment variables keep their old precedence so the plugin
// can be pointed at another checkout without editing the profile patch.

import os from "node:os";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import type { GroupBy } from "../shared/types.js";
import type { RepoConfig } from "./types.js";

export const DEFAULTS: RepoConfig = {
  fetch: { concurrency: 6, timeoutMs: 25000, keepMonths: 6, maxSummaryChars: 2500 },
  reader: { hideEmptyFeeds: true, markReadOnScroll: true, groupBy: "none" }
};

const GROUP_BY: GroupBy[] = ["none", "folder", "feed"];

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).toLowerCase();
  if (text === "1" || text === "true" || text === "yes" || text === "on") return true;
  if (text === "0" || text === "false" || text === "no" || text === "off") return false;
  return fallback;
}

/**
 * Expand a leading `~` to the home directory.
 * @param value configured path.
 * @returns the same path, absolute when it started with `~`.
 */
export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Resolve the data root the plugin reads and writes: a checkout of the data
 * repository, or a scratch directory the plugin scaffolded.
 * @param {unknown} repo configured `repo`, possibly empty.
 * @returns {string} absolute data root.
 */
export function resolveRoot(repo?: unknown): string {
  const raw = String(repo || process.env.GITFEED_REPO || "").trim();
  if (raw) return path.resolve(expandHome(raw));
  return path.join(os.homedir(), "gitfeed");
}

/**
 * Every file and directory the reader owns inside one checkout.
 * @param {string} root checkout directory.
 * @returns {Record<string, string>} absolute paths.
 */
export function pathsFor(root: string): Record<string, string> {
  return {
    root: root,
    config: path.join(root, "config.json"),
    feeds: path.join(root, "feeds.json"),
    data: path.join(root, "data"),
    items: path.join(root, "data", "items"),
    meta: path.join(root, "data", "meta.json"),
    read: path.join(root, "data", "read.ndjson"),
    starred: path.join(root, "data", "starred.ndjson"),
    local: path.join(root, ".local"),
    localItems: path.join(root, ".local", "items"),
    localMeta: path.join(root, ".local", "meta.json"),
    localSchedule: path.join(root, ".local", "schedule.json")
  };
}

let cache: { root: string; mtime: number; value: RepoConfig } | null = null;

/**
 * Read `config.json` with environment overrides applied.
 *
 * Throws a readable error when the file exists but is not valid JSON; a
 * missing file keeps the built-in defaults so a fresh checkout still mounts.
 * @param {string} root checkout directory.
 * @returns {object} resolved settings.
 */
export function readRepoConfig(root: string): RepoConfig {
  const file = path.join(root, "config.json");
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch (err) {
    mtime = 0;
  }
  if (cache && cache.root === root && cache.mtime === mtime) return cache.value;

  let fileConfig: any = {};
  try {
    fileConfig = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error("config.json is not valid JSON: " + err.message);
  }
  if (!fileConfig || typeof fileConfig !== "object") fileConfig = {};

  const env = process.env;
  const f = fileConfig.fetch || {};
  const r = fileConfig.reader || {};
  const value: RepoConfig = {
    fetch: {
      concurrency: clampInt(env.GITFEED_CONCURRENCY || f.concurrency, DEFAULTS.fetch.concurrency, 1, 16),
      timeoutMs: clampInt(env.GITFEED_TIMEOUT_MS || f.timeoutMs, DEFAULTS.fetch.timeoutMs, 3000, 120000),
      keepMonths: clampInt(env.GITFEED_KEEP_MONTHS || f.keepMonths, DEFAULTS.fetch.keepMonths, 0, 120),
      maxSummaryChars: clampInt(f.maxSummaryChars, DEFAULTS.fetch.maxSummaryChars, 200, 20000)
    },
    reader: {
      hideEmptyFeeds: toBool(r.hideEmptyFeeds, DEFAULTS.reader.hideEmptyFeeds),
      markReadOnScroll: toBool(r.markReadOnScroll, DEFAULTS.reader.markReadOnScroll),
      groupBy: GROUP_BY.includes(r.groupBy) ? r.groupBy : DEFAULTS.reader.groupBy
    }
  };
  cache = { root: root, mtime: mtime, value: value };
  return value;
}
