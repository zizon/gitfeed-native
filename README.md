# gitfeed-native

A personal RSS reader rendered as a **native DeepSeek Harness plugin**: a reader
page in the right Sidebar (beside Files) and in the main panel, a Host-side
refresh schedule, git sync, and one compact `gitfeed` agent tool.

The package is **code only**. The data it reads lives in a separate repository,
so installing, updating, and sharing the plugin never touches subscriptions,
items, or read state.

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
repository, and the CLI in this package is what the data repository's
GitHub Actions job runs.

## Quick start

1. Clone the data repository to `~/gitfeed` (or let the plugin write a starter
   root on first activation).
2. Install the bundle (see **Install**).
3. Open the **Feeds** card, subscribe, **Fetch**, read. If the root is a
   checkout, **Sync** pushes subscriptions and read state.

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

The route and the schedule are registered with `ctx.effect`, so both disappear
when the row unloads. `mark`/`star` responses carry the new state version, which
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

That directory holds `feeds.json`, `config.json`, `data/`, and the gitignored
`.local/` refresh cache, and is a clone of the data repository (or any checkout
of it). When it is missing or empty, the first activation writes a starter
version so the reader mounts with an empty inbox instead of an error:

```
feeds.json             {"feeds": []}
config.json            fetch/reader defaults
data/meta.json         {}
data/read.ndjson       (empty)
data/starred.ndjson    (empty)
.gitattributes         union-merge rules for read/starred/item lines
.gitignore             .local/ and friends
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

## Fetching

### Local fast refresh

While the reader is open, the Host plugin refreshes into the gitignored
`.local/` cache:

- every `refreshMinutes` (plugin config, default 5);
- only after the reader made a request in the last `idleMinutes` (default 15),
  so a forgotten panel does not hammer feeds overnight;
- never into the committed `data/` tree, so it cannot race the Actions job.

Set `refreshMinutes: 0` to disable the schedule. **Fetch** in the reader still
works.

### GitHub Actions in the data repository

The data repository owns the cloud fetch job (the code repository cannot: it has
no data). A minimal workflow:

```yaml
name: fetch

on:
  schedule: [{ cron: "1,31 * * * *" }]
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: fetch
  cancel-in-progress: false

jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: { node-version: 22 }
      - run: npx --yes --package=github:zizon/gitfeed-native gitfeed fetch
      - name: Commit new items
        run: |
          git config user.name "gitfeed"
          git config user.email "gitfeed@users.noreply.github.com"
          git add data
          git diff --staged --quiet && exit 0
          git commit -m "feed: $(date -u +%Y-%m-%dT%H:%MZ)"
          git pull --rebase --autostash
          git push
```

`npx` needs the plugin repository to be readable from the job: public, or a
token/deploy key for a private one. GitHub disables scheduled workflows in forks
until you enable them, and private repositories bill Actions minutes (the npm
install of a git package is the expensive part; hourly is the safe cadence on
the free tier, 30-minute runs fit a paid plan).

### CLI

The package ships the `gitfeed` command; it runs the same `lib/host` modules the
plugin uses:

```bash
gitfeed fetch                    # data root: --root, $GITFEED_REPO, else cwd
gitfeed fetch --only=jvns-ca-atom-xml
gitfeed fetch --dry-run
gitfeed import-opml ~/Downloads/feeds.opml
gitfeed import-opml --replace ~/Downloads/feeds.opml
gitfeed init ~/gitfeed           # write the starter data root
gitfeed --help
```

From a checkout without installing global bin:

```bash
node bin/gitfeed.mjs fetch --root ~/gitfeed
```

### Cron instead of Actions

```bash
*/30 * * * * cd $HOME/gitfeed \
  && node $HOME/gitfeed-native/bin/gitfeed.mjs fetch \
  && git add data \
  && git commit -qm "feed: $(date -u +%FT%TZ)" \
  && git push || true
