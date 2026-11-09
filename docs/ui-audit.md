# UI audit, 2026-11-09

Review of the reader's client surfaces against the Harness client's own design
rules (`dsh-client-ui-ux`, `web-styling.md`, and the Plugins page as the
full-page reference). Committed as an audit first so the redesign below can be
argued from reasons rather than from the last screenshot.

**Scope and method.** Every file under `src/client/` was read; the stylesheet
was scanned for dead selectors, literal colours, and off-scale radii or type
sizes; every control was checked against the atom it could be using. The
assembled page was **not** inspected at this revision: the review machine has no
browser session for the running Host, so the rendered evidence is limited to
the committed screenshots, the app's own reference implementations, and
fixtures built from the same stylesheet. Findings that need a rendered check
say so.

## Verdict

The visual foundation is in good order: no dead selectors (92 classes, all
referenced), no literal colours except one token-derived `color-mix`, radii and
type sizes drawn from the theme (the pill capsule and the unread dot keep the
shapes the atom set itself uses), and the atoms adopted where they exist —
`Button`, `Pill`, `Input`, `Switch`, `Menu`, `MenuItemButton`, `MenuSurface`,
`Tooltip`, `Toast`. What remains is not dirt in the sheet. It is **page chrome
carried over from an earlier iteration of the plugin**, and **presentation
logic written twice** because the two surfaces that need it were built at
different times.

## Findings

### F1. The two toolbars are not the app's page bar *(high, visual)*

`GitfeedPage` draws a 44px `.gf-toolbar` with a 20px title, the filter pills and
search in the same row, and four actions at `size="sm"` — 28px high, 12px
label — beside a 32px `Input` and 24px `Pill` (`styles.ts:30`, `styles.ts:45`).
The app's full-page reference runs its header actions at 32px with 13px labels
(`PluginManagerPage.module.css:595`), keeps the title on the first line with the
tabs beneath it, and collapses action labels to icon-only under a 372px
container query (`:1796`). The reader has no `@container` at all
(`grep @container src/client/styles.ts` is empty); it wraps the whole toolbar
instead, which makes the bar taller as the pane narrows.

Measured on the assembled page at 1200px (920px bar): the four actions wrapped
to a second row at the left, and that row was 89px tall instead of 44px.

**Landed.** The bar is a container (`container-type: inline-size`). Its actions
are 32px controls with 13px labels, following the reference page; under 1140px
they drop the labels and become 32px icon buttons, the search gives up 70px, and
the bar stays one row — the group also takes `margin-left: auto`, so where it
still wraps (narrow main panels) it sits at the right edge under the status
instead of under the brand. Verified light and dark at 900px (two rows, icons
right-aligned), 1200px (one row, icons) and 1560px (one row, labels).

### F2. Two implementations of one toolbar *(medium, debt)*

`GitfeedRail` renders `.gf-rail-bar` and `.gf-rail-bar2` (`GitfeedRail.tsx:163`,
`:189`) while `GitfeedPage` renders `.gf-toolbar`. Both use `FilterTabs` and
`SearchBox`, and each re-decides padding, gaps, and which controls appear. The
shared components are shared; their arrangement is not. A change to the filter
row has to be made twice and agrees only because nobody has changed one.

Proposal: one arrangement component with a `compact` flag, so the rail is a
variant of the page bar rather than a second one. **Decided against**, after
seeing both: the rail's first bar is a source picker with a refresh button and
an overflow menu and no brand, its second is filters, search and the refresh
age; the page's is brand, filters, search, the git status and four actions.
Sharing one arrangement would make every child conditional. The parts that are
the same (`FilterTabs`, `SearchBox`, `GitStatus`/`RefreshState`, the job words)
already are shared components, which is where the duplication that mattered
was.

### F3. One scheduler, three descriptions *(medium, debt)*

`GitStatus` (`Status.tsx:17`) and the rail's `RailMenu` (`GitfeedRail.tsx:28`,
formatting at `:49`–`:81`) build the same sentences — the fetch cadence, the
next run, the last run, the counts, the sync cadence, the sync verdict — with
separate code, and `RefreshState` (`Status.tsx:70`) builds a third copy for its
tooltip. `status.autoEvery`, `status.nextIn`, `status.lastRefresh`,
`status.fetchLine`, `status.syncFailed` are each interpolated in two places with
different separators.

Proposal: one `jobLines(job, t)` per job returning the parts; both surfaces
render them. Invisible, and the only way the menu and the tooltip cannot drift.

### F4. A hand-rolled icon button beside the atoms *(medium, debt + false doc)*

