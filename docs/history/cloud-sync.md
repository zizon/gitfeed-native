# Cloud sync: removed in 3.0.0, and how to bring it back

Until 2.10.0 this package shipped a GitHub Actions path: `gitfeed ci` wrote
`.gitfeed/gitfeed.mjs` (a stand-alone bundle of the CLI) and
`.github/workflows/fetch.yml` into the data repository, and a cron schedule ran
the fetcher there, committing `data/` back with the repository's own
`GITHUB_TOKEN`.

It is gone in 3.0.0. Fetching now happens only in the Host process — the job
runner described in [jobs.md](../jobs.md) — and the data repository holds nothing
but data.

This note records why, with the evidence, and what to do if GitHub's scheduler
starts working again.

## Why it was removed

The job was armed correctly and never ran. Observed on 2026-11-08, on
`zizon/gitfeed` (private, created that morning):

| check | result |
| --- | --- |
| `.github/workflows/fetch.yml` present on `main`, `state: active` | yes |
| `on:` has both `schedule` and `workflow_dispatch` | yes |
| `event=schedule` runs since the workflow first existed (~10 h, two cron expressions) | **0** |
| manual `gh workflow run fetch` | success in 44 s; committed and pushed `feed: 2026-11-08T13:44Z` |
| a `*/5` probe workflow in the same private repo, 18 min | **0** |
| a `*/5` probe in a brand-new **public** repo on the same account, 18 min | **0** |
| `renovatebot/renovate`, `cli/cli`, `home-assistant/core` in the same minutes | schedule runs at 13:46Z, 13:42Z, 13:06Z |

So the scheduler was alive globally, the workflow was valid, the token and the
permissions were fine — and nothing was dispatched to this account. No
`event=schedule` run ever appeared for either repository.

That is not a configuration mistake, and it is not the well-known
"private repo on a free plan cannot run scheduled workflows" story either: the
public probe stayed silent too. It is a platform-side dispatch problem, which
matches what GitHub's community has been reporting for the same window:

- [community#211723](https://github.com/orgs/community/discussions/211723)
  (2026-10-31) — "Two-hour scheduled workflow creates events only every 3–9
  hours"
- [community#211816](https://github.com/orgs/community/discussions/211816)
  (2026-11-01) — "Active scheduled workflow creates no schedule runs"
- [community#211839](https://github.com/orgs/community/discussions/211839)
  (2026-11-02) — "Scheduled Actions events missing after 02:10 UTC"
- [community#211937](https://github.com/orgs/community/discussions/211937)
  (2026-11-03) — "Scheduled workflows never trigger, but workflow_dispatch
  works"
- [community#212101](https://github.com/orgs/community/discussions/212101)
  (2026-11-05) — hourly cron producing runs 4–8 hours apart
- [community#212128](https://github.com/orgs/community/discussions/212128)
  (2026-11-05) — 5–15 minute crons firing every 4–6 hours
- [community#212160](https://github.com/orgs/community/discussions/212160)
  (2026-11-05) — **"Scheduled GitHub Actions workflows never trigger in private
  repository"**, the closest match: two workflows, manual dispatch succeeds,
  `event=schedule` returns `total_count: 0` over a full day; a reporter's
  schedules had worked until 2026-11-05 and then stopped with no config change

GitHub Status shows the neighbouring incidents, all marked resolved while
scheduled dispatch stayed sparse:
[2026-11-04 16:05Z](https://stspg.io/pjgptg3cfc6n),
[2026-11-04 17:40Z](https://stspg.io/7pwv28hvkmz8),
[2026-11-05 16:50Z](https://stspg.io/lv4q3xm9r0rk),
[2026-11-05 23:36Z](https://stspg.io/s5bs6jn41fwh).

GitHub's own documentation is explicit that this trigger is best-effort: "The
`schedule` event can be delayed during periods of high loads of GitHub Actions
workflow runs. […] If the load is sufficiently high enough, some queued jobs may
be dropped." ([Events that trigger
workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)).
Nothing in a workflow file changes that.

A job that looks armed and never runs is worse than no job: the repository
appears to be refreshed by CI, is silently stale instead, and the generated
bundle has to be kept in sync with the plugin for nothing. Hence the removal.

## What was removed

- the `gitfeed ci` command and its scaffolding (`installCi`, `ciFiles`, the
  embedded workflow text, the bundle copy written by `gitfeed init`);
- the `lib/gitfeed.mjs` stand-alone build (`src/cli-entry.ts` and its esbuild
  step);
- the data repository's `.gitfeed/gitfeed.mjs` and
  `.github/workflows/fetch.yml`;
- the README sections that described them.

Plugin commit `3d9fd20`, version 3.0.0. `git show 3d9fd20` is the full diff.

## If the limitation is gone

Confirm it first — a `schedule` run appearing is the only proof that matters:

```bash
cat > .github/workflows/cron-probe.yml <<'YAML'
name: cron-probe
on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: echo "fired at $(date -u +%Y-%m-%dT%H:%MZ)"
YAML
git add .github && git commit -m "ci: cron probe" && git push

# expect a run within ~15 minutes; a day of silence means "still broken"
gh api "repos/<owner>/<repo>/actions/runs?event=schedule&per_page=5" --jq .total_count
```

Delete the probe afterwards. Then restore the feature by reverting the removal:

```bash
cd ~/gitfeed-native
git revert --no-edit 3d9fd20        # brings back `gitfeed ci` and the bundle build
pnpm build
node bin/gitfeed.mjs ci ~/gitfeed   # writes .gitfeed/gitfeed.mjs + the workflow
cd ~/gitfeed && git add .gitfeed .github && git commit -m "ci: restore the fetch job"
```

Keep the two generated files committed together, and re-run `gitfeed ci` after
every plugin upgrade so the committed bundle matches the installed one.

If the revert is not wanted, the workflow it generates is short enough to keep
by hand — the bundle is the only piece that needs the plugin:

```yaml
name: fetch
on:
  schedule:
    - cron: "1,31 * * * *"
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
        with:
          node-version: 22
      - name: Fetch feeds
        run: node .gitfeed/gitfeed.mjs fetch
      - name: Commit new items
        run: |
          git config user.name "gitfeed"
          git config user.email "gitfeed@users.noreply.github.com"
          git add data
          if git diff --staged --quiet; then
            echo "no new items"
            exit 0
          fi
          git commit -m "feed: $(date -u +%Y-%m-%dT%H:%MZ)"
          git pull --rebase --autostash
          git push
```

Do not restore it for the schedule alone: `schedule` is best-effort even when it
works, so anything that must happen on time still needs a trigger outside GitHub
(a cron entry on an always-on machine, as the README's "Cron" section shows, or
an external caller hitting the `workflow_dispatch` API with a token scoped to
that one repository).
