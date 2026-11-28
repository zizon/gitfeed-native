# Building and releasing

Where the pieces live, how to build a checkout and reload it in place, the four
quality gates, and the release path. The reader's contracts are in the other
notes ([`jobs.md`](jobs.md), [`list-state.md`](list-state.md),
[`async-api.md`](async-api.md)).

## Bundle registration

| surface | registration |
| --- | --- |
| right Sidebar page | `sidebarRightTabs` type `gitfeed` + `sidebar.right.pane.tab` body and title |
| right Sidebar guide | one **Feeds** card in the guide |
| session-header launcher | `conversation.session.header.utilities` |
| main panel | `main` key `gitfeed` + `sidebar.panellist` icon |
| agent tool | `ctx.tools.register({ name: 'gitfeed', ... })` |

The API route is registered with `ctx.effect` and the scheduler takes its
timers from `ctx.timeout`, so both disappear when the row unloads. `mark`/`star` responses carry the new state version, which
lets the Client poll compactly after an optimistic update.

## Layout

```
package.json                bundle metadata: dsh.bundle patch, dsh.client module, bin, files, prepare
cordis.patch.yml            inserts the `gitfeed` Host row
src/index.ts                typed Host entry: route, job runner, tools, skill
src/cli.ts                  `gitfeed fetch | import-opml | init`
src/host/                   settings, scaffold, store, OPML, XML, document, custom, brief, skill, fetch, git, runner, jobs, live, events, service, HTTP, tool
.github/workflows/          ci.yml (gates) and release.yml (tag to npm and a GitHub release)
tests/                      behaviour suites, fixtures, and the runner (`pnpm test`)
docs/reading.md             the page, the list's model, the source order, the design language
docs/state-stream.md        the event stream: deltas, revisions, digests, measured cost
docs/fetching.md            the jobs' cadence, the CLI, cron
docs/data-format.md         item shards, the two stores, the merge rules
docs/custom-feeds.md        custom feeds: the script interface and the rules
docs/jobs.md                runner contract, primitives, and the ratchet
docs/engineering.md         this note: registration, layout, build, gates, release
docs/history/               point-in-time records: the removed Actions job, cloud sync
docs/screenshots/           the images the README shows (shipped with the package)
src/client/                 native reader: controller, transport (the event stream), derivations, viewport, prefs, hooks, components, styles, locales
                            Names follow the Host's own convention: React component
                            files are PascalCase (`FeedRail.tsx`), every other file
                            and directory is lowercase or kebab-case
                            (`job-words.ts`, `transport-core.ts`, `styles/list.ts`).
src/shared/                 the types both halves import, the stream protocol and its merge, and the one runtime helper they share
src/skill/                  the custom-feeds skill: workflow, interface, failure modes
examples/                   a custom feed script: the Google Research list the docs walk through
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
`cordis.patch.yml`, `locale/`, `icon.svg`, `docs/screenshots/`, and the README.
It never contains feeds, items, or read state.

## Development

Editing `src/` and reinstalling is slow; build and reload in place instead:

```bash
cd ~/gitfeed-native
pnpm install                       # toolchain, runs prepare
node build.mjs                     # rebuild after an edit
```

Then point the plugin at this checkout by installing the bundle (or, for an
already installed profile, replace `node_modules/@zizon/gitfeed-native` by a
local install) and toggle **Plugins → @zizon/gitfeed-native** off/on. With HMR on, a linked
checkout's changed modules are replaced on the next profile recomposition (any
Plugin Manager change, or an edit to the profile patch), so a rebuilt `lib/`
usually takes effect without a restart; a `dsh web` restart is the fallback.
The Client bundle reloads on a page refresh once the plugin is re-activated.

A `~/.dsh` that is a symlink — the usual iCloud Drive arrangement, where
`~/.dsh` points at `~/Documents/.dsh` — gives the profile two paths: the logical
one the Harness composes (`~/.dsh/profiles/web`) and the physical one on disk.
pnpm writes a `link:` dependency relative to the physical directory; the Plugin
Manager resolves the same recorded value against the logical one. When the
relative hop crosses that symlink, an install can leave
`node_modules/@zizon/gitfeed-native` pointing at `/gitfeed-native`, and the
reader disappears from the sidebar on the next start. Reinstalling is the
repair: remove the bundle and install the checkout again (the Plugins page, or
`plugin_manager` with `remove_bundle` then `install_bundle` at the absolute
path), which recomputes the link against the real directory. A machine that has
never installed it gets this right the first time, which is why the same
breakage does not follow the repository. Check without the UI, from the profile
directory: `node -e "console.log(require.resolve('@zizon/gitfeed-native'))"`
should print the checkout's `lib/index.js`.

The build uses `tsc` for the ESM Host tree and `esbuild` for the Client bundle,
both from `node_modules`. The Client resolves `react` and
`@deepseek-ai/dsh-client-ui-primitives` from the Harness platform module table
(both stay external in the bundle) and writes its own CSS against the
documented `--dsw-*` tokens.

### Quality gates

Four gates cover a change before a commit:

```bash
pnpm build       # tsc Host + esbuild Client into lib/
pnpm typecheck   # the same tsc passes, no output
pnpm test        # builds, then runs every suite under tests/
pnpm lint        # oxlint, including the type-aware rules
```

`tests/` holds the behaviour contract in runnable form (see
[`jobs.md`](jobs.md)), the item-model and `/state`
protocols, the timer-runtime check against a real Harness checkout, and the
architecture ratchet that keeps a second clock out of the Host half. Suites are
plain node scripts driven by `tests/run.mjs`; no test framework is installed.
CI runs the same four gates on every push, on the floor `engines` declares
(Node 24.9, which is what the Harness itself requires) and the latest 24.

Lint reads the single root `tsconfig.json`, so Host and Client files resolve
from one project; `pnpm lint:fix` also applies the formatting rules.

Strings are built with template literals, never `+`: `prefer-template` rejects
concatenation, `no-useless-concat` catches the literal-only case that rule
skips, and `@stylistic/template-curly-spacing` keeps `${…}` tight so the fixer
cannot leave `${  value}` behind. `lint:fix` runs the fixer twice because the
first pass rewrites concatenation and the second formats the interpolation it
produced.

### Code shape

One-shot work — a fetch run, one HTTP request, an import — is a sequence of
named steps. `runFetch` and the plugin's `apply` are the examples: they are the
data flow (`runFetch`: plan → feeds → archive → tally → report; `apply`: root →
limits → service → what it serves → the line that says so), and each step is a
function at module level that takes what it needs and returns what the next step
uses. A step-sized block defined inside another function, or a phase's work
inlined as an anonymous callback, is the shape this avoids: it reads as one knot
and hides the flow. The state a one-shot step accumulates is a named record
(`RunPlan`, `ArchiveState`, `RunTally`), not a spread of `let`s or setter calls.

A long-lived object is still one unit, but it is not one long function: the
state is a record (`ServiceRecord`, `RunnerRecord`, `LiveRecord`,
`TransportRecord`, `ControllerRecord`) and the work is module functions that
take it, so the factory is the thin surface that builds the record and returns
the object. A view is one unit too, and a view that outgrows a screen is split
into child views (`FeedRail` → `FeedRow` / `FolderHead` / `AddFeedForm`,
`GitfeedPage` → `SourcePane` / `PageToolbar`), not into helpers defined inside
the render.

The lint enforces the mechanical half, in `.oxlintrc.json`:

| rule | limit | what it catches |
| --- | --- | --- |
| `max-lines-per-function` | 100 | a function that needs a scroll is two steps |
| `max-statements` | 50 | the same, counted in work |
| `max-depth` | 4 | a block nested deeper is a step asking to be named |
| `max-params` | 6 | more inputs than that is a record the step should take |
| `max-lines` | 600 | a file is a unit, not a shelf |

The span rule is what makes the shape checkable: a factory that keeps forty
helpers in its body measures as one 800-line function, so every long-lived unit
is a record plus module functions — `createGitfeed`, `createJobRunner`,
`createLiveState`, `createTransport`, `createController` all read that way. No
file carries an exemption and no function carries a directive; the rule is the
same everywhere.

The thresholds are a ratchet at the code's current worst, so new debt fails
while existing code needs no rewrite. Every file is now under the 600-line cap;
a file that outgrows it splits along the seams the steps already have.

## Release

Two workflows in `.github/workflows/`. `ci.yml` runs the gates on every push to
`main` and every pull request: `pnpm install --frozen-lockfile`, `pnpm lint`,
`pnpm test`. It publishes nothing.

`release.yml` turns a tag into a release:

1. bump `version` in `package.json` and commit it;
2. `git tag -a v3.4.1 -m 3.4.1 && git push origin v3.4.1`;
3. the workflow checks that the tag names that version, runs the gates, packs
   the tarball (which is also uploaded as a build artifact and attached to a
   GitHub release), and runs `npm publish --access public`.

A manual run with `publish` unticked builds and checks the tarball without
touching the registry.

Authentication is either of two things, and the workflow handles both: it
publishes with `NPM_TOKEN` when that secret exists, and through the package's
trusted publisher when it does not.

**With a token** — a granular access token on npmjs.com with publish rights on
`@zizon/gitfeed-native`, stored as the repository secret `NPM_TOKEN`. Granular rather
than classic, because granular tokens bypass the account's 2FA in CI. This is
the only option for the *first* publish: a trusted publisher is configured on a
package that already exists, so until one version is on the registry there is no
page to set it up on.

**With a trusted publisher** — no secret at all, and the way this repository
now releases. The package's **Settings → Trusted Publisher** on npmjs.com names
GitHub Actions, user `zizon`, repository `gitfeed-native`, and workflow
`release.yml` with **direct publish** allowed (staged-only is the default and
would refuse `npm publish`); there is no `NPM_TOKEN` secret. Without one the
workflow upgrades npm first, because trusted publishing needs 11.5.1 or newer.
To set this up again on another package: publish one version with a token,
configure the publisher, then delete the token.

No registry setting is needed anywhere — installs read the public registry
anonymously, and the lockfile records only integrity hashes
(`lockfileIncludeTarballUrl: false`), so a machine that installs through a
mirror produces the same file CI can verify.

Publishing passes `--provenance`: npm signs a statement that the tarball came
from this workflow run and this commit, and attaches it to the version, where
`npm attest` or the package page can verify it. It needs a public source
repository and the `id-token: write` permission the workflow carries; without
either, drop the flag rather than the release.

Everything else in the release path needs no manual setup: the repository is
public, the package is published through a trusted publisher, and the two things
that must stay private — the data repository and any registry credential — are
not in this tree. `.gitignore` covers the local files that carry them.
