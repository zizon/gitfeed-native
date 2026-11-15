// The per-feed clocks behind the Refresh job: what one run's outcome does to a
// feed's next attempt. Loads the built Host half, so it asserts the shipped
// rule, not the source.
//
// Two clocks live in one record. `intervalMin` is the cadence a feed earned by
// answering; `nextAt` is when it is attempted next, retry or cadence. A failure
// moves only the second, so a bad afternoon cannot park an active feed for a
// day. A run that reached nothing is the network, not the feeds: it moves
// nothing but the attempt and looks again in one base interval.
import { applyRun } from '../lib/host/schedule.js'
import { finish, ok } from './harness.mjs'

const BASE = 5
const MAX = 1440

function run(clocks, outcomes, nowMs = 0, offline = false) {
  applyRun(clocks, outcomes, { nowMs, baseMin: BASE, maxMin: MAX, offline })
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

// ---------- a miss is a retry, not a cadence ----------
clocks = { a: { intervalMin: 120, nextAt: 0 } }
run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.intervalMin === 120, 'a failed feed keeps the cadence it earned by answering')
ok(clocks.a.failures === 1, 'and the failure is remembered')
ok(clocks.a.nextAt === BASE * 60000, 'the retry is one base interval away')

run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.intervalMin === 120, 'a second failure still leaves the cadence alone')
ok(clocks.a.nextAt === BASE * 2 * 60000, 'and backs the retry off once')
run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.failures === 3, 'the streak is counted')
ok(clocks.a.nextAt === BASE * 4 * 60000, 'a third failure doubles the retry again')

for (let i = 0; i < 20; i++) run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.nextAt === MAX * 60000, 'a feed that never answers backs its retries off to the ceiling')
ok(clocks.a.intervalMin === 120, 'and still remembers the cadence it earned')

// ---------- a success ends the streak and resumes the cadence ----------
clocks = { a: { intervalMin: 20, nextAt: 0, failures: 3 } }
run(clocks, { a: { added: 0 } })
ok(clocks.a.failures === undefined, 'a quiet answer clears the failure streak')
ok(clocks.a.intervalMin === 40, 'and doubles the cadence, not the retry ladder')
run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.nextAt === BASE * 60000, 'so the next failure starts again from the base interval')

// A feed that was active and then missed for hours resumes active, not parked.
clocks = { a: { intervalMin: BASE, nextAt: 0 } }
for (let i = 0; i < 10; i++) run(clocks, { a: { added: 0, failed: true } })
ok(clocks.a.nextAt === MAX * 60000, 'the retry ladder has reached the ceiling')
run(clocks, { a: { added: 1 } })
ok(clocks.a.intervalMin === BASE, 'the first new item puts an active feed back on its base cadence')

// ---------- a run that reached nothing is the network ----------
// The feed was parked at the ceiling by a quiet afternoon; one missed
// connection must not cost it another day, and must not count against it.
let missed = { a: { intervalMin: MAX, nextAt: 5 } }
run(missed, { a: { added: 0, failed: true } }, 5, true)
ok(missed.a.intervalMin === MAX, 'a network miss leaves the parked cadence where it was')
ok(missed.a.failures === undefined, 'and does not count against the feed')
ok(missed.a.nextAt === 5 + BASE * 60000, 'the whole fleet is looked at again in one base interval')

// A streak built while the network was up survives an outage, so a broken
// source that happens to fail during one keeps its place on its own ladder.
missed = { a: { intervalMin: BASE, nextAt: 0, failures: 4 } }
run(missed, { a: { added: 0, failed: true } }, 0, true)
ok(missed.a.failures === 4, 'a network miss neither advances nor clears an existing streak')
ok(missed.a.nextAt === BASE * 60000, 'and the retry is the base interval')

// Repeated outages never leave the fleet waiting hours for the connection to
// come back: every attempt is one base interval from the last.
let fleet = {}
for (let i = 0; i < 377; i++) fleet['f' + i] = { intervalMin: 37, nextAt: 0 }
let lastNow = 0
for (let round = 0; round < 48; round++) {
  const outcomes = {}
  for (let i = 0; i < 377; i++) outcomes['f' + i] = { added: 0, failed: true }
  lastNow = round * BASE * 60000
  run(fleet, outcomes, lastNow, true)
}
const waits = Object.values(fleet).map((clock) => clock.nextAt - lastNow)
ok(waits.every((wait) => wait === BASE * 60000),
  'four hours of a dead connection: the next attempt is still one base interval away')
ok(Object.values(fleet).every((clock) => clock.intervalMin === 37),
  'and no feed lost the cadence it had earned')

finish('schedule')
