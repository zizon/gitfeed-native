# The item list's visible-window state machine

Review of 2026-11-13, written after three symptoms in the Sidebar: a refresh
flashing the list, a refresh moving the position the reader was on, and rows
already read showing up in front of the reader again. The list's rules were
spread over a component full of effects, a transport that held rows it did not
list, and a pure viewport module; nothing said which row is in which state or
which transitions are allowed. This is that model, the defects it found, and
the rules the list now follows.

## The state a row is in

A row's state is not one value. It is a small product of independent facts, and
almost every bug in this area came from two of them disagreeing for one frame.

| fact | values | decided by |
| --- | --- | --- |
| **model** | present / removed | the Host's item model |
| **scope** | in / out | filter, search answer, selected source |
| **listed** | listed / held | `listOf()`: scope, retained rows, held arrivals |
| **mounted** | in band / outside band | `windowOf()`: `[start, end)` |
| **window** | under the viewport / outside | `windowOf()`: `[top, top + height)` |
| **mark** | unread / read / read-retained | `read`, `stickyRead` |
| **arrival** | fresh / settled | `fresh` (fades in on first paint) |
| **departure** | gone / leaving | `exhaustedGroups()` fade, or none |
| **selection** | open / closed | `current` |

Which of the reader's numbered states these make:

1. **read, invisible** — present, in scope, unread filter, `reader.has(id)`,
   not retained. Not listed at all.
2. **unread, out of the window** — listed (or held), mounted only if the
   overscan reaches it, outside `[top, top + height)`.
3. **unread, in the window** — the row the rules exist to protect.
4. **reading, the list behind the article** — selected, and in the Sidebar the
   article is drawn over the list rather than instead of it: the row stays
   mounted, the scroll position holds, and closing the article returns to it.
5. **new, not yet added** — `fresh` and *held*: counted by the header, not
   listed, so it cannot move anything.
6. **new, landing** — released: listed, `fresh`, fading in (`gf-row-in`).
7. **read-retained** — read while under the pointer, still listed so the list
   does not move; it leaves by one of the three exits below.

## Events

| event | what has to happen before the next paint |
| --- | --- |
| scroll | new band; rows scrolled past are read; retained rows above the band may be released |
| arrival (new id) | hold it while a surface shows a list; a first frame is a baseline |
| update (same id, repaired body) | no band change; the row keeps its place |
| removal (retention) | rebuild; the edge keeps its entry, or the nearest survivor takes its place |
| implicit mark (open, scroll) | the row stays listed (retained); nothing moves |
| explicit mark / undo / mark read elsewhere | rebuild with the edge held |
| section exhausted | the section fades where it stands, then leaves |
| scope change (filter, search, source) | new list at its own top; held rows released |
| selection (keyboard, Next) | reveal the row if the band does not cover it |
| release (the "N new" control, back to the top, refresh) | held rows land, fading in |
| resize | new band at the browser's clamped offset |
| article open / close | selection moves, or clears; the list is untouched |

## Invariants

The list now follows these; each one is a rule that a future change has to
argue with, not an implementation detail.

1. **The band is derived, never stored.** A render draws the band of the
   entries and the scroll offset it was handed. A stored band can describe the
   list that was just replaced, and for one painted frame it did.
2. **A rebuild keeps the edge.** When the entries change under a live viewport,
   the entry under the edge and the offset into it are preserved before paint.
   If that entry is gone, the nearest surviving entry keeps the place the edge
   had. At the top the answer is simply the top.
3. **A refresh never inserts rows under the reader.** While a surface shows a
   list, arrivals are held and counted, not listed — at the top as much as in
   the middle. They land when the reader asks for them, leaves the top and
   comes back, changes the scope, or runs a refresh/pull/sync.
4. **A row leaves the list once, and only when it is out of the way.** Read
   rows are retained while they are under the pointer; they go when their
   section fades, when the band leaves them behind in a batch, or when the
   scope changes. A refresh does not re-add them and a jump does not reveal
   them again.
5. **A list with no rows protects nothing.** The held set is only for a list
   with content on screen; an empty view (or a surface that has not painted
   yet) takes arrivals as they come.
6. **The count is the archive's.** It counts what the view has to read, not the
   rows the list happens to hold, so held arrivals still show up in it.

## The three symptoms, and what caused them

**The flash.** The mounted band lived in component state, written by a passive
effect after paint. A commit that changed the entries therefore painted once
with the *old* index range before correcting itself. When the released rows
above the band exceeded the overscan — a batch trim does exactly that, at
`TRIM_AT = 24` rows — the stale band did not even cover the viewport, so that
frame was empty where the rows should be. Now the band is derived during the
render and the rebuild is resolved in a layout effect, so the frame that
reaches the screen is already consistent.

**The offset.** The anchor used for the rebuild was captured by the last
scroll pass — the `requestAnimationFrame` callback — rather than at the moment
of the scroll. A delta that landed between a scroll and its rAF re-applied an
older offset, which is a jump backwards into rows already read; in the other
direction the new rows could be left above the edge. The anchor is now taken
from the entries the previous paint drew and from the scroll offset recorded
synchronously by the scroll handler, and applied before paint. Separately, the
top had no anchor at all by design, so arrivals there pushed the newest row
down by exactly their height; that is invariant 3.

**Read rows in front of the reader again.** They were never re-added. The
viewport moved (symptom 2), and rows above it — read and retained because the
reader had just read them — came into view. Fixing what moves the viewport
without the reader's act fixes this symptom too.

## What the model does *not* do

- **No animation on the anchor correction.** A smooth scroll to where the
  reader already was is motion they did not ask for. The correction is applied
  before paint, so it is invisible.
- **No per-row exit animation above the band.** By construction those rows are
  out of the viewport when released; the grouped case fades its section instead,
  which the reader can see.
- **No timer that releases held rows.** A timer is an update the reader did not
  ask for, which is the whole thing the model exists to prevent. The bar states
  the count and offers the control; the reader decides.

## Checks

- `tests/window.test.mjs` — `scrollAfterRebuild`: unchanged rebuild, top, rows
  inserted above, rows removed above, the anchored row removed, everything up
  to the edge removed, an empty list, a row height change, and the band drawn
  after each rebuild covering the viewport it was put back on.
- `tests/controller.test.mjs` — an arrival on a list at its top is held and
  counted, asking lands it and it fades in, an explicit action lands it too, the
  first frame of a reconnected stream is a baseline, an empty list holds
  nothing.
- `tests/list-dom.test.mjs` — the component against a stand-in controller in
  jsdom: an arrival at the top is not inserted and the bar offers it, asking
  lands it with the fade, a rebuild with three rows inserted above pays for
  them in scroll offset, a batch of 27 retained rows released above the edge
  gives back exactly its height and leaves the row under the edge in place, and
  a view that empties stops holding.
- `tests/window.test.mjs` — the older rules (band, anchor, sticky header,
  read-on-scroll dwell, settled rows) still pass unchanged.