```

## Reading UI

The native page follows the Harness theme, including light/dark/auto. It does
not carry its own theme setting.

- **Filters**: Unread / All / Starred.
- **Search** over title, summary, and feed title.
- **Feeds**: folders from the OPML import, collapsible; unread counts; error
  marks; add by feed URL or site URL (with discovery); unsubscribe removes the
  feed's items from both stores.
- **List**: one line per item, grouped by folder or source on request, with a
  **Mark read** button on each group. Rows are virtualized at fixed heights.
- **Read on scroll**: a row counts as read only after it was visible and then
  left through the top of the list.
- **Article**: sanitized feed HTML (element allowlist, `href`/`src`/`alt`/
  `title` only, http(s)/mailto URLs only), star, mark unread, open original.
- **Pull / Fetch / Sync** in the top bar. Pull and Sync are disabled when the
  plugin `allowGit` switch is false, or when the data root is a local copy with
  no git repository; the rail menu then shows why.
- **Display preferences**: hide feeds with nothing unread, mark read on scroll,
  group by none/folder/source. Per-browser, in `localStorage`; the values in
  `config.json` are the defaults.
- **Keyboard**: `j`/`k` move, `m` toggle read, `s` star, `o` open original,
  `/` search, `u` unread, `a` all, `Shift+A` mark everything listed read,
  `Esc` close article then clear search/feed.

Pane widths and open folders are remembered per browser.

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

| key | default | effect |
| --- | --- | --- |
| `repo` | `$GITFEED_REPO` or `~/gitfeed` | data root (a checkout of the data repository or a starter copy) |
| `refreshMinutes` | 5 | local refresh interval; 0 disables the schedule |
| `idleMinutes` | 15 | stop scheduled refreshes after this long without a request |
| `allowGit` | true | expose Pull and Sync to the reader and the tool |
| `tool` | true | register the `gitfeed` agent tool |

Precedence: **environment variable > `config.json` > built-in default** for
fetch/reader values; **environment variable > plugin config > built-in default**
for `refreshMinutes` and `allowGit`.

| env | overrides |
| --- | --- |
| `GITFEED_REPO` | plugin `repo` |
| `GITFEED_CONCURRENCY` | `fetch.concurrency` |
| `GITFEED_TIMEOUT_MS` | `fetch.timeoutMs` |
| `GITFEED_KEEP_MONTHS` | `fetch.keepMonths` |
| `GITFEED_LOCAL_FETCH_MIN` | plugin `refreshMinutes` (`0` disables) |
| `GITFEED_ALLOW_GIT` | plugin `allowGit` (`0` disables) |

## Agent tool

| action | parameters | result |
| --- | --- | --- |
| `status` | — | repo, version, feed/item/unread counts, git and refresh state |
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
src/index.ts                typed Host entry: route, schedule, tool
src/cli.ts                  `gitfeed fetch | import-opml | init`
src/host/                   settings, scaffold, store, OPML, XML, fetch, git, service, HTTP, tool
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
install) and toggle **Plugins → gitfeed-native** off/on. The Host entry module
is cached by the process, so a `dsh web` restart is the reliable reload; the
Client bundle reloads on a page refresh once the plugin is re-activated.

The build uses `tsc` for the ESM Host tree and `esbuild` for the Client bundle,
both from `node_modules`. The Client imports only `react` from the platform
module table and styles with the documented `--dsw-alias-*` theme tokens.

## Publishing checklist

1. Confirm `git log` has no data files, secrets, or local paths.
2. Flip this repository to public (`gh repo edit --visibility public --accept-visibility-change-consequences`).
3. Update the install spec in the README (and in any profile) from the SSH form
   to `github:zizon/gitfeed-native`.
4. In the data repository: uncomment the `schedule:` line in
   `.github/workflows/fetch.yml` (it installs the CLI with `npx` from the now
   public repository).
5. Tag the release and reinstall the bundle in the profiles that use it.

## Limitations

- **Only what the feed gives you.** Some feeds publish a teaser; "Open
  original" is one click away.
- **Not offline.** Images are hotlinked from the origin.
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