`Controls.tsx` ships `.gf-iconbtn` — square 28px, 24px compact, its own hover,
focus-visible ring, and disabled opacity (`styles.ts:62`) — while the README's
design-language section says "the page gets the same buttons … the plugin ships
no CSS for those controls" and does not list this control among the ones kept
custom. The atom set has no square icon-only variant, so keeping it is right;
the claim is what is wrong, and the stylesheet now owns a control the rest of
the GUI styles for itself.

Proposal: keep the control, list it under "Kept custom, deliberately" with the
reason, and stop claiming zero CSS for shared controls.

### F5. Action explanations are native `title` *(landed with F1)*

Pull and Sync carried `title` (behind count, dirty state); Fetch carried none in
any state, including disabled, and Prefs carried none. The app pairs header
actions with `Tooltip` (`PluginManagerPage.tsx:1689`), and the plugin already
owned a `Tooltip`-wrapped icon button (`Controls.tsx:35`). All four actions are
`Tooltip` + `aria-label` now, and the label says the state: `Sync ·
uncommitted`, `Pull · 2 behind`. The tooltip is portalled, so it clears the
page's own `overflow: hidden`; verified in both themes.

### F6. Loading is a sentence where the rule asks for a skeleton *(low, visual)*

The list's first load renders `EmptyState` with `status.loading` as its hint
(`ItemList.tsx:548`). The app's rule is that lists use skeletons and only
page-level loads centre a spinner. A skeleton of three row shapes would also
remove the jump when the first page lands.

### F7. The empty state's glyph and type are local *(low, judgement)*

`.gf-placeholder-title` is 16px/500 and the glyph 28px (`styles.ts:391`), with
the plugin's own RSS mark as artwork on the error and empty-article panes. The
atoms ship no empty-state component, so this is not a rule break; it is worth
deciding once whether the reader's empty panes should look like the app's
(this is the surface most likely to read as "another product" on first use).

### F8. Rows swallow the names of the actions inside them *(low, accessibility)*

`ItemList.tsx:405` and `FeedRail.tsx:127`/`:143` render rows as
`div role="button"` with `aria-current` for the open item, and `tabIndex={-1}`
because the reader is walked with `j`/`k`. The app uses `role="button"` divs in
nine places, so the pattern is a choice, not a violation — but a `role=button`
with real buttons inside it is not: the row's accessible name becomes the
concatenation of its children. On the assembled page the feed rows read as
`Hacker News 4 Move to folder: Hacker News Mark source read: Hacker News
Unsubscribe: Hacker News`, and the item rows read as their title, feed, time and
digest, with the star's label mixed in.

Proposal: the row becomes a plain container; the name is its own button and the
actions are siblings. That is the app's own list-row shape, and it changes what
a screen reader announces, so it is its own commit.

**Landed for the rail.** Feed rows, folder headers, `All items` and `Add feed`
are containers whose name is a button of their own, with the row's actions as
siblings. The live tree now reads `button "V2EX"`, `button "Move to folder:
V2EX"`, `button "Mark source read: V2EX"`, `button "Unsubscribe: V2EX"` instead
of one row named after all four. Still open: the item row's star sits inside the
row's button, so the same shape lands there when that row's title line is
re-laid-out.

### F9. Two toast hosts for one banner *(low, inspected, kept)*

`GitfeedPage` and `GitfeedRail` each render `<Toasts>`, so with the page and the
rail both open the state change mounts two banners. The primitive places itself
`position: fixed` at the frame's centre, so they overlap exactly and share one
`toast.at`; the reader sees one. The app's rule is that a transient banner is
owned by a host that outlives its panel — here either surface outlives the
other, and closing the last one ends the banner with the reader's undo, which is
the one case the rule exists to prevent. Moving the host to `shell.overlay`
would give one owner and is the app's own pattern, but it buys nothing visible
for a new registration and a second subscriber to the same state. Kept.

## Retired this round

- **Filling the git action that applies** (`3.9.4`): git state is already in the
  status line, and the page's purpose is reading; one filled button among four
  peers reads as a different kind of control.
- **The up-right arrow for Sync** (`3.9.4`): it is the app's open-in-app mark,
  and the article pane uses it for *Open original* on the same page.

## Plan

1. **The audit**, and the README correction F4 needs. *(landed)*
2. **Logic** — F3, the one step whose result can be checked without the
   rendered page: the words it builds are compared against the parent commit's
   expressions for the same scheduler fixtures, and must be identical.
   *(landed: `jobWords()`; identical on seven fixtures)*
3. **Chrome** — F1 and F5. *(landed: 32px actions, labels that collapse to
   tooltips, one row from 900px up; F2 decided against)*
4. **States** — F6, then F7 against a rendered check. *(F6 landed: the list's
   first paint is a skeleton at the row height)*
5. **Accessibility** — F8, if the reader is to be operated by anything but
   `j`/`k`; it changes what a screen reader announces, so it is its own commit.

F1, F6 and F7 need the assembled page in front of me; the rest do not.
