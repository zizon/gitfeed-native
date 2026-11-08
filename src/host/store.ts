// Tiny NDJSON/JSON helpers shared by the fetcher and the reader.

import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises'
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

export async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  await writeFile(file, JSON.stringify(value, null, 2) + '\n')
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

export async function appendNdjson(file: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return
  await ensureDir(path.dirname(file))
  const text = rows.map(function (r) { return JSON.stringify(r) }).join('\n') + '\n'
  await appendFile(file, text)
}

export async function writeNdjson(file: string, rows: unknown[]): Promise<void> {
  await ensureDir(path.dirname(file))
  const text = rows.map(function (r) { return JSON.stringify(r) }).join('\n') + (rows.length ? '\n' : '')
  await writeFile(file, text)
}

export async function listShards(dir: string): Promise<string[]> {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  return names
    .filter(function (n) { return n.endsWith('.ndjson') })
    .sort()
    .map(function (n) { return path.join(dir, n) })
}
