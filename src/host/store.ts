// Tiny NDJSON/JSON helpers shared by the fetcher and the reader.
//
// Two rules hold for every write here. A file is replaced by rename, never
// truncated in place, so a crash or a full disk leaves the previous contents
// rather than half of the new ones. And a file has one writer at a time: the
// fetch appends rows to a shard while an unsubscribe rewrites the same shard,
// and an append that lands between that read and that write would vanish.

import { readFile, writeFile, appendFile, mkdir, readdir, rename } from 'node:fs/promises'
import path from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** One writer at a time, per file, for the life of the process. */
const queues = new Map<string, Promise<void>>()

/**
 * Run one write after whatever is already queued for that file.
 * @param file - absolute path whose queue to join.
 * @param task - the write, which must not call back into this file's queue.
 * @returns the task's value.
 */
function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve()
  const run = previous.then(task, task)
  // The queue only orders writes; a failed write is answered to the caller that
  // asked for it, so the tail carries no outcome of its own.
  const tail = run.then(chainStep, chainStep)
  queues.set(file, tail)
  void tail.then(forget, forget)
  return run

  function forget(): void { /* the queue is forgotten, not reported */ }
}

/** A chain step whose result is answered elsewhere. */
function chainStep(): void { /* the outcome is not the queue's */ }

/**
 * Replace a file's contents in one step: write a sibling, then rename over it.
 *
 * The temporary name is fixed per file, which the queue above makes safe: two
 * writers would otherwise race on the same sibling and the loser's rename
 * would fail. A crash between the two steps leaves that sibling behind, and the
 * next write overwrites it, so it never accumulates.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.tmp`
  await writeFile(temp, text)
  await rename(temp, file)
}

export function writeJson(file: string, value: unknown): Promise<void> {
  return serialized(file, function () { return writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`) })
}

export async function readNdjson<T = Record<string, unknown>>(file: string): Promise<T[]> {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const rows: T[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line) as T)
    } catch {
      // A half-written line should never take the whole reader down.
    }
  }
  return rows
}

/** One shard's on-disk text: a row per line, trailing newline when not empty. */
function ndjsonText(rows: unknown[]): string {
  return rows.map(function (r) { return JSON.stringify(r) }).join('\n') + (rows.length ? '\n' : '')
}

export function appendNdjson(file: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return Promise.resolve()
  return serialized(file, async function () {
    await ensureDir(path.dirname(file))
    await appendFile(file, ndjsonText(rows))
  })
}

export function writeNdjson(file: string, rows: unknown[]): Promise<void> {
  return serialized(file, function () { return writeAtomic(file, ndjsonText(rows)) })
}

/**
 * Rewrite one file from the rows it holds right now, without an append
 * slipping between the read and the write.
 * @param file - absolute path.
 * @param transform - the rows to keep, or null to leave the file untouched.
 * @returns how many rows the rewrite removed; negative when it added some.
 */
export function updateNdjson<T>(file: string, transform: (rows: T[]) => T[] | null): Promise<number> {
  return serialized(file, async function () {
    const rows = await readNdjson<T>(file)
    const next = transform(rows)
    if (next === null) return 0
    await writeAtomic(file, ndjsonText(next))
    return rows.length - next.length
  })
}

export async function listShards(dir: string): Promise<string[]> {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names
    .filter(function (name) { return name.endsWith('.ndjson') })
    .sort()
    .map(function (name) { return path.join(dir, name) })
}
