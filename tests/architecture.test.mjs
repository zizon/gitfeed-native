// The clean-room ratchet: the Host half must not grow a second clock, and the
// job runner's timer surface must stay the one primitive it was designed around.
// `fetch.ts` is the documented exception: an abort deadline per HTTP request,
// shared with the CLI, which is not a schedule.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { finish, lib, ok, repoRoot } from './harness.mjs'

const HOST_DIR = path.join(repoRoot, 'src', 'host')
const RAW_TIMER = /\bset(?:Timeout|Interval)\s*\(/
// `fetch.ts` arms the per-request abort deadline; `events.ts` holds one
// response open and pings it. Neither is a schedule.
const EXEMPT = new Set(['fetch.ts', 'events.ts'])

const hostFiles = readdirSync(HOST_DIR).filter((name) => name.endsWith('.ts'))
const offenders = []
for (const name of hostFiles) {
  if (EXEMPT.has(name)) continue
  const text = readFileSync(path.join(HOST_DIR, name), 'utf8')
  if (RAW_TIMER.test(text)) offenders.push(name)
}
ok(offenders.length === 0, 'no Host module arms its own timer', offenders)

const runner = readFileSync(path.join(HOST_DIR, 'runner.ts'), 'utf8')
ok(!RAW_TIMER.test(runner), 'the runner owns no timer of its own')

const surface = runner.match(/export interface JobTimers \{([\s\S]*?)\n\}/)
ok(!!surface, 'the runner declares its timer surface')
const methods = surface ? [...surface[1].matchAll(/(\w+)\s*\(/g)].map((match) => match[1]).filter((name) => name !== 'callback' && name !== 'delayMs') : []
ok(JSON.stringify(methods) === JSON.stringify(['timeout']), 'the timer surface is exactly one timeout', methods)

// One state path: a surface holds what the stream sent. A client module that
// builds a /state request is the removed fallback growing back.
const clientDir = path.join(repoRoot, 'src', 'client')
const stateRequests = readdirSync(clientDir, { recursive: true })
  .filter((name) => typeof name === 'string' && /\.tsx?$/.test(name))
  .filter((name) => readFileSync(path.join(clientDir, name), 'utf8').includes("'/state'"))
ok(stateRequests.length === 0, 'no client module asks the Host for its state', stateRequests)

const entry = readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8')
ok(/export const inject = \[[^\]]*'timer'[^\]]*\]/.test(entry), 'the plugin injects the timer service')
ok(/ctx\.timeout\(/.test(entry), 'the plugin arms each job through ctx.timeout')

// One error-message helper for the whole package. Every half used to carry its
// own copy and they had already drifted (git's prefers stderr), so the check is
// on the shape rather than the name: a renamed copy still trips it.
const sources = readdirSync(path.join(repoRoot, 'src'), { recursive: true }).filter((name) => /\.tsx?$/.test(name))
const copies = sources.filter((name) => {
  if (name.endsWith(path.join('shared', 'errors.ts'))) return false
  const text = readFileSync(path.join(repoRoot, 'src', name), 'utf8')
  return /function \w+\(\w+: unknown\): string \{/.test(text) && text.includes("|| 'unknown error'")
})
ok(copies.length === 0, 'no module keeps its own error-message helper', copies)

// A bin path npm accepts: it normalizes `bin/*` and silently drops anything
// else at publish time, which is how a released package lost its CLI while the
// repository still advertised one.
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
for (const [name, target] of Object.entries(pkg.bin || {})) {
  ok(target === pkg.bin[name].replace(/^\.\//, '') && !target.startsWith('/'),
    `${name} is a package-relative bin path`, target)
}

const { messageOf } = await import(lib('shared', 'errors.js'))
ok(messageOf(new Error('  boom ')) === 'boom', 'an Error contributes its trimmed message')
ok(messageOf(' plain ') === 'plain', 'a thrown string contributes itself')
ok(messageOf({ message: ' shaped ' }) === 'shaped', 'an object with a message is read')
ok(messageOf(null) === 'unknown error' && messageOf(undefined) === 'unknown error', 'anything else is "unknown error"')

finish()
