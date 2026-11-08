# gitfeed-native

A personal RSS reader rendered as a **native DeepSeek Harness plugin**: a reader
page in the right Sidebar (beside Files) and in the main panel, a Host-side
adaptive scheduler for feed refresh and read-state sync, and one compact
`gitfeed` agent tool.

The package is **code only**. The data it reads lives in a separate repository,
so installing, updating, and sharing the plugin never touches subscriptions,
items, or read state. The one thing it writes into the data repository is the
CI job: `gitfeed ci` drops a stand-alone bundle of this CLI beside the data, so
a scheduled fetch needs neither the code checkout nor a token.

## Two repositories, one reader

| repository | contents | visibility |
| --- | --- | --- |
| `zizon/gitfeed-native` (this one) | the plugin: TypeScript sources, bundle metadata, CLI | private today; publish it when ready |
| `zizon/gitfeed` | the reader data: `feeds.json`, `config.json`, `data/` | private, cloned to `~/gitfeed` |

Why split them:

- **The code can be public, the reading cannot.** Installing from GitHub means
  the plugin repository is readable by anyone. Subscriptions, fetched items,
  and read/star ids belong to the person reading them, so they stay in a
  repository that person owns. The data repository can stay private forever.
- **Updates stop colliding with data commits.** `git pull` for code and
  `git pull` for read state are now different repositories, so a plugin upgrade
  can never rebase your reading list.
- **The data is portable.** The plugin's default `repo` is `~/gitfeed`; cloning
  your data repository there is the whole setup. Nothing about the plugin pins
  a machine or a user.

The plugin still dogfoods: this checkout is developed against the real data
repository, and the CLI in this package runs the same `lib/host` fetcher the
reader uses.

## Quick start

1. Clone the data repository to `~/gitfeed` (or let the plugin write a starter
   root on first activation).
2. Install the bundle (see **Install**).
3. Open the **Feeds** card, subscribe, **Fetch**, read. If the root is a
   checkout, **Sync** pushes subscriptions and read state.

Each item row shows the title, its feed and age, and a one-line plain-text
digest of the summary, so a list can be skimmed and skipped without opening
every article. Display prefs turn the digest off (rows then use the shorter
two-line height); the choice is stored per browser.

Marking read follows the viewport. A bar floats at the bottom of the list and
its single target re-labels itself as the reader scrolls, always from the
strongest scope that is actually in effect: an active search wins, then a
selected source (`Mark Hacker News read`), then the group under the top edge
when grouping is on (`Mark Fresh read`), and otherwise the view-wide
`Mark all read`. A source therefore never widens to its folder, and with
neither grouping nor a source the label stays put instead of flipping with
every row. One click runs that scope, and the toast that follows carries
**Undo**, which takes the mark back in one more click. The bar's ▾ lists every scope with its count for an explicit choice;
there the library-wide entry sits behind a divider and needs a second,
differently placed click. No key marks in bulk. The Feeds list carries a
visible ✓ on every source with unread items and on every folder header, and
each list group header offers `Mark {n} read`.

Background refresh: the rail's second bar ends with the age of the last run
(`⟳ 2m`; it pulses while a run is in flight and the Fetch button spins then).
The ⋯ menu's **Refresh** block shows the interval and the last result
(`0 new · 35 failed`), and its **Sync** block shows the auto-sync interval,
the next run, and the last result. The main page's status line carries
`↻ 5m` for refresh and `⇄ 10m` for sync, both with the same detail in their
tooltips.

## Where it lives in the Harness UI

| surface | how to reach it |
| --- | --- |
| Right Sidebar page | the RSS button in the conversation header, or the **Feeds** card in the right Sidebar's **+** guide. It sits beside Files, Documents, Terminals, and Plans. |
| Main panel page | the gitfeed icon in the left Sidebar's global panel rail (beside Plugins and Tasks). This view also works without a session. |
| Agent tool | `gitfeed` in the Tool catalog. |

All surfaces share one client controller and one Host API, so read state and the
selected article stay consistent if both are open.

The main panel is the three-pane layout. The right Sidebar page is a single
pane until its tab is wide (680px or more, for example in fullscreen), where it
splits into list and article: drag the divider between them to resize, and
double-click it to reset. The width is stored with the main page's list width.

## Bundle registration

