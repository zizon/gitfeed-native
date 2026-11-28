# Reading

What the page does, how the list stays still while it is being read, the order
the sources are drawn in, and the design language the page is built from. The
model behind the list's behaviour is [`list-state.md`](list-state.md); the wire
behind its updates is [`state-stream.md`](state-stream.md).

## The page

The native page follows the Harness theme, including light/dark/auto. It does
not carry its own theme setting.

- **Filters**: Unread / All / Starred.
- **Search** over title, summary, and feed title, answered by the Host.
- **Feeds**: folders from the OPML import, collapsible; unread counts; error
  marks; one "Add feed" row that opens the form. Every feed row carries its
  actions in view — move it to another folder, mark the source read, and
  unsubscribe (colored destructive on hover, confirmed on click), which removes
  the subscription. An unsubscribe is a statement about future updates: the
  articles the source already delivered stay in both stores, and because the
  digest draws only the sources that are followed, the section leaves the list
  while its rows stay on disk. Subscribing again brings them back with their read
  marks. That row is the only unsubscribe entry.
- **Importing and exporting**: below **Add feed**, **Import / export…** opens the
  app's own dialog. It asks in order — a numbered **Choose an OPML file** step with
  a drop target and a browse button, then **What should it do?** as two described
  cards, **Merge** (recommended) and **Replace** — and the primary action is
  disabled with the words **Choose a file first** until there is one, rather than
  a grey button with no reason. **Merge** adds what is new and takes the folders
  the file carries, keeping the subscriptions it does not mention; **Replace**
  makes the file the whole list, and the sources it does not mention stop being
  followed — their articles stay in the archive, out of the list. The toast
  reports what changed, and a document with no feed outlines is
  refused rather than applied, so a wrong file cannot empty the list. The
  sources that are new are fetched in the background, so their first items
  arrive without a **Refresh**. The same dialog's **Export** row downloads the
  list as `gitfeed-subscriptions.opml` — a copy, not a backup: a custom feed
  travels as its URL, so the script behind it stays in the data repository.
- **Moving a feed**: the folder control on a feed row opens a picker of the
  folders already in use — the current one is marked and cannot be picked
  again — so a move is one click and lands in a folder that exists.
  `New folder…` is its own row and swaps the feed's row for a field to name one.
  Nothing is re-fetched: the entry keeps its id, URL, title, and custom-feed
  declaration, so only the tree above it changes. The picker opens from three
  controls, one per place a source is in front of you: the feed row, the source
  section header next to `Unsubscribe` (the same grammar its other source
  actions use), and the article's action row — which is the only one reachable
  while reading in the Sidebar, where the list and its header sit behind the
  article.
- **List**: one line per item, grouped by folder or source on request. A
  section header sticks to the top while its section is in view and carries
  that section's actions — `Mark {n} read`, plus `Move` and `Unsubscribe` when
  the section is a source. Rows are virtualized at fixed heights.
  A row that is marked read stays in the Unread list while it is still under
  the pointer, so nothing shifts under it while reading; then it goes without
  the list moving: a grouped section fades where it stands and leaves once
  nothing in it is unread — except the section the open article is in, which
  keeps its rows until the reader closes it or opens another — and a flat list
  lets rows go in one batch as they scroll out of the mounted band. A feed or
  folder that was on screen stays in the Feeds list for the same reason.
- **Read on scroll**: a row counts as read once it has been on screen for a
  moment and the viewport has moved off it, so a fling or a scrollbar drag
  leaves everything it skipped unread. The list scrolls one screen past its
  last row — an end screen that says so — so the rows it closes with leave the
  viewport and are read like the rest.
- **Starring**: the star sits on the row itself, so an item can be kept without
  opening it; it holds its space and appears on the row the pointer or the
  keyboard is on, and a starred row shows it outright. Under the Starred filter
  the star *is* membership, so unstarring there drops the row at once.
