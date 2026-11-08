/** Shared assertions for the plain-node suites: no runner, no globals. */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A path inside the built Host half (`lib/`), which is what the tests load. */
export function lib(...parts) {
  return path.join(repoRoot, 'lib', ...parts)
}

let failures = 0

export function ok(cond, label, extra) {
  if (cond) {
    console.log(`ok   ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label}`, extra === undefined ? '' : extra)
  }
}

/** A check that cannot run here: visible, but it does not pass or fail. */
export function skip(label, why) {
  console.log(`skip ${label} (${why})`)
}

/**
 * Node-backed timer surface, for suites that drive the scheduler by hand. The
 * plugin itself receives the Harness timer service; this is the test double.
 */
export function nodeTimers() {
  return {
    interval(callback, delayMs) {
      const handle = setInterval(callback, delayMs)
      if (typeof handle.unref === 'function') handle.unref()
      return function () { clearInterval(handle) }
    },
    timeout(callback, delayMs) {
      const handle = setTimeout(callback, delayMs)
      if (typeof handle.unref === 'function') handle.unref()
      return function () { clearTimeout(handle) }
    },
  }
}

/**
 * A fake timer surface that doubles as the clock: `timers` is what the
 * scheduler arms, `advance` moves time and fires what is due, awaiting the pass
 * a deadline starts. This is the same surface the plugin receives from
 * `ctx.timer`, so the suites exercise the real scheduling path.
 */
export function makeClock(startMs = Date.parse('2026-01-01T00:00:00Z')) {
  let now = startMs
  let seq = 0
  const pending = new Map()

  const timers = {
    timeout(callback, delayMs) {
      const id = ++seq
      pending.set(id, { at: now + Math.max(0, delayMs), callback })
      return function () { pending.delete(id) }
    },
  }

  async function advance(ms) {
    const target = now + ms
    for (;;) {
      let next = null
      for (const entry of pending) {
        if (entry[1].at > target) continue
        if (!next || entry[1].at < next[1].at) next = entry
      }
      if (!next) break
      pending.delete(next[0])
      now = Math.max(now, next[1].at)
      const result = next[1].callback()
      if (result && typeof result.then === 'function') await result
    }
    now = target
  }

  return {
    timers,
    now: () => now,
    advance,
    advanceTo(targetMs) { return advance(Math.max(0, targetMs - now)) },
    pending: () => pending.size,
  }
}

/** Run the suite's verdict and exit non-zero on failure. */
export function finish() {
  if (failures > 0) {
    console.log(`\n${failures} FAILURE${failures === 1 ? '' : 'S'}`)
    process.exitCode = 1
  } else {
    console.log('\nALL PASS')
  }
  return process.exitCode || 0
}
