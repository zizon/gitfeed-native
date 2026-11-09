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

Consequence: three control heights in one row, and a bar that changes shape
where the reference keeps one line.

Proposal: 32px/13px actions and 8px gaps; container query that drops the
labels; the tab row stays under the title only if it still holds at 320px.
Needs the rendered check — this is the finding most likely to be wrong on a
screenshot.

### F2. Two implementations of one toolbar *(medium, debt)*

`GitfeedRail` renders `.gf-rail-bar` and `.gf-rail-bar2` (`GitfeedRail.tsx:163`,
`:189`) while `GitfeedPage` renders `.gf-toolbar`. Both use `FilterTabs` and
`SearchBox`, and each re-decides padding, gaps, and which controls appear. The
shared components are shared; their arrangement is not. A change to the filter
row has to be made twice and agrees only because nobody has changed one.

Proposal: one arrangement component with a `compact` flag, so the rail is a
variant of the page bar rather than a second one.

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

### F5. Action explanations are native `title` *(low, debt)*

Pull and Sync carry `title` (behind count, dirty state); Fetch carries none in
any state, including disabled, and Prefs carries none (`GitfeedPage.tsx:112`).
The app pairs header actions with `Tooltip` (`PluginManagerPage.tsx:1689`), and
the plugin already owns a `Tooltip`-wrapped icon button (`Controls.tsx:35`), so
the page bar is the odd surface. Tooltips only pay for themselves once the
labels can collapse (F1); they belong in that change, not before it.

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

### F8. Selectable rows are `role="button"` with `aria-current` *(low, accessibility)*

`ItemList.tsx:405` and `FeedRail.tsx:127`/`:143` render rows as
`div role="button"` with `aria-current` for the open item, and `tabIndex={-1}`
because the reader is walked with `j`/`k`. The app uses `role="button"` divs in
nine places, so this is a choice, not a violation; a virtualized selectable list
is the case where `listbox`/`option` with `aria-selected` would describe what
the pointer and the keyboard actually do.

## Retired this round

- **Filling the git action that applies** (`3.9.4`): git state is already in the
  status line, and the page's purpose is reading; one filled button among four
  peers reads as a different kind of control.
- **The up-right arrow for Sync** (`3.9.4`): it is the app's open-in-app mark,
  and the article pane uses it for *Open original* on the same page.

## Plan

1. **The audit**, and the README correction F4 needs.
2. **Logic** — F3 alone, because it must stay invisible, and because it is the
   one step whose result can be checked without the rendered page: the words
   it builds are compared against the parent commit's expressions for the same
   scheduler fixtures, and must be identical.
3. **Chrome** — F1, F2, F5 in one change: one arrangement, the page bar's
   measures, labels that collapse with tooltips to carry them.
4. **States** — F6, then F7 against a rendered check.
5. **Accessibility** — F8, if the reader is to be operated by anything but
   `j`/`k`; it changes what a screen reader announces, so it is its own commit.

F1, F6 and F7 need the assembled page in front of me; the rest do not.