- **Article**: sanitized feed HTML (element allowlist, `href`/`src`/`alt`/
  `title` only, http(s)/mailto URLs only), move its source to a folder, star,
  mark unread, open original.
  Past the opening of a piece a **Next →** control appears at the bottom of the
  pane, so moving on does not mean scrolling back up.
- **Two groups in the top bar**, separated where the object changes.
  **Refresh** reads the feeds — it fetches every subscription now, and the
  refresh age beside the branch is how stale that is. **Pull** and **Sync
  reads** move the git-backed archive: Pull takes the data root's commits from
  its remote (items another machine fetched and marks it made), Sync reads
  commits this machine's marks and pushes them. Their tooltips say the object
  in words: `Fetch every feed now`, `Download items and read state from the
  remote`, `Commit and push your read state`. Pull and Sync reads are disabled
  when the plugin `allowGit` switch is false, or when the data root is a local
  copy with no git repository; the rail menu then shows why. The rail has no
  room for a labelled bar, so its refresh button and its ⋯ menu carry the same
  split: Refresh first, and Pull/Sync reads under **Read state**.
- **Display preferences**: hide feeds with nothing unread, mark read on scroll,
  group by none/folder/source, order the rail and grouped list by what the
  reader reads (see below) or by name, and collapse the source list with the
  panel toggle in its header (folded, the toggle waits on the 32px spine). The
  toggle is the page's, not the app's, but it speaks the app's language: the
  same panel glyph as the sidebar's own, and its label says which way it goes.
  The fold's easing comes from the theme's own motion tokens; dragging the
  divider is never eased, and `prefers-reduced-motion` turns the animation off.
  Per-browser, in one `localStorage` snapshot (`gitfeed.prefs`) held by the
  shared store engine; the values in `config.json` are the defaults.
- **Keyboard**: `j`/`k` move, `m` toggle read, `s` star, `o` open original,
  `/` search, `u` unread, `a` all, `Esc` close article then clear search/feed.
  Bulk marking is deliberately not on a key.

Pane widths, the collapsed source list, and open folders are remembered per
browser.

## A list that does not move

A refresh lands while someone is reading, so the list is built to absorb one.
The Sidebar has one pane, so an open article is drawn over the list rather than
in place of it: the list stays mounted and closing an article returns to the
same rows at the same scroll position.

Three things follow from "nothing moves under the pointer". A row that has been
read stays listed until something else rebuilds the list, so the header counts
what the view **has** rather than what the list happens to hold: it is counted
from the archive, which is why it falls as the reading does instead of in jumps
when a rebuild finally releases those rows. A mark burst does not reload the
state behind it — the reader already holds the change it sent, and refetching
rebuilt the rows, the count, and the digest text under the pointer several
times a second while scrolling. And a refresh holds its new rows back while a
surface shows a list: the count says they are there, and the bar offers them.
An empty list has no spot to protect, so its arrivals land at once.

- **Sections hold one order.** Grouped sections follow the rail's order over
  sources (below) instead of being re-ranked by item count. Ranking by size
  meant that every fetch, and every read mark under the Unread filter, could
  move the section being read somewhere else; the order now changes only when
  the surface loads, so a section that grows or shrinks stays where it is.
- **The viewport is anchored to a row.** When the list is rebuilt under a live
  viewport, the list is put back on the entry that was under its top edge —
  from the entries the last paint drew and the scroll offset the scroll handler
  recorded, before paint — so the text being read does not slide down the
  screen. If that entry is gone, the nearest entry that survived keeps the
  place the edge had.
- **Arrivals wait for the reader.** A fetch brings rows older than the newest
  ones on screen — feeds that were quiet for an hour deliver an hour's worth —
  so a new row lands *inside* the band being read, not only at its top, and
  inserting it pushes every row below it down. The fade meant to soften that
  read as the page blinking. Held rows are counted but not listed, at the top
  as much as in the middle; the bar says how many there are and offers them as
  `N new`. They also land when the reader leaves the top and comes back,
  changes the scope, or asks for a refresh/pull/sync. A released row fades in
  where it belongs (`gf-row-in`), and a quiet poll changes nothing. The first
  frame a surface receives — a page load, a reconnect — is a baseline, not a
  change to hold back.
