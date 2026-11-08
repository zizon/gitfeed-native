# Scheduler design and contract

The reader has one scheduler, in `src/host/scheduler.ts`. This note is the
contract it implements, the primitives it is built from, and the boundary
between them — so a change can be reviewed against behaviour instead of against
the previous implementation.

## Contract

These are the behaviours the reader depends on. They are asserted by
`tests/scheduler.test.mjs` (C1–C9) and by the item-model and `/state` suites
where marked.

| # | behaviour |
|---|---|
| C1 | each job has a base interval and a ceiling; a run that produced something returns to base, a quiet or failing run doubles, capped |
| C2 | the Refresh job keeps one clock per feed and runs when the earliest is due |
| C3 | Refresh pauses after `idleMinutes` without a reader request |
| C4 | local marks reach the remote about 20 s after the last one, and never later than the cap into a burst |
| C5 | a failing job backs off and is not retried early by a change of state |
| C6 | `Fetch`/`Sync`/`Pull` run now, serialized with any background run |
| C7 | deadlines survive a restart; the file is machine-local and never committed; version 1 is still read |
| C8 | the status line reports interval, next due, last run, last result, and running |
| C9 | a failing run is a warning, not a crash |

## Boundary

**The clock is the Host's.** The plugin declares `inject: ['timer']` and passes
`ctx.timer`'s `timeout` down as the `SchedulerTimers` surface (`src/index.ts`).
Every wake-up a job has is one timeout on the plugin's fiber.

**Each job is a timer chain, with a handle.** `scheduler.add(job)` returns a
`JobHandle`: the handle owns the verbs for that job (`runNow`, `nudge`), so no
caller names a job by string, and there is nothing to start — adding a job is
arming it. There is no global heartbeat, no wake-up arithmetic shared between
jobs, and no timer the scheduler keeps for itself.

**The interface is four verbs, none of them a lifecycle.**

| verb | who calls it | what it does |
|---|---|---|
| `add(job)` | the service, twice, at construction | registers the job, arms its first deadline, returns its handle |
| `handle.runNow(scope)` | the Fetch/Sync buttons | runs the job in its chain, then re-arms |
| `handle.nudge(delay, cap)` | a mark, a star, a subscription change | moves the deadline to the end of the burst |
| `touch()` | every `/state` request | re-arms jobs that slept through an idle window |
| `status()` | `/state`, the agent tool | the job list the UI renders |
| `dispose()` | the plugin's teardown effect | makes an in-flight pass inert |

Start/stop are missing on purpose: the timers are created through `ctx.timer`
from the plugin's own context, so they belong to its fiber and disappear with
it. `tick` is missing too — a fake timer in the suites advances time and awaits
the pass a deadline started, which is the same path production takes.

**Deadlines are data.** `.local/schedule.json` holds, per job: `intervalMin`,
`nextAt`, `quiet`, `failures`, `lastRunAt`, `lastOkAt`, `last`, and the job's
own `data` (the fetch job's per-feed clocks). Losing a timer to a reload loses
no work: the next mount arms every job from the same numbers.

**One writer per field.** A run's outcome writes its own state; `debounce`
writes `nextAt` for a burst; per-feed clocks travel in `data`; `runNow` writes
nothing, it runs the job directly; `touch` writes only `lastActivity` and
re-arms jobs that slept through an idle window.

## The primitives, and what each is used for

| primitive | here | why not more |
|---|---|---|
| `ctx.timer.timeout` | **the schedule**: one per job, disposed and re-armed as the deadline moves | — |
| `ctx.timer.interval` | not used | the fetch job's next run is the earliest per-feed clock, not a period; a fixed interval cannot express it |
| `ctx.timer.debounce` | not used | it is in-memory and dies on reload, and the burst cap ("never later than N from the start of the burst") is not expressible with it; the deadline is persisted instead |
| `ctx.timer.throttle` | not used | a burst cap is a deadline, not a rate limit |
| `ctx.schedule` | not used | durable Cron, but each occurrence is an Agent turn |

## Anatomy

```
arm(job)                     disarm previous, derive delay from nextAt
  ├ paused (reader away)     hold no timer; `touch` arms it again
  └ otherwise                ctx.timer.timeout(fire, delay)        ← the wake-up

fire(job)   one pass in the job's chain, then arm(job) again
  guard: stopped / already running or queued   ► skip
  ensureLoaded()                               (once; persisted deadlines)
  paused?                                      ► hold no timer
  nextAt > now                                 ► arm for the remaining delay
  available()                                  ► false: nextAt = now + base
  due(now, data)                               ► false: nextAt = decision.nextAt ?? now + base
  run(context)                                 ► applyOutcome → nextAt, backoff, last
                                               ► persist
                                               ► onRun (drop caches)
                                               ► arm(job)
```

`runNow` disarms the job's timer, runs the job directly in the same chain, then
arms again. A manual run therefore cannot collide with a scheduled one, and it
does not disturb the backoff.

`applyOutcome` floors the next run at one second (`MIN_RERUN_MS`): a job that
asks to rerun immediately still waits a beat, so a nextAt in the past cannot
spin the reader.

## Deliberate behaviour changes from the hand-rolled clock

| change | reason |
|---|---|
| the first pass runs at mount instead of 12 s later | an overdue deadline should catch up, and nothing needs a settling wait |
| a paused job holds no timer | a timer for a deadline that will be skipped is waste; the reader's next request arms it |
| the debounce cap is a stored deadline, not a live debounce | it must survive a reload and it must not be swallowed by a running job |

## Cost

Measured with scratch scripts (not in CI): a deadline wake-up is O(1), and
re-arming a job disposes and creates one timeout (~80 µs). In steady state the
reader wakes when something is due — on the order of a few hundred wake-ups a
day — instead of on a fixed beat. Marks arm the sync job each time they move
its deadline; that is the only churn, and it is bounded by the mark rate.

## Ratchet

`tests/architecture.test.mjs` fails if:

- any Host module arms its own `setTimeout`/`setInterval` (`fetch.ts` is the
  documented exception: an HTTP abort deadline, shared with the CLI, not a
  schedule);
- `SchedulerTimers` grows beyond its single `timeout` method;
- the plugin stops injecting `timer` or stops taking wake-ups from
  `ctx.timeout`.

`tests/plugin-timer.test.mjs` mounts the real plugin in a real Cordis context
with `@deepseek-ai/cordis-plugin-timer` and asserts one wake-up per job on
mount, that a self-rearming job keeps firing, and that disposal and reload
leave nothing armed. It needs a Harness checkout (`DSH_CHECKOUT` or a sibling
`deepseek-harness`) and skips visibly without one.

## Running

```bash
pnpm test        # builds, then runs every suite under tests/
```
