// The clean-room ratchet: the Host half must not grow a second clock, and the
// scheduler's timer surface must stay the one primitive it was designed around.
// `fetch.ts` is the documented exception: an abort deadline per HTTP request,
// shared with the CLI, which is not a schedule.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { finish, ok, repoRoot } from './harness.mjs'

const HOST_DIR = path.join(repoRoot, 'src', 'host')
const RAW_TIMER = /\bset(?:Timeout|Interval)\s*\(/
const EXEMPT = new Set(['fetch.ts'])

const hostFiles = readdirSync(HOST_DIR).filter((name) => name.endsWith('.ts'))
const offenders = []
for (const name of hostFiles) {
  if (EXEMPT.has(name)) continue
  const text = readFileSync(path.join(HOST_DIR, name), 'utf8')
  if (RAW_TIMER.test(text)) offenders.push(name)
}
ok(offenders.length === 0, 'no Host module arms its own timer', offenders)

const scheduler = readFileSync(path.join(HOST_DIR, 'scheduler.ts'), 'utf8')
ok(!RAW_TIMER.test(scheduler), 'the scheduler owns no timer of its own')

const surface = scheduler.match(/export interface SchedulerTimers \{([\s\S]*?)\n\}/)
ok(!!surface, 'the scheduler declares its timer surface')
const methods = surface ? [...surface[1].matchAll(/(\w+)\s*\(/g)].map((match) => match[1]).filter((name) => name !== 'callback' && name !== 'delayMs') : []
ok(JSON.stringify(methods) === JSON.stringify(['timeout']), 'the timer surface is exactly one timeout', methods)

const entry = readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8')
ok(/export const inject = \[[^\]]*'timer'[^\]]*\]/.test(entry), 'the plugin injects the timer service')
ok(/ctx\.timeout\(/.test(entry), 'the plugin arms each job through ctx.timeout')

finish()