| surface | registration |
| --- | --- |
| right Sidebar page | `sidebarRightTabs` type `gitfeed` + `sidebar.right.pane.tab` body and title |
| right Sidebar guide | one **Feeds** card in the guide |
| session-header launcher | `conversation.session.header.utilities` |
| main panel | `main` key `gitfeed` + `sidebar.panellist` icon |
| agent tool | `ctx.tools.register({ name: 'gitfeed', ... })` |

The route and the scheduler are registered with `ctx.effect`, so both
disappear when the row unloads. `mark`/`star` responses carry the new state version, which
lets the Client poll compactly after an optimistic update.

## Install

Harness installs the bundle from GitHub the same way it installs any external
plugin: `plugin_manager` with the repository's Git address, or **Plugins → Add
source** in the Web UI.

While this repository is private, use the SSH address:

```json
{ "action": "install_bundle", "target": "git+ssh://git@github.com/zizon/gitfeed-native.git" }
```

After it is published, `github:zizon/gitfeed-native` (HTTPS, no key) works too.

pnpm clones the package into the profile, installs its `devDependencies`, and
runs `prepare` (`node build.mjs`), so the installed copy carries `lib/`,
`bin/`, and the bundle metadata. The profile records a git dependency pinned to
the installed commit.

pnpm blocks dependency build scripts by default. The first attempt stops with
the package listed under `pendingBuilds`; approve that
`gitfeed-native@<url>#<commit>` key (**Allow these scripts and retry** under
Plugins, or `approvedBuilds` on the tool's retry) and the installation
finishes.

### Data root

The plugin reads and writes one directory — the data root — resolved as:

1. `repo` in the Host row's `config:`,
2. `$GITFEED_REPO`,
3. `~/gitfeed`.

That directory holds `feeds.json`, `config.json`, `data/`, the gitignored
`.local/` refresh cache, and — once `gitfeed ci` ran — `.gitfeed/gitfeed.mjs`
with the generated `.github/workflows/fetch.yml`. It is a clone of the data
repository (or any checkout of it). When it is missing or empty, the first
activation writes a starter version so the reader mounts with an empty inbox
instead of an error:

```
feeds.json             {"feeds": []}
config.json            fetch/reader defaults
data/meta.json         {}
data/read.ndjson       (empty)
data/starred.ndjson    (empty)
.gitattributes         union-merge rules for read/starred/item lines
.gitignore             .local/ and friends
.gitfeed/gitfeed.mjs   stand-alone CLI bundle the CI job runs
.github/workflows/fetch.yml  scheduled fetch job
```

### A local copy vs a checkout

- **No git repository** (the starter root): everything works — subscribe, fetch,
  read, star — but `Pull` and `Sync` are disabled, because there is nothing to
  push to.
- **A git checkout** with an `origin`: `Pull` fetches items and read state from
  the remote; `Sync` commits `feeds.json`, `config.json`, `data/read.ndjson`,
  `data/starred.ndjson`, `.gitattributes`, and `.gitignore`, rebases, and
  pushes. The very first `Sync` of a freshly `git init`-ed directory commits the
  whole tree as the baseline and pushes with `-u origin HEAD` when no upstream
  exists yet.

To sync, create (or clone) your own data repository and point the plugin at it:

```bash
# a new private repository, seeded by the plugin
node ~/gitfeed-native/bin/gitfeed.mjs init ~/gitfeed   # from a code checkout
cd ~/gitfeed && git init -b main && git add -A \
  && git commit -m "gitfeed: starter data" \
  && git remote add origin git@github.com:<you>/gitfeed-data.git \
  && git push -u origin main

# or an existing data repository
git clone git@github.com:<you>/gitfeed-data.git ~/gitfeed
```

Once published, the same `init` is `npx --yes --package=github:zizon/gitfeed-native gitfeed init ~/gitfeed`.

Then set `repo` in the profile patch if the path is not `~/gitfeed`.

### Updating

After pushing a change to this repository, reinstall: `plugin_manager
remove_bundle` with `gitfeed-native`, then `install_bundle` with the same Git
address (in the Web UI, remove the source and add it again). The new commit
rebuilds through the same `prepare` script, and the approval key follows the new
commit. The data root is untouched.

## Fetching and syncing

### Adaptive scheduler

The Host plugin owns one scheduler for every periodic thing the reader does.
Each job has a base interval and a ceiling: a run that produced something
(items fetched, state committed or pulled) returns the job to its base
interval, while a quiet or failing run doubles the interval, up to the
ceiling. The scheduler sleeps until the earliest job is due instead of polling
on a fixed tick, so the Refresh and Sync clocks share one timer.

Two jobs are registered today. A new one implements `available`, `due`, and
`run` and is registered next to them in `src/host/service.ts`.

**Refresh** refills the gitignored `.local/` cache:

- base interval `refreshMinutes` (default 5), ceiling `maxIntervalMinutes`
  (default 1440, once a day);
- only while the reader made a request in the last `idleMinutes` (default 15),
  so a forgotten panel does not hammer feeds overnight;
- each run fetches only the feeds whose own clock is due. A feed that keeps
  producing items stays on the base interval; a feed that answers 304,
  produces nothing, or fails doubles its interval on every quiet run, up to
  the ceiling, and drops back the moment it produces an item. That is what
  keeps a barely-updated blog from being polled every five minutes;
- never into the committed `data/` tree, so a refresh cannot race a commit.

**Sync** publishes and repairs read state:

- local marks, stars, and subscription changes start a short debounce, so a
  session's marks are committed, rebased, and pushed about twenty seconds
  after the last change; a burst of scroll marks coalesces into one commit;
- on a quiet machine it backs off to `syncMaxMinutes` (default 60) and only
  pulls, which is how a second device's marks arrive without pressing Pull;
- it waits `syncMinutes` (default 10) before its first run, so a plugin
  update does not push on its first second; that first run publishes any read
  state that was already waiting for a manual Sync; `syncMinutes: 0` disables
  auto-sync while Pull and Sync stay manual;
- it needs `allowGit`, a git working tree, and an `origin` remote; otherwise
  the job reports why it is off, using the repository facts the status line
  already caches rather than shelling out per tick.

Set `adaptive: false` to fetch every feed on every run. The job clocks and the
per-feed clocks live in `.local/schedule.json` — machine-local, never
committed, version 2; a version-1 file (the fetch-only format) is read as the
Refresh job's state. **Fetch** in the reader still fetches everything.

### GitHub Actions in the data repository

`gitfeed init` writes the job into a new data root, and `gitfeed ci` writes it
into an existing one:

- `.gitfeed/gitfeed.mjs` — this package's CLI bundled into one Node script;
- `.github/workflows/fetch.yml` — a job that runs it on `1,31 * * * *` and
  commits `data/` with the repository's own `GITHUB_TOKEN`.

The job installs nothing and checks out nothing but the data repository, so the
code repository can stay private and no secret is needed. It runs
`node .gitfeed/gitfeed.mjs fetch`, then commits only `data/`, rebasing over a
read-state push from a machine. Commit both generated files when `gitfeed ci`
writes them; the schedule starts once the workflow is on the default branch
(GitHub also disables scheduled workflows in forks until enabled).

Run `gitfeed ci` again after upgrading the plugin so the committed bundle
matches the installed one.

### CLI

The package ships the `gitfeed` command; it runs the same `lib/host` modules the
plugin uses:

```bash
gitfeed fetch                    # data root: --root, $GITFEED_REPO, else cwd
gitfeed fetch --only=jvns-ca-atom-xml
gitfeed fetch --dry-run
gitfeed import-opml ~/Downloads/feeds.opml
gitfeed import-opml --replace ~/Downloads/feeds.opml
gitfeed init ~/gitfeed           # write the starter data root, with its CI job
gitfeed ci ~/gitfeed             # write/refresh the data repo's fetch job
gitfeed --help
```

From a checkout without installing global bin:

```bash
node bin/gitfeed.mjs fetch --root ~/gitfeed
```

### Cron

If the checkout lives on a machine that is always on, cron can keep the
committed `data/` tree current without the reader open — it runs the same
fetcher the generated workflow runs:

```bash
*/30 * * * * cd $HOME/gitfeed \
  && node .gitfeed/gitfeed.mjs fetch \
  && git add data \
  && git commit -qm "feed: $(date -u +%FT%TZ)" \
  && git push || true
```

The generated workflow is the alternative when no machine stays on.

## Reading UI

The native page follows the Harness theme, including light/dark/auto. It does
not carry its own theme setting.

- **Filters**: Unread / All / Starred.
- **Search** over title, summary, and feed title.
- **Feeds**: folders from the OPML import, collapsible; unread counts; error
  marks; add by feed URL or site URL (with discovery); unsubscribe removes the
  feed's items from both stores.
- **List**: one line per item, grouped by folder or source on request, with a
  `Mark {n} read` button on each group whose header sticks to the top while
  its group is in view. Rows are virtualized at fixed heights.
  A row that is marked read stays in the Unread list until the scope changes
  (filter, search, or source), so nothing shifts under the pointer while
  reading; a feed or folder that was on screen stays in the Feeds list for the
  same reason.
- **Read on scroll**: a row counts as read only after the viewport top passed
  it while moving down; rows a scrollbar drag skipped over are included.
- **Article**: sanitized feed HTML (element allowlist, `href`/`src`/`alt`/
  `title` only, http(s)/mailto URLs only), star, mark unread, open original.
  Past the opening of a piece a **Next →** control appears at the bottom of the
  pane, so moving on does not mean scrolling back up.
- **Pull / Fetch / Sync** in the top bar, where the one that applies now is
  filled and the others are plain: Pull while the branch is behind, Sync while
  the worktree is dirty, Fetch otherwise. Pull and Sync are disabled when the
  plugin `allowGit` switch is false, or when the data root is a local copy with
  no git repository; the rail menu then shows why.
- **Display preferences**: hide feeds with nothing unread, mark read on scroll,
  group by none/folder/source. Per-browser, in `localStorage`; the values in
  `config.json` are the defaults.
- **Keyboard**: `j`/`k` move, `m` toggle read, `s` star, `o` open original,
  `/` search, `u` unread, `a` all, `Esc` close article then clear search/feed.
  Bulk marking is deliberately not on a key.

Pane widths and open folders are remembered per browser.

### Design language

The reader is built from the Harness client's own components, not a private
copy of them: the Client bundle requires
`@deepseek-ai/dsh-client-ui-primitives` from the shared module table and marks
it external, so the page gets the same buttons, inputs, menus, switches,
toasts, and icons the rest of the GUI renders, plus any theme change that
reaches them. The plugin ships no CSS for those controls.

- **Adopted**: `Button` for the toolbar and inline actions, `Pill` for the
  filter and group-by chips, `Input` for search and the add-feed form,
  `Menu` for the marking scope, `MenuSurface` for the preferences popover and
  the rail menu, `Switch` for the display prefs, `Toast` for transient
  banners with an inline **Undo**, and the product `Icon*` set for the
  chevrons, checks, close, refresh, plus, ellipsis, and open-original glyphs.
- **Kept custom, deliberately**: feed and item rows, the sticky group header,
  the float that follows the list's scroll edge, and the article's
  `Next →` capsule — the atom set has no list-row, group-header, or
  floating-bar primitive, so these are a small token-styled sheet rather than
  copies of a shared control. The RSS mark, the star, and the unread dot are
  artwork the theme does not carry.
- **Tokens**: hover and selected fills use
  `--dsw-alias-interactive-bg-*`, text uses `--dsw-alias-label-*`, hairline
  dividers are `0.5px` of `--dsw-alias-border-l*`, radii come from
  `--dsw-radius-*`, and floating surfaces use
  `--dsw-alias-button-floating-fill` with `--dsw-elevation-panel`. The blue
  accent is `--dsw-alias-brand-primary-new-colorprimary-new-color`;
  `--dsw-alias-brand-primary` is the near-black/near-white fill colour.

Toasts are the shared banner, so they appear centred at the top of the page
and carry one action; Undo is the action rather than a link in a stack.

## Configuration

Data-root files: `feeds.json` is *what* you read, `config.json` is *how* the
fetcher and reader behave. The plugin's own schedule/git/tool switches live in
the plugin config, so they survive upgrades.

`feeds.json`:

```json
{
  "feeds": [
    { "id": "hn", "url": "https://news.ycombinator.com/rss" },
    { "id": "blog", "url": "https://example.com/feed.xml", "title": "Example", "folder": "News" },
    { "id": "noisy", "url": "https://example.com/rss", "disabled": true }
  ]
}
```

`config.json`:

| key | default | effect |
| --- | --- | --- |
| `fetch.concurrency` | 6 | feeds fetched in parallel |
| `fetch.timeoutMs` | 25000 | per-feed HTTP timeout |
| `fetch.keepMonths` | 6 | item shards older than this are deleted |
| `fetch.maxSummaryChars` | 2500 | HTML kept per item |
| `reader.hideEmptyFeeds` | true | initial state of "hide 0-unread" |
| `reader.markReadOnScroll` | true | initial state of "read on scroll" |
| `reader.groupBy` | none | initial grouping: none / folder / feed |

Plugin config (the Host row's `config:` in the profile patch):

The shipped defaults are declared in the bundle's `cordis.patch.yml`, so that
file doubles as the reference for every setting. A profile patch that targets
the `gitfeed` row replaces `config` wholesale (the Loader never deep-merges it),
so an override restates every key it should keep.

| key | default | effect |
| --- | --- | --- |
| `repo` | `$GITFEED_REPO` or `~/gitfeed` | data root (a checkout of the data repository or a starter copy) |
| `refreshMinutes` | 5 | minimum interval between refresh runs, and the interval a feed that keeps producing items gets; 0 disables the schedule |
| `idleMinutes` | 15 | stop scheduled refreshes after this long without a request |
| `adaptive` | true | per-feed intervals: quiet or failing feeds back off |
| `maxIntervalMinutes` | 1440 | ceiling of that backoff |
| `syncMinutes` | 10 | minutes between read-state syncs; marks push after a ~20 s debounce and a quiet reader backs off to `syncMaxMinutes`; 0 disables auto-sync |
| `syncMaxMinutes` | 60 | ceiling of the sync backoff |
| `allowGit` | true | expose Pull and Sync, enable auto-sync, and show the git status line |
| `tool` | true | register the `gitfeed` agent tool |

Precedence: **environment variable > `config.json` > built-in default** for
fetch/reader values; **environment variable > plugin config > built-in default**
for `refreshMinutes`, `adaptive`, `maxIntervalMinutes`, `syncMinutes`,
`syncMaxMinutes` and `allowGit`.

| env | overrides |
| --- | --- |
| `GITFEED_REPO` | plugin `repo` |
| `GITFEED_CONCURRENCY` | `fetch.concurrency` |
| `GITFEED_TIMEOUT_MS` | `fetch.timeoutMs` |
| `GITFEED_KEEP_MONTHS` | `fetch.keepMonths` |
| `GITFEED_LOCAL_FETCH_MIN` | plugin `refreshMinutes` (`0` disables) |
| `GITFEED_FETCH_ADAPTIVE` | plugin `adaptive` (`0` fetches every feed per run) |
| `GITFEED_FETCH_MAX_MIN` | plugin `maxIntervalMinutes` |
| `GITFEED_SYNC_MIN` | plugin `syncMinutes` (`0` disables auto-sync) |
| `GITFEED_SYNC_MAX_MIN` | plugin `syncMaxMinutes` |
| `GITFEED_ALLOW_GIT` | plugin `allowGit` (`0` disables) |

## Agent tool

| action | parameters | result |
| --- | --- | --- |
| `status` | — | repo, version, feed/item/unread counts, git and scheduler state |
| `list` | `query`, `feed`, `unreadOnly`, `starredOnly`, `limit` | compact item rows with a short excerpt |
| `get` | `id` | one item's plain-text summary (up to 12k chars) |
| `mark` | `ids`, `read` | changed count |
| `star` | `ids`, `starred` | changed count |
| `refresh` | — | fetcher summary |
| `subscribe` | `url`, `folder` | new feed entry |
| `unsubscribe` | `id` | removed feed id |
| `pull` / `sync` | — | git result; a local copy reports that it is not a working tree |

All of these call the same Host methods the reader uses.

## Data format

`data/items/2026-11.ndjson`, one item per line:

```json
{"id":"b77b13687363294f","feed":"simonwillison","title":"Quoting Kyle Kingsbury","link":"https://simonwillison.net/2026/Nov/1/kyle-kingsbury/","date":"2026-11-01T16:49:04.000Z","author":"","summary":"<blockquote>..."}
```

`id` is `sha1(feedId + "|" + guid-or-link)` truncated to 16 hex chars, so the
same entry is never imported twice, even if a feed reorders or re-publishes it.
`summary` is HTML truncated to `fetch.maxSummaryChars`.

`data/meta.json` holds per-feed ETag / Last-Modified so re-fetching a quiet feed
is a 304, plus the last error per feed, which the feed rail surfaces in red.

Read and star state are append-only id sets with `merge=union`:

```
data/read.ndjson merge=union
data/starred.ndjson merge=union
data/items/*.ndjson merge=union
```

The scheduled job never touches `read.ndjson`; the reader never touches the item
shards.

## Layout

```
package.json                bundle metadata: dsh.bundle patch, dsh.client module, bin, files, prepare
cordis.patch.yml            inserts the `gitfeed` Host row
src/index.ts                typed Host entry: route, scheduler, tool
src/cli.ts                  `gitfeed fetch | import-opml | init`
src/host/                   settings, scaffold, store, OPML, XML, fetch, git, scheduler, jobs, service, HTTP, tool
src/client/                 native reader: controller, hooks, components, styles, locales
src/shared/                 item/feed/state types shared by both halves
build.mjs                   tsc Host + esbuild Client into the loader envelope
tsconfig.host.json          Host compiler face (includes the CLI)
tsconfig.client.json        Client compiler face
lib/                        build output (gitignored; `prepare` builds it)
bin/gitfeed.mjs             CLI entry point
locale/                     bundle display metadata (en, zh)
icon.svg                    bundle icon
pnpm-workspace.yaml         pnpm settings (skips esbuild's optional postinstall)
node_modules/               build toolchain (gitignored)
```

The published package (`files` in `package.json`) contains `lib/`, `bin/`,
`cordis.patch.yml`, `locale/`, `icon.svg`, and this README. It never contains
feeds, items, or read state.

## Development

Editing `src/` and reinstalling is slow; build and reload in place instead:

```bash
cd ~/gitfeed-native
pnpm install                       # toolchain, runs prepare
node build.mjs                     # rebuild after an edit
```

Then point the plugin at this checkout by installing the bundle (or, for an
already installed profile, replace `node_modules/gitfeed-native` by a local
install) and toggle **Plugins → gitfeed-native** off/on. With HMR on, a linked
checkout's changed modules are replaced on the next profile recomposition (any
Plugin Manager change, or an edit to the profile patch), so a rebuilt `lib/`
usually takes effect without a restart; a `dsh web` restart is the fallback.
The Client bundle reloads on a page refresh once the plugin is re-activated.

The build uses `tsc` for the ESM Host tree and `esbuild` for the Client bundle,
both from `node_modules`. The Client resolves `react` and
`@deepseek-ai/dsh-client-ui-primitives` from the Harness platform module table
(both stay external in the bundle) and writes its own CSS against the
documented `--dsw-*` tokens.

### Quality gates

Three gates cover `src/` before a commit:

```bash
pnpm build       # tsc Host + esbuild Client into lib/
pnpm typecheck   # the same tsc passes, no output
pnpm lint        # oxlint, including the type-aware rules
```

Lint reads the single root `tsconfig.json`, so Host and Client files resolve
from one project; `pnpm lint:fix` also applies the formatting rules.

Strings are built with template literals, never `+`: `prefer-template` rejects
concatenation, `no-useless-concat` catches the literal-only case that rule
skips, and `@stylistic/template-curly-spacing` keeps `${…}` tight so the fixer
cannot leave `${  value}` behind. `lint:fix` runs the fixer twice because the
first pass rewrites concatenation and the second formats the interpolation it
produced.

## Publishing checklist

1. Confirm `git log` has no data files, secrets, or local paths.
2. Flip this repository to public (`gh repo edit --visibility public --accept-visibility-change-consequences`).
3. Update the install spec in the README (and in any profile) from the SSH form
   to `github:zizon/gitfeed-native`.
4. Tag the release and reinstall the bundle in the profiles that use it.

## Limitations

- **Only what the feed gives you.** Some feeds publish a teaser; "Open
  original" is one click away.
- **Not offline.** Images are hotlinked from the origin.
- **Fetching needs a fetcher somewhere.** The reader refreshes while a panel is
  open, cron covers a machine that is always on, and the data repository's
  generated workflow covers the rest. If none is running, items wait.
- **Loopback only.** The API is served by the Harness web server and refuses
  cross-origin requests; it is not designed to be exposed publicly.
- **The right Sidebar needs a session.** The main-panel page works without one.
- **Item history is pruned** to `fetch.keepMonths` (6) to keep the data repo
  small.
- **Feed health is manual.** Dead feeds show red in the rail and in
  `data/meta.json`; nothing emails you.
- **The installed copy is a build artifact.** Editing the profile's
  `node_modules/gitfeed-native` is overwritten by the next install; edit this
  checkout and reinstall.
- **The data repository is yours to back up.** Nothing in this package stores
  or uploads the data; a lost data checkout is a lost reading list.
