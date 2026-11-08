// Run every suite in its own process, in file order, and report one verdict.
// Each suite is a plain script: it prints its assertions and exits non-zero on
// a failure, so nothing here needs a test framework.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort()
const started = Date.now()
const failed = []

for (const suite of suites) {
  console.log(`\n── ${suite} ${'─'.repeat(Math.max(0, 60 - suite.length))}`)
  const run = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' })
  if (run.status !== 0) failed.push(suite)
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\n${suites.length - failed.length}/${suites.length} suites passed in ${seconds}s`)
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`)
  process.exitCode = 1
}
