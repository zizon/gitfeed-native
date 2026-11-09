# The async contract, surface by surface

Review of 2026-11-09, at `8c51885`. Scope: every boundary the package exposes —
the npm entry points, the HTTP API and the event stream, the Host service the
tools and the routes call, the Client transport and controller, the agent tools,
and the CLI. Internal helpers are included where they sit on a boundary.

The question this answers: where does the code hand data across a boundary
without saying what happens when the receiver is slower than the producer, and
what should that boundary look like instead?

Two things are out of scope by design, not by omission: pure derivations
(`derive.ts`, `window.ts`, `xml.ts`, `live.ts`'s diff) and the browser snapshot
store. They are synchronous because they compute, not transfer; making them
promises would buy nothing and cost every render.

---

## The rules this review measures against

1. **A boundary that can wait returns a promise, and takes an `AbortSignal` when
   it can be cancelled.** No `void` for work whose outcome the caller may need.
2. **A sink that can fall behind answers for its capacity.** Either it is an
   `AsyncIterable` the producer pulls (backpressure by construction), or a
   `write(value): boolean` with `'drain'` — never a `void` callback that hides a
   queue.
3. **Buffering is owned by a named component with a bound and a policy.** If
   something buffers, the buffer has an owner, a size, and a documented
   behaviour for overflow (drop the consumer, resync, or a typed failure).
4. **A failure is a rejection or a frame, never a silent drop.**
5. **Lifetimes are explicit.** Every subscription, iterator, and timer has a
   disposer or a signal, owned by the context that created it.

---

## Inventory

### Public package surface (`package.json` exports, `bin`)

| Entry | Current | Gap | Target |
|---|---|---|---|
| `.` → `apply(ctx, config)` | sync | seeding + job registration are sync; an async `apply` would let the first read happen before the route opens | stays sync; the first read belongs to the first consumer (`frames`) |
| `.` → agent tools `execute` | `Promise<unknown>` | none | as is; tool errors reject |
| `./client` → `apply(ctx)` | sync registration | none (slot/locale APIs are sync) | as is |
| `bin/gitfeed` → `main(argv)` | `Promise<number>` | none | as is |
| locale/icon exports | static | none | as is |

**Verdict:** the package entries are fine. The gap is inside what they expose.

### HTTP API (`/gitfeed/api/*`, `/gitfeed/events`)

| Route | Current | Gap | Target |
|---|---|---|---|
| `state`, `search`, `mark`, `star`, `feeds*`, `fetch`, `pull`, `sync` | async handler, JSON body read | the request's abort signal is ignored: a client that hangs up still pays for the whole build; `getState` cannot be cancelled between awaits | handlers pass the response's lifetime into the service call; long reads check it |
| `item` | async handler | none: one row, whole, asked for by the article that shows it | as is |
| `/gitfeed/events` | async handler, **sync `send(frame)`** | the sink has no capacity; the handler invented a queue and a 64 MB bound, and dropped the connection when a frame exceeded it | `service.frames(rev, signal): AsyncIterable<StreamFrame>`; the handler awaits each write; the live log is the only buffer and it is already bounded |

**Verdict:** the stream route is the one real violation — rule 2 — and it is the
one that produced the outage.

### Host service (`createGitfeed`'s returned object)

| Method | Current | Gap | Target |
|---|---|---|---|
| `getState` | async | not cancellable | `(knownVersion?, knownItemsVersion?, signal?)` |
| `mark`, `star` | async | none | as is |
| `addFeed`, `removeFeed`, `setFeedFolder` | async | none | as is |
| `runLocalFetch`, `pull`, `sync` | async | none | as is |
| `search` | async | not cancellable | takes a signal; the chunked index build checks it |
| `attach(rev, send)` | async + **sync void sink** | the violation | `frames(rev, signal): AsyncIterable<StreamFrame>` |
| `refresh` | async, internal | does not take a signal | internal; unchanged |
| `settings()` | **sync**, cached read | a sync file read on the Host loop when the cache misses | `settings(): Promise<RepoConfig>` behind the same cache, or keep sync with the cache documented |
| `dispose` | sync | by design | as is |

**Verdict:** everything but the stream sink is async already; the missing piece
is cancellation, not promise-ness.

### Host internals that sit on a boundary

| Module | Current | Gap | Target |
|---|---|---|---|
| `runner.ts` `timers.timeout(cb, delay)` | disposer; the callback may return a promise the Host timer ignores | a pass is tracked by `runtime.chain`, so overlap is handled — but the timer surface is a `void` callback | acceptable; note the contract (a pass must be tracked by the caller) |
| `fetch.ts` `onLog(line)` | sync `void` sink | a progress sink, bounded by feeds per run; not a data path | stays sync, documented |
| `fetch.ts` `runFetch` | async | `pool` has no cancellation; a hung feed is bounded by the per-feed abort timer | fine |
| `store.ts` file IO | promises (`writeJson` returns one without `async`) | none | as is |
| `custom.ts` `runCustom` | async + `AbortSignal` | none | as is |
| `git.ts` | async (`execFile` with a timeout) | none | as is |
| `service.readSnapshot(cfg, version)` | async, **caller-measured version** | version and content are read at two instants; a write between them names a state it did not read | `readSnapshot(cfg)` measures and reads together, or returns the measured version |

**Verdict:** one TOCTOU-shaped contract (`readSnapshot`) and one noted-but-fine
callback.

### Client

| Surface | Current | Gap | Target |
|---|---|---|---|
| `transport.search` | `Promise<string[]>` | no `AbortSignal`; a superseded query still runs on the Host | takes a signal; the controller aborts the previous query |
| `transport.mark` | `void`, optimistic + 350 ms flush | the flush result is delivered as a toast from inside the transport; the caller cannot observe it | `mark(): Promise<void>` settled when the flush lands (the UI still ignores it) |
| `transport.load` | `Promise<void>` that resolves without data | the name promises a load the design removed | rename to `reconnect(): void` and give the Retry button its own call |
| `transport.addFeed` etc. | `Promise` | none | as is |
| `controller.*` command methods | sync | appropriate for event handlers; the async work is published through the snapshot | as is, except `setQuery` (below) |
| `controller.setQuery` | sync, starts an async search | the search cannot be cancelled; correctness is kept by a sequence counter | abort the previous request; keep the sequence guard |
| `hooks`, `prefs`, snapshots | sync | appropriate | as is |

**Verdict:** the Client is mostly coherent — an optimistic command surface over
an async transport, publishing by snapshot. The gap is cancellation, and one
name (`load`) that no longer describes what it does.

---

## Findings, ranked

1. **The stream sink is a `void` callback with a hidden queue (rule 2).** It
   produced a production outage: a size guard on the wrong side of the write.
   The fix is structural, not another guard: make the consumer pull.
2. **No cancellation anywhere on the Host request paths (rule 1).** A search or a
   state build keeps running after the client is gone; `search` can build a
   whole index for a keystroke nobody is waiting for.
3. **`readSnapshot` names a version it did not read (rule 1/5).** Small window,
   real wrongness: the delta after it can be computed against a state that never
   existed.
4. **The Client cannot cancel its own query (rule 1).** The sequence counter
   keeps the *result* correct but the Host still does the work.
5. **`load()` is a promise that loads nothing (rule 1's spirit).** A name that
   lies is an async design failure even when the code is right.
6. **A write failure had no reader (rule 5's spirit).** Rule 2 says a sink's
   outcome must reach its owner; `writeChunk` answered a boolean, and the handler
   turned every `false` into `break`. A broken socket and a reader closing its tab
   became the same event, and the `Error` the write callback carries went nowhere.
   The stream could fail in the wild with no line anywhere saying so.

## Migration plan

Each slice is independently reviewable and leaves the reader working.

| Slice | Change | Files | Risk |
|---|---|---|---|
| **S1 (landed)** | `service.frames(rev, signal)` replaces `attach`; the SSE handler awaits each write; the handler-side queue and its 64 MB bound go away; the live log (bounded, with resync) becomes the only buffer | `service.ts`, `live.ts`, `events.ts`, tests | done — 21/21 suites |
| S2 | `search(query, signal)` and `getState(..., signal)`; the Client aborts a superseded query | `service.ts`, `http.ts`, `transport.ts`, `controller.ts` | low |
| S3 | `readSnapshot` owns its measurement; callers stop passing a version | `service.ts` | low |
| S4 | `mark(): Promise<void>`, `load` → `reconnect()`; the transport stops owning UI toasts for flush failures (the controller does) | `transport.ts`, `controller.ts`, components | low |
| S5 | `settings()` async behind the existing cache, or the cache documented as the reason it may stay sync | `settings.ts`, call sites | low |
| S6 | Request-signal plumbing on the HTTP routes (abort the build when the client hangs up) | `http.ts`, `index.ts` | low |
| **S7 (landed)** | The chunk write keeps the promise contract: it rejects with the error the platform reported and resolves when the surface is gone. The handler holds the one catch boundary — nobody above it can be told — which names the first failure per stream, with the revision it broke at. `source.frames()` moves inside the `try`, and the per-frame cancellation promise is hoisted out of the loop | `events.ts`, `index.ts`, tests | done — 22/22 suites |

**Progress.** S1–S7 are landed or resolved as of 3.8.2, each with tests in the
suite that owns its surface (`stream.test`, `live.test`, `controller.test`,
`search.test`, `items-model.test`). The findings above are kept as written: they
describe the code the review was run against, not the code that replaced it.

## What this buys

The stream stops having a size policy: a slow surface simply does not advance its
revision cursor, and the bounded history decides whether it catches up by delta
or by a fresh snapshot. There is no number to tune, no way for one frame to look
like a stalled peer, and no queue in the request handler to get wrong again. The
same shape then applies to the other directions: a query that nobody is waiting
for is aborted rather than completed, and a caller that goes away takes its work
with it.

## Enforcement

Two oxlint rules keep this shape from drifting back: `no-empty` and
`no-empty-function`. Both treat a comment as content, so an empty `catch` or an
empty `.catch(function () {})` now fails the lint unless its body says why. The
silence has to be a decision someone wrote down, which is what the stream's write
outcome was missing when it was a bare `false`.

The same idea decides what a failure *is*. `InputError` (`shared/errors.ts`)
marks the requests the caller got wrong — a missing field, an id that names
nothing, a URL with no feed behind it — and the HTTP route answers 400 for the
type and 500 for the rest. That status used to be chosen by matching the message
against a regular expression, so rewording a sentence silently changed the status
code, and any message nobody had taught the expression answered 500.