- **The band is derived, never stored.** A painted frame draws the entries it
  was handed at the scroll offset it was handed, and a rebuild is applied
  before paint, so the list never shows one frame of the list it replaced. The
  browser's own scroll anchoring is off for the list, so there is exactly one
  owner of the scroll position. See [list-state.md](list-state.md).
- **Ties are broken by id**, on the Host (`compareItems`), so two items that
  share a timestamp cannot swap places between reloads.

## The order of the sources

The rail and a grouped list draw one order: the sources the reader actually
reads first, then everything else by name. Alphabetical order costs time on
every visit — the top of a 377-subscription rail is whichever names sort first,
punctuation and digits before A, not the sources the reader opens — and the
reader's own acts are the only honest evidence of which is which.

Two acts count. **Opening a row** (clicking it, or moving to it with `j`/`k`) is
the reader reading that article; **starring one** is the reader saying so on
purpose, and weighs as three opens. The read mark deliberately does not count:
scrolling past the band and bulk marking saturate it, so every source ends up
equally read and the marks that were a choice cannot be told apart from traffic.

An act weighs half as much a month later, and a source needs half an open to keep
a place in the ranked part — about one article opened in the last month. Under
that bar it is not ranked at all: it returns to the name order, among the sources
the reader has never opened, rather than sinking below them. An untried source is
never buried; it is simply not preferred. A folder takes the place of its best
source, so the top of the rail is where the reading is.

The order is settled when the surface loads (a page load, a reconnect). Reading a
source does not re-rank the rail under the pointer, for the same reason a fetch
does not re-rank the sections: a list must not move while it is being used. What
the reader reads now is what the next load draws. The Display preferences carry
the switch — **Order sources by what you read**, on by default; it re-applies the
order of the current load rather than re-learning it, and with no acts logged it
draws exactly the alphabetical list it always did.

The acts live in `data/interest.ndjson`: append-only, committed with the read
state, pulled with it, so another machine draws the same order. The first read of
a root from before the log seeds it from the stars the archive already holds —
the one explicit interest that was recorded before there was anywhere to record
it. Nothing else is inferred: an act is a row that was opened or starred, never
a guess about why the reader did not open it.

## Design language

The reader is built from the Harness client's own components, not a private
copy of them: the Client bundle requires
`@deepseek-ai/dsh-client-ui-primitives` from the shared module table and marks
it external, so the page gets the same buttons, inputs, menus, switches,
toasts, and icons the rest of the GUI renders, plus any theme change that
reaches them. Its own sheet covers only the surfaces kept custom below.

- **Adopted**: `Button` for the toolbar and inline actions, `Pill` for the
  filter and group-by chips, `Input` for search and the add-feed form,
  `Menu` for the marking scope, `MenuSurface` for the preferences popover and
  the rail menu, `Switch` for the display prefs, `Tooltip` for the actions
  whose labels the page bar drops when it is narrow, `Toast` for transient
  banners with an inline **Undo**, and the product `Icon*` set for the
  chevrons, checks, close, refresh, plus, ellipsis, and open-original glyphs.
- **Kept custom, deliberately**: feed and item rows, the section header (sticky
  in flow, re-rendered as a pinned bar when its own row is above the mounted
  band), the float that follows the list's scroll edge, the icon button (the
  atom set has no square icon-only control), and the article's `Next →`
  capsule — the atom set has no list-row, group-header, floating-bar, or
  icon-only primitive, so these are a small token-styled sheet rather than
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

Where the reader's chrome still departs from the app's current page bar — its
action sizes, label collapse, and tooltips — is recorded with the reasons in
[the UI audit](ui-audit.md).
