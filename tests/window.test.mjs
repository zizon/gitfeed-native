// What the viewport mounts, where its top edge sits, and which rows scrolling
// past marked. These are the list's invariants, and until now each one lived
// only in a comment beside code that could not be exercised without a browser.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { finish, ok, repoRoot } from './harness.mjs'

const esbuild = [
  path.join(repoRoot, 'node_modules', '.bin', 'esbuild'),
  path.join(process.env.DSH_CHECKOUT || path.join(os.homedir(), 'deepseek-harness'), 'node_modules', '.bin', 'esbuild'),
].find(existsSync)

if (esbuild === undefined) {
  console.log('skip the viewport suite (no esbuild to compile the client module)')
  finish()
} else {
  const out = mkdtempSync(path.join(os.tmpdir(), 'gitfeed-window-'))
  const bundle = path.join(out, 'window.mjs')
  try {
    execFileSync(esbuild, [
      path.join(repoRoot, 'src', 'client', 'window.ts'),
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile=${bundle}`,
      '--log-level=warning',
    ])
    const { groupFloorOf, lowerBound, offsetIndex, windowOf } = await import(pathToFileURL(bundle).href)

    const row = (id, h = 10) => ({ kind: 'row', key: id, item: { id: id }, h: h })
    const header = (key, h = 10) => ({ kind: 'group', key: `group:${key}`, group: { key: key, label: key, items: [] }, h: h })
    const rows = (n) => Array.from({ length: n }, (_, i) => row(`r${i}`))
    const pass = (entries, patch) => {
      const offsets = offsetIndex(entries)
      return windowOf(Object.assign({
        entries: entries,
        offsets: offsets,
        groupFloor: groupFloorOf(entries),
        prevTop: 0,
        top: 0,
        height: 100,
        groupBy: 'none',
        markOnScroll: true,
      }, patch))
    }

    // lowerBound: the first entry that starts at or after an offset.
    const flat = rows(100)
    const flatOffsets = offsetIndex(flat)
    ok(lowerBound(flatOffsets, 0) === 0, 'an offset at the top reads as entry zero')
    ok(lowerBound(flatOffsets, 205) === 20, 'an offset inside a row reads as that row', lowerBound(flatOffsets, 205))
    ok(lowerBound(flatOffsets, 1000) === 100, 'an offset at the very end reads as one past the last row')
    ok(flatOffsets.length === 101 && flatOffsets[100] === 1000, 'the offset index ends with the full height')

    // The mounted band, with its overscan on both sides.
    const band = pass(flat, { top: 200, prevTop: 200 })
    ok(band.start === 16 && band.end === 35, 'the band is the visible rows plus overscan', band)
    ok(pass(flat, { top: 995, height: 100 }).end === 100, 'the band never runs past the last row')
    ok(pass([], { top: 0 }).start === 0 && pass([], { top: 0 }).end === 0, 'an empty list mounts nothing')

    // The anchor: the row under the viewport edge, and how far into it.
    const anchored = pass(flat, { top: 205, prevTop: 205 })
    ok(anchored.anchor && anchored.anchor.key === 'r20', 'the anchor is the row under the edge', anchored.anchor)
    ok(anchored.anchor && anchored.anchor.delta === 5, 'the anchor keeps the edge offset into the row', anchored.anchor)
    ok(pass(flat, { top: 12 }).anchor === null, 'at the very top there is no anchor to hold')
    ok(pass(flat, { top: 13 }).anchor !== null, 'just below the top the anchor is kept')

    // Marking: rows the top crossed on the way down, including skipped ones.
    ok(
      pass(flat, { prevTop: 0, top: 50 }).passedIds.join(',') === 'r0,r1,r2,r3,r4',
      'rows crossed on the way down are the ones between the two offsets',
      pass(flat, { prevTop: 0, top: 50 }).passedIds,
    )
    ok(
      pass(flat, { prevTop: 0, top: 950 }).passedIds.length === 95,
      'a scrollbar drag marks the rows it skipped over',
      pass(flat, { prevTop: 0, top: 950 }).passedIds.length,
    )
    ok(pass(flat, { prevTop: 100, top: 50 }).passedIds.length === 0, 'scrolling up marks nothing')
    ok(pass(flat, { prevTop: 50, top: 50 }).passedIds.length === 0, 'standing still marks nothing')
    ok(
      pass(flat, { prevTop: 0, top: 50, markOnScroll: false }).passedIds.length === 0,
      'the scroll-mark switch silences it',
    )

    // The sticky section header stays mounted under the edge.
    const grouped = []
    grouped.push(header('Alpha'))
    for (let i = 0; i < 30; i++) grouped.push(row(`a${i}`))
    grouped.push(header('Beta'))
    for (let i = 0; i < 30; i++) grouped.push(row(`b${i}`))
    const floors = groupFloorOf(grouped)
    ok(floors[0] === 0 && floors[15] === 0 && floors[31] === 31, 'each row names its own section header', floors.slice(0, 3))
    // The header covering the band is reported for pinning; the band itself
    // stays at the overscan, so a tall section costs one header, not its rows.
    const beta = pass(grouped, { top: 500, prevTop: 500, height: 100, groupBy: 'folder' })
    ok(beta.start === 46 && beta.headerIndex === 31, 'a row deep in a section reports its header, not its rows', beta)
    const alpha = pass(grouped, { top: 250, prevTop: 250, height: 100, groupBy: 'folder' })
    ok(alpha.start === 21 && alpha.headerIndex === 0, 'the first section reports its header too', alpha)
    const nearHeader = pass(grouped, { top: 340, prevTop: 340, height: 100, groupBy: 'folder' })
    ok(nearHeader.headerIndex === null, 'a header already inside the band needs no pin', nearHeader)
    ok(pass(grouped, { top: 500, prevTop: 500, height: 100 }).headerIndex === null, 'without grouping nothing is pinned')

    // The regression this guards: one section holding thousands of rows must
    // still mount only the band. The archive really has a 2,334-row section.
    const huge = [header('Fresh')]
    for (let i = 0; i < 3000; i++) huge.push(row(`f${i}`))
    const deep = pass(huge, { top: 20000, prevTop: 20000, height: 600, groupBy: 'folder' })
    ok(deep.end - deep.start <= 80, 'a three-thousand-row section mounts only the band', deep.end - deep.start)
    ok(deep.headerIndex === 0, 'and reports the one header it needs', deep.headerIndex)
    const ungrouped = pass(grouped, { top: 250, prevTop: 250, height: 100, groupBy: 'none' })
    ok(ungrouped.start === 21, 'with no grouping the band is the plain overscan', ungrouped.start)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

finish()
