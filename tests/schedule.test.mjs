// The per-feed clocks behind the Refresh job: what one run's outcome does to a
// feed's next attempt. Loads the built Host half, so it asserts the shipped
// rule, not the source.
import { applyRun } from '../lib/host/schedule.js'
import { finish, ok } from './harness.mjs'

const BASE = 5
const MAX = 1440

function run(clocks, outcomes, nowMs = 0) {
  applyRun(clocks, outcomes, { nowMs, baseMin: BASE, maxMin: MAX })
  return clocks
}

// ---------- what a good run buys ----------
let clocks = { a: { intervalMin: 1440, nextAt: 0 } }
run(clocks, { a: { added: 3 } })
ok(clocks.a.intervalMin === BASE, 'a feed that produced items returns to the base interval')
ok(clocks.a.nextAt === BASE * 60000, 'and is due one base interval later')

clocks = { a: { intervalMin: 640, nextAt: 0 } }
run(clocks, { a: { added: 0 } })
ok(clocks.a.intervalMin === 1280, 'a feed with nothing new doubles its current interval')
run(clocks, { a: { added: 0 } })
ok(clocks.a.intervalMin === MAX, 'and is capped at the maximum')
run(clocks, { a: { added: 0 } })
ok(clocks.a.intervalMin === MAX, 'the cap holds')

// ---------- what a miss costs ----------
clocks = { a: { intervalMin: 1440, nextAt: 0 } }
run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.intervalMin === BASE, 'a failed feed retries at the base interval, not at the ceiling')
ok(clocks.a.failures === 1, 'and the failure is remembered')
ok(clocks.a.nextAt === BASE * 60000, 'the retry is one base interval away')

run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.intervalMin === BASE * 2, 'a second consecutive failure backs off once')
run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.intervalMin === BASE * 4, 'and a third doubles again')
ok(clocks.a.failures === 3, 'the streak is counted')

for (let i = 0; i < 20; i++) run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.intervalMin === MAX, 'a feed that never answers still decays to the ceiling')

// ---------- a success ends the streak ----------
clocks = { a: { intervalMin: 20, nextAt: 0, failures: 3 } }
run(clocks, { a: { added: 0 } })
ok(clocks.a.failures === undefined, 'a quiet answer clears the failure streak')
run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.intervalMin === BASE, 'so the next failure starts again from the base interval')

// ---------- a fleet-wide miss ----------
const fleet = {}
for (let i = 0; i < 377; i++) fleet['f' + i] = { intervalMin: MAX, nextAt: Number.MAX_SAFE_INTEGER }
const outcomes = {}
for (let i = 0; i < 377; i++) outcomes['f' + i] = { added: 0, failed: true }
run(fleet, outcomes, 1000)
const waits = Object.values(fleet).map((clock) => clock.nextAt - 1000)
ok(waits.every((wait) => wait === BASE * 60000),
  'a run where every feed misses retries the whole fleet in one base interval, not in a day')

finish('schedule')
