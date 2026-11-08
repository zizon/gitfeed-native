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
