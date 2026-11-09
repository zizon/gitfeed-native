// The reader's display preferences: one persisted snapshot, seeded once from
// the per-key entries it used to write, and durable across a reload. The store
// engine is a shared Harness module: the suite compiles against the checkout the
// package is developed against, or the published copy installed as a
// devDependency, so it also runs in CI. Without either it reports a skip.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { esbuildBin, finish, ok, repoRoot, skip, storeEngine } from './harness.mjs'

const engine = storeEngine()
const esbuild = esbuildBin()

if (engine === undefined || esbuild === undefined) {
  skip('the reader persists one prefs snapshot', 'no DSH checkout with the shared store engine')
} else {
  const out = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-prefs-'))
  const bundle = path.join(out, 'prefs.mjs')
  try {
    execFileSync(esbuild, [
      path.join(repoRoot, 'src', 'client', 'prefs.ts'),
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--alias:@deepseek-ai/dsh-client-store=${engine}`,
      `--outfile=${bundle}`,
      '--log-level=warning',
    ])

    // A browser-shaped localStorage, seeded with the per-key entries the reader
    // wrote before the snapshot existed.
    const data = new Map([
      ['gitfeed.groupBy', 'folder'],
      ['gitfeed.hideEmpty', '0'],
      ['gitfeed.markOnScroll', '1'],
      ['gitfeed.showDigest', '0'],
      ['gitfeed.folders', '{"Daily":true}'],
      ['gitfeed.railW', '260'],
      ['gitfeed.listW', '480'],
    ])
    globalThis.localStorage = {
      getItem: (key) => (data.has(key) ? data.get(key) : null),
      setItem: (key, value) => { data.set(key, String(value)) },
      removeItem: (key) => { data.delete(key) },
    }

    const { createPrefs } = await import(pathToFileURL(bundle).href)
    const seeded = createPrefs().getSnapshot()
    ok(
      JSON.stringify(seeded) === JSON.stringify({
        groupBy: 'folder',
        hideEmpty: false,
        markOnScroll: true,
        showDigest: false,
        folderOpen: { Daily: true },
        railW: 260,
        listW: 480,
      }),
      'the per-key entries become one snapshot',
      seeded,
    )

    const leftover = [...data.keys()].filter((key) => key !== 'gitfeed.prefs')
    ok(leftover.length === 0, 'the per-key entries are cleared once seeded', leftover)
    ok(data.has('gitfeed.prefs'), 'the snapshot is written for the next visit')

    const repeated = createPrefs().getSnapshot()
    ok(
      JSON.stringify(repeated) === JSON.stringify(seeded),
      'a reload rehydrates the same preferences',
      repeated,
    )

    data.clear()
    const fresh = createPrefs().getSnapshot()
    ok(
      fresh.groupBy === null && fresh.hideEmpty === null && fresh.railW > 0,
      'a browser with nothing stored starts from the built-in defaults',
      fresh,
    )

    // A preference the reader changes is durable without any other step.
    const live = createPrefs()
    live.update((draft) => { draft.hideEmpty = true })
    ok(
      createPrefs().getSnapshot().hideEmpty === true,
      'a later change is durable too',
      data.get('gitfeed.prefs'),
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

finish()
