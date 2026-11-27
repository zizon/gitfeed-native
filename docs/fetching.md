# Fetching and syncing

Two adaptive jobs keep the reader current: one refills the gitignored cache from
the subscriptions, the other publishes and repairs the committed read state.
This note covers their cadence, the CLI that runs the same fetcher by hand, and
the cron entry for a machine that is always on. The runner contract behind them
is [`jobs.md`](jobs.md).

## Adaptive jobs

The Host plugin owns one job runner for every periodic thing the reader does.
Each job owns its cadence: a run that produced something (items fetched, state
committed or pulled) returns to the base interval, while a quiet run doubles it,
up to the ceiling — per feed for Refresh, one interval for Sync. A failure is
not quietness: it leaves the cadence alone and only schedules the next attempt,
because "this feed did not answer" says nothing about how often it publishes.
The runner stores what the job reports (`nextAt`, `intervalMin`), arms that
job's own timer, and renders the status line; it has no backoff policy of its
own.

Two jobs are registered today. A new one implements `available`, `due`, and
`run` and is added next to them in `src/host/service.ts`.

**Refresh** refills the gitignored `.local/` cache:

- base interval `refreshMinutes` (default 5), ceiling `maxIntervalMinutes`
  (default 1440, once a day);
- only while the reader made a request in the last `idleMinutes` (default 15),
  so a forgotten panel does not hammer feeds overnight;
- each run fetches only the feeds whose own clock is due. One record per feed
  holds two things: the **cadence** it earned by answering, and the **next
  attempt**. A feed that keeps producing items stays on the base interval; one
  that answers 304 or produces nothing doubles its cadence on every quiet run,
  up to the ceiling, and drops back the moment it produces an item. That is
  what keeps a barely-updated blog from being polled every five minutes;
- a failure moves only the next attempt: retry at the base interval, doubling
  per consecutive failure up to the ceiling, while the cadence stays where the
  feed earned it. So a bad afternoon cannot park an active feed for a day, and
  the first success resumes the real cadence instead of the ladder;
- a run in which **every attempted feed could not be reached** is the
  connection, not the subscriptions. Such a run judges no feed (an error badge
  means "this source is broken", not "the network was away"), advances no
  failure streak, leaves every cadence alone, and looks again in one base
  interval — so a laptop that wakes up, or a tunnel that ends, is back within
  minutes instead of on the ladder the outage built. The status line reports
  it as `the network is unreachable (N feeds)` rather than as N failed feeds.
  Three attempted feeds is the floor: one or two dead hosts are still just dead
  hosts;
- an answered feed that fails (`HTTP 4xx`, a body that is not XML) *is* a
  broken subscription: it retries on its ladder and its row carries the error
  until it answers again. A failure that got no answer at all — DNS, connect,
  or the per-feed deadline — counts toward the outage rule instead, because
  from the reader's side a dead server and a dead connection look alike;
- never into the committed `data/` tree, so a refresh cannot race a commit.

**Sync** publishes and repairs read state:

- local marks, stars, and subscription changes start a short debounce, so a
  session's marks are committed, rebased, and pushed about twenty seconds
  after the last change; a burst of scroll marks coalesces into one commit;
- on a quiet machine it backs off to `syncMaxMinutes` (default 60) and only
  pulls, which is how a second device's marks arrive without pressing Pull;
- it waits `syncMinutes` (default 10) before its first run, so a plugin
  update does not push on its first second; that first run publishes any read
  state that was already waiting for a manual Sync reads; `syncMinutes: 0`
  disables auto-sync while Pull and Sync reads stay manual;
- a remote that cannot be reached is retried at the base interval rather than
  backed off — the repository is fine, the connection is not — while a refusal
  (`Authentication failed`, a rejected push) backs off, because retrying it
  sooner changes nothing;
- it needs `allowGit`, a git working tree, and an `origin` remote; otherwise
  the job reports why it is off, using the repository facts the status line
  already caches rather than shelling out per tick.

Set `adaptive: false` to fetch every feed on every run. The job clocks and the
per-feed clocks live in `.local/schedule.json` — machine-local, never
committed, version 2; a version-1 file (the fetch-only format) is read as the
Refresh job's state. **Refresh** in the reader still fetches everything.

The cadence policy is the jobs'; the clock is the Harness's. The plugin
declares `inject: ['timer']` and takes each job's wake-up from `ctx.timeout`
(`@deepseek-ai/cordis-plugin-timer`, the mixin on the injected `timer` service,
which is what `src/index.ts` calls) on the plugin's fiber:
when a deadline moves, the old timer is disposed and a new one is armed, and a
reload or dispose cancels whatever is pending with the rest of the plugin. What
the timer service does not provide — per-feed backoff, the activity gate, the
stored burst deadline — lives with the job that needs it.

`ctx.timer.interval` is not used: the Refresh job's next run is the earliest
per-feed clock, not a period. `ctx.timer.debounce` is not used either: it lives
in memory, would be lost on reload, and cannot express the burst cap. The
debounce here is therefore a stored deadline (`nextAt`), evaluated by the same
pass as everything else. `ctx.schedule` (`@deepseek-ai/dsh-schedule`) is
durable and knows Cron and RRULE, but every occurrence it delivers becomes an
Agent turn in a Session, so using it would spend a model call per refresh.

The full contract and the primitive-by-primitive rationale are in
[`jobs.md`](jobs.md).

## No server-side job

Fetches run inside the Host, so there is nothing to deploy, no workflow to keep
in sync, and no token to hand to CI. The job runner refetches the feeds that are
due and the sync job pushes the result with whatever git credentials the
checkout already uses.

This package used to generate a GitHub Actions job for the data repository. It
was removed in 3.0.0 because GitHub never dispatched its schedule on this
account — with the evidence, the community reports behind it, and the restore
recipe in [`history/cloud-sync.md`](history/cloud-sync.md).

## CLI

The package ships the `gitfeed` command; it runs the same `lib/host` modules the
plugin uses:

```bash
gitfeed fetch                    # data root: --root, $GITFEED_REPO, else cwd
gitfeed fetch --only=jvns-ca-atom-xml
gitfeed fetch --dry-run
gitfeed fetch --refresh          # ignore cached ETags; re-read every feed
gitfeed import-opml ~/Downloads/feeds.opml
gitfeed import-opml --replace ~/Downloads/feeds.opml
gitfeed init ~/gitfeed           # write the starter data root
gitfeed --help
```

From a checkout without installing global bin:

```bash
node bin/gitfeed.mjs fetch --root ~/gitfeed
```

The reader's own **Import OPML** row imports an export from a file picked in the
page, with the same merge or replace choice as `--replace`; the CLI takes a path
because it runs outside a browser.

## Cron

The reader refreshes on its own while the Host runs. A machine that is always on
can additionally keep the committed `data/` tree current without the reader
open, by running the same fetcher from the installed CLI:

```bash
*/30 * * * * cd $HOME/gitfeed \
  && git pull --rebase --autostash -q \
  && node $HOME/gitfeed-native/bin/gitfeed.mjs fetch --root . \
  && git add data \
  && git commit -qm "feed: $(date -u +%FT%TZ)" \
  && git push || true
```

