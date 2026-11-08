// Tiny NDJSON/JSON helpers shared by the fetcher and the reader.

import { readFile, writeFile, appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    return fallback;
  }
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

export async function readNdjson(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    return [];
  }
  const rows = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      // A half-written line should never take the whole reader down.
    }
  }
  return rows;
}

export async function appendNdjson(file, rows) {
  if (!rows || rows.length === 0) return;
  await ensureDir(path.dirname(file));
  const text = rows.map(function (r) { return JSON.stringify(r); }).join("\n") + "\n";
  await appendFile(file, text);
}

export async function writeNdjson(file, rows) {
  await ensureDir(path.dirname(file));
  const text = rows.map(function (r) { return JSON.stringify(r); }).join("\n") + (rows.length ? "\n" : "");
  await writeFile(file, text);
}

export async function listShards(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    return [];
  }
  return names
    .filter(function (n) { return n.endsWith(".ndjson"); })
    .sort()
    .map(function (n) { return path.join(dir, n); });
}
