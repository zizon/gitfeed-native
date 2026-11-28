// What the status line, the rail menu, and the refresh marker say about a
// scheduler job — in both languages, because the words are copy, not data.
// A refresh that reached no feed must read as the network, not as a page of
// broken sources; a git job's failure must not borrow that sentence.
//
// Pure module, bundled with esbuild like the derivations suite: no browser.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { finish, ok, repoRoot } from './harness.mjs'

const esbuild = [
  path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
  path.join(process.env.DSH_CHECKOUT || path.join(os.homedir(), 'deepseek-harness'), 'node_modules', '.bin', 'esbuild'),
].find(existsSync)

if (esbuild === undefined) {
  console.log('skip the job-words suite (no esbuild to compile the client module)')
  finish()
} else {
  const out = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-jobwords-'))
  const entry = path.join(out, 'entry.ts')
  const bundle = path.join(out, 'jobWords.mjs')
  try {
    writeFileSync(entry, [
      `export { jobWords, minutesOf } from ${JSON.stringify(path.join(repoRoot, 'src/client/job-words.ts'))}`,
      `export { EN, ZH } from ${JSON.stringify(path.join(repoRoot, 'src/client/locales.ts'))}`,
    ].join('\n'))
    execFileSync(esbuild, [
      entry,
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile=${bundle}`,
      '--log-level=warning',
    ])
    const { jobWords, minutesOf, EN, ZH } = await import(pathToFileURL(bundle).href)

    /** The service's interpolator: every `{name}` is filled, no missing copy. */
    function translator(dict) {
      return function (key, vars) {
        const text = dict[key]
        if (typeof text !== 'string') throw new Error(`missing copy: ${key}`)
        if (!vars) return text
        return text.replace(/\{(\w+)\}/g, function (match, name) {
          if (vars[name] === undefined) throw new Error(`missing {${name}} for ${key}`)
          return String(vars[name])
        })
      }
    }
    const en = translator(EN)
    const zh = translator(ZH)

    function job(patch) {
      return Object.assign({
        id: 'fetch',
        label: 'Refresh',
        enabled: true,
        intervalMs: 300000,
        nextDueAt: null,
        lastRunAt: '2026-01-01T00:00:00.000Z',
        running: false,
        last: null,
        error: null,
      }, patch)
    }

    // 1. The outage: the fail counts are the connection, not the sources.
    const outage = job({
      last: { at: '2026-01-01T00:00:00.000Z', ok: false, fresh: false, summary: 'x', detail: { added: 0, failed: 377, feeds: 377, unreachable: 377 } },
    })
    ok(jobWords(outage, en).counts === 'the network is unreachable (377 feeds)',
      'a run that reached nothing says so instead of "377 failed"', jobWords(outage, en).counts)
    ok(jobWords(outage, zh).counts === '网络不可达（377 个源）', 'and the Chinese copy says the same', jobWords(outage, zh).counts)
    ok(jobWords(outage, en).feeds === '377 feeds', 'the feed count is still reported', jobWords(outage, en).feeds)

    // 2. A normal run keeps the counts.
    const mixed = job({
      last: { at: '2026-01-01T00:00:00.000Z', ok: false, fresh: true, summary: 'x', detail: { added: 281, failed: 54, feeds: 377, unreachable: 0 } },
    })
    ok(jobWords(mixed, en).counts === '281 new · 54 failed', 'a run that reached feeds reports what it found', jobWords(mixed, en).counts)
    ok(jobWords(mixed, zh).counts === '新增 281 · 失败 54', 'in the reader’s language', jobWords(mixed, zh).counts)

    // 3. A run from a Host that predates the field: no outage, no crash.
    const old = job({
      last: { at: '2026-01-01T00:00:00.000Z', ok: false, fresh: false, summary: 'x', detail: { added: 0, failed: 54, feeds: 377 } },
    })
    ok(jobWords(old, en).counts === '0 new · 54 failed', 'a missing detail field falls back to the counts', jobWords(old, en).counts)

    // 4. The sync job's failure is not a feed outage, even when the remote
    //    was unreachable: its sentence is the verdict, not the fetch counts.
    const sync = job({
      id: 'git',
      label: 'Sync',
      last: { at: '2026-01-01T00:00:00.000Z', ok: false, fresh: false, summary: 'x', detail: { unreachable: 1 } },
    })
    ok(jobWords(sync, en).counts === '', 'the git job has no feed counts')
    ok(jobWords(sync, en).verdict === 'failed', 'its failed push is the verdict', jobWords(sync, en).verdict)
    ok(jobWords(sync, zh).verdict === '失败', 'in either language')

    // 5. Disabled and interval words.
    ok(jobWords(job({ enabled: false }), en).cadence === '', 'a disabled job has no cadence sentence')
    ok(jobWords(job({}), en).cadence === 'auto refresh every 5m', 'an enabled one reports its interval', jobWords(job({}), en).cadence)
    ok(minutesOf(job({ intervalMs: 60000 })) === 1 && minutesOf(job({ intervalMs: 600000 })) === 10, 'minutes come from the interval')
    ok(jobWords(undefined, en).counts === '', 'no job, no words')
  } finally {
    const { rmSync } = await import('node:fs')
    rmSync(out, { recursive: true, force: true })
  }
  finish()
}
