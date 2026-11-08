// The write contract every caller of store.ts leans on: a file has one writer
// at a time, so a read-modify-write cannot swallow an append that landed
// between the two, and a replacement is a rename rather than a truncation.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { finish, lib, ok } from './harness.mjs'

const { appendNdjson, readJson, readNdjson, updateNdjson, writeJson, writeNdjson } = await import(lib('host', 'store.js'))

const dir = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-store-'))
try {
  // Three readers of the same file at once. Each one appends what it read plus
  // a row, so an unserialized read-modify-write would leave one row: every
  // transform would see the same base file and the last write would win.
  const shard = path.join(dir, 'items', '2026-11.ndjson')
  const bump = () => updateNdjson(shard, function (rows) {
    return rows.concat([{ id: `row-${rows.length}` }])
  })
  await Promise.all([bump(), bump(), bump()])
  const rows = await readNdjson(shard)
  ok(rows.length === 3, 'concurrent rewrites of one file cannot lose each other', rows)
  ok(rows.map((row) => row.id).join(',') === 'row-0,row-1,row-2', 'each rewrite sees the rows before it', rows.map((r) => r.id))

  // An append joins the same queue, so it lands either before or after a
  // rewrite and is never discarded by it.
  await Promise.all([
    updateNdjson(shard, function (current) { return current.filter(function (row) { return row.id !== 'row-1' }) }),
    appendNdjson(shard, [{ id: 'late' }]),
  ])
  const after = (await readNdjson(shard)).map(function (row) { return row.id })
  ok(!after.includes('row-1'), 'a rewrite takes the row it was asked to remove', after)
  ok(after.includes('late'), 'an append racing a rewrite is kept', after)

  // The untouched case: a transform that has nothing to do writes nothing.
  const before = readFileSync(shard, 'utf8')
  const removed = await updateNdjson(shard, function () { return null })
  ok(removed === 0 && readFileSync(shard, 'utf8') === before, 'a transform with nothing to keep writes nothing')

  // Replacing a file is atomic: the sibling used for the swap is gone and the
  // result parses, so a reader never sees a half file.
  const configFile = path.join(dir, 'config.json')
  writeFileSync(configFile, '{"fetch":{"concurrency":2}}')
  await writeJson(configFile, { fetch: { concurrency: 4 } })
  ok(!existsSync(`${configFile}.tmp`), 'a replaced file leaves no temporary sibling')
  const parsed = await readJson(configFile, null)
  ok(parsed !== null && parsed.fetch.concurrency === 4, 'the replacement is complete', parsed)

  // An empty NDJSON file is empty, not a stray newline that parses to nothing.
  const empty = path.join(dir, 'empty.ndjson')
  await writeNdjson(empty, [])
  ok(readFileSync(empty, 'utf8') === '', 'an empty ndjson file holds no lines')
  ok((await readNdjson(empty)).length === 0, 'and reads back as no rows')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

finish()
