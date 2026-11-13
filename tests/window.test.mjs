// What the viewport mounts, where its top edge sits, and which rows scrolling
// past marked. These are the list's invariants, and until now each one lived
// only in a comment beside code that could not be exercised without a browser.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { esbuildBin, finish, ok, repoRoot } from './harness.mjs'

const esbuild = esbuildBin()

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
    const { groupFloorOf, lowerBound, offsetIndex, scrollAfterRebuild, scrollReads, settledAbove, windowOf } = await import(pathToFileURL(bundle).href)

    const row = (id, h = 10) => ({ kind: 'row', key: id, item: { id: id }, h: h })
    const header = (key, h = 10) => ({ kind: 'group', key: `group:${key}`, group: { key: key, label: key, items: [] }, h: h })
    const rows = (n) => Array.from({ length: n }, (_, i) => row(`r${i}`))
    const pass = (entries, patch) => {
      const offsets = offsetIndex(entries)
      return windowOf(Object.assign({
        entries: entries,
        offsets: offsets,
        groupFloor: groupFloorOf(entries),
        top: 0,
        height: 100,
        groupBy: 'none',
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
    const band = pass(flat, { top: 200 })
    ok(band.start === 16 && band.end === 35, 'the band is the visible rows plus overscan', band)
    ok(pass(flat, { top: 995, height: 100 }).end === 100, 'the band never runs past the last row')
    ok(pass([], { top: 0 }).start === 0 && pass([], { top: 0 }).end === 0, 'an empty list mounts nothing')

    // The anchor: the row under the viewport edge, and how far into it.
    const anchored = pass(flat, { top: 205 })
    ok(anchored.anchor && anchored.anchor.key === 'r20', 'the anchor is the row under the edge', anchored.anchor)
    ok(anchored.anchor && anchored.anchor.delta === 5, 'the anchor keeps the edge offset into the row', anchored.anchor)
    ok(pass(flat, { top: 12 }).anchor === null, 'at the very top there is no anchor to hold')
    ok(pass(flat, { top: 13 }).anchor !== null, 'just below the top the anchor is kept')

    // Read on scroll: a row is read once it has been on screen for the dwell
    // and the viewport has scrolled past it. The clock is passed in, so the rule
    // is checked rather than waited for.
    const dwell = (entries, patch) => {
      const offsets = offsetIndex(entries)
      const index = new Map()
      entries.forEach((entry, i) => { if (entry.kind === 'row') index.set(entry.item.id, i) })
      return scrollReads(Object.assign({
        entries: entries,
        offsets: offsets,
        index: index,
        top: 0,
        height: 100,
        seen: new Map(),
        read: new Set(),
        now: 1000,
      }, patch))
    }
    const visible = dwell(flat, { top: 0 })
    ok(visible.entering[0][0] === 'r0', 'the rows on screen start their clock', visible.entering[0])
    ok(visible.readIds.length === 0, 'and none of them is read while still on screen')
    ok(
      dwell(flat, { top: 100, seen: new Map([['r0', 0]]) }).readIds.join(',') === 'r0',
      'a row seen for the dwell and then left behind is read',
    )
    ok(
      dwell(flat, { top: 100, seen: new Map([['r0', 999]]) }).readIds.length === 0,
      'a row that only flashed past is not read',
    )
    const flashed = dwell(flat, { top: 100, seen: new Map([['r0', 999]]) })
    ok(flashed.leaving.join(',') === 'r0', 'and its clock still stops', flashed.leaving)
    ok(
      dwell(flat, { top: 900 }).readIds.length === 0,
      'a drag to the bottom marks nothing it skipped',
    )
    ok(dwell(flat, { top: 0, seen: new Map([['r0', 0]]), now: 5000 }).readIds.length === 0, 'a row still on screen is not read')
    // A rebuild or a refresh moves rows under a still viewport. A row that
    // ended up below the band was never scrolled past, so it stays unread and
    // keeps its clock for a pass that does carry the band over it.
    const pushed = dwell(flat, { top: 0, seen: new Map([['r50', 0]]), now: 9000 })
    ok(pushed.readIds.length === 0, 'a row pushed out below the band is not read', pushed.readIds)
    ok(pushed.leaving.length === 0, 'and it keeps its clock', pushed.leaving)
    ok(
      dwell(flat, { top: 510, seen: new Map([['r50', 0]]) }).readIds.join(',') === 'r50',
      'the row is read once the viewport scrolls past it',
    )
    ok(
      dwell(flat, { top: 0, read: new Set(['r0']) }).entering.every(function (row) { return row[0] !== 'r0' }),
      'a row that is already read is not timed',
    )
    // The list scrolls one viewport past its last row, so the rows it ends on
    // leave the viewport like any other row once the reader scrolls into it.
    ok(
      dwell(flat, { top: 1000, seen: new Map([['r99', 0]]) }).readIds.includes('r99'),
      'the last row is read once the end screen scrolls past it',
    )
    ok(
      dwell(flat, { top: 995, seen: new Map([['r99', 0]]) }).readIds.length === 0,
      'a row still showing under the edge is not read',
    )
    ok(
      dwell(flat, { top: 1000, seen: new Map([['r99', 999]]) }).readIds.length === 0,
      'and the last row still has to have been seen for the dwell',
    )

    // A rebuild under a live viewport: the entry under the edge has to stay
    // under the edge. This is the transition the component applies before it
    // paints, and the one whose absence showed up as the list jumping.
    const rebuild = (next, top) => scrollAfterRebuild({
      prev: flat,
      prevOffsets: flatOffsets,
      next: next,
      nextOffsets: offsetIndex(next),
      top: top,
      height: 100,
      groupBy: 'none',
    })
    const named = (prefix, n) => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`))
    ok(rebuild(flat, 205) === 205, 'a rebuild that changed nothing keeps the viewport where it was', rebuild(flat, 205))
    ok(rebuild(flat, 0) === 0 && rebuild(flat, 5) === 0, 'at the top the viewport stays at the top', [rebuild(flat, 0), rebuild(flat, 5)])
    const grown = named('new', 3).concat(flat)
    ok(rebuild(grown, 205) === 235, 'rows inserted above are paid for in scroll offset, not in the text moving', rebuild(grown, 205))
    const shrunk = flat.slice(3)
    ok(rebuild(shrunk, 205) === 175, 'rows removed above are given back the same way', rebuild(shrunk, 205))
    const trimmed = flat.filter((entry) => entry.key !== 'r20')
    // r21 was 5px below the edge; it is still 5px below the edge afterwards.
    ok(rebuild(trimmed, 205) === 195, 'when the anchored row itself is gone, the row below it takes the place the edge had', rebuild(trimmed, 205))
    const cut = flat.slice(25)
    ok(rebuild(cut, 205) === 0, 'when everything up to the anchored row went, the list starts at its top', rebuild(cut, 205))
    ok(rebuild([], 205) === 0, 'an empty list has no position to hold')
    const taller = flat.map((entry) => Object.assign({}, entry, { h: 20 }))
    const tallerTarget = rebuild(taller, 205)
    ok(tallerTarget === 405, 'a row that got taller keeps the edge inside the row it was in', tallerTarget)
    // The band that follows the rebuilt list covers the viewport: the whole
    // point is that the painted frame is consistent with the rows it draws.
    for (const [next, top, target] of [[grown, 205, rebuild(grown, 205)], [shrunk, 205, rebuild(shrunk, 205)], [trimmed, 205, rebuild(trimmed, 205)]]) {
      const nextOffsets = offsetIndex(next)
      const band = windowOf({ entries: next, offsets: nextOffsets, groupFloor: groupFloorOf(next), top: target, height: 100, groupBy: 'none' })
      ok(
        nextOffsets[band.start] <= target && nextOffsets[band.end] >= Math.min(nextOffsets[next.length], target + 100),
        'the band drawn after a rebuild covers the viewport it was put back on',
        [band.start, band.end, target],
      )
    }

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
    const beta = pass(grouped, { top: 500, height: 100, groupBy: 'folder' })
    ok(beta.start === 46 && beta.headerIndex === 31, 'a row deep in a section reports its header, not its rows', beta)
    const alpha = pass(grouped, { top: 250, height: 100, groupBy: 'folder' })
    ok(alpha.start === 21 && alpha.headerIndex === 0, 'the first section reports its header too', alpha)
    const nearHeader = pass(grouped, { top: 340, height: 100, groupBy: 'folder' })
    ok(nearHeader.headerIndex === null, 'a header already inside the band needs no pin', nearHeader)
    ok(pass(grouped, { top: 500, height: 100 }).headerIndex === null, 'without grouping nothing is pinned')

    // The regression this guards: one section holding thousands of rows must
    // still mount only the band. The archive really has a 2,334-row section.
    const huge = [header('Fresh')]
    for (let i = 0; i < 3000; i++) huge.push(row(`f${i}`))
    const deep = pass(huge, { top: 20000, height: 600, groupBy: 'folder' })
    ok(deep.end - deep.start <= 80, 'a three-thousand-row section mounts only the band', deep.end - deep.start)
    ok(deep.headerIndex === 0, 'and reports the one header it needs', deep.headerIndex)
    const ungrouped = pass(grouped, { top: 250, height: 100, groupBy: 'none' })
    ok(ungrouped.start === 21, 'with no grouping the band is the plain overscan', ungrouped.start)

    // Rows a scroll left behind: read rows above the band. A grouped list lets
    // them go by fading their section; a flat one has no section, which is why
    // the band is the rule there.
    const read = new Set(['r0', 'r1', 'r5', 'r30'])
    const settled = settledAbove(flat, 16, read)
    ok(settled.join(',') === 'r0,r1,r5', 'read rows above the band are settled', settled)
    ok(settledAbove(flat, 0, read).length === 0, 'nothing above the top is settled')
    ok(settledAbove(flat, 16, new Set()).length === 0, 'an unread list settles nothing')
    ok(settledAbove(flat, 500, read).length === 4, 'a scroll past the end settles every read row above it')
    ok(settledAbove(grouped, 40, new Set(['a29', 'b0'])).join(',') === 'a29,b0', 'section headers are not rows to settle')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

finish()
