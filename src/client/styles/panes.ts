/** The panes: source rail, list frame, subscription dialog. */

export const PANES = `
.gf-body { flex: 1 1 auto; display: flex; min-width: 0; min-height: 0; }
/* The source list and its divider are one pane, so folding eases a single
   track — the app's own sidebar does this with the frame's grid track and its
   slow/ease-in-out pair. The content inside is laid out at its expanded width
   and clipped, so the edge moves and nothing reflows behind it. */
.gf-sourcepane {
  position: relative;
  flex: 0 0 calc(var(--gf-rail, 220px) + 5px);
  display: flex;
  min-width: 0;
  overflow: hidden;
  background: var(--dsw-specific-sidebar-fill);
  transition: flex-basis var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}
.gf-sourcepane.folded { flex: 0 0 32px; }
/* Dragging the divider writes the width at pointer cadence; easing it would
   detach the edge from the pointer (the app's own frames drop easing while a
   column is dragged). */
.gf-page[data-dragging] .gf-sourcepane { transition: none; }
.gf-sourceclip {
  flex: none;
  display: flex;
  width: var(--gf-rail, 220px);
  height: 100%;
  min-width: 0;
  /* Backwards fill only: a finished entrance must not keep asserting its final
     opacity, or the fold's fade-out would be overridden by it. */
  animation: gf-source-in 200ms var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)) backwards;
}
@keyframes gf-source-in {
  from { opacity: 0; }
}
/* The first half of the fold: the content fades where it stands. When the fade
   is done it leaves the DOM and the spine arrives. */
.gf-sourcepane.fading .gf-sourceclip,
.gf-sourcepane.fading .gf-splitter {
  opacity: 0;
  transition: opacity 150ms var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1));
}
/* The divider's handle rides the pane's edge, so it stays on the border while
   the pane moves. */
.gf-sourcepane .gf-splitter {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 5px;
}
.gf-sourcepane.folded .gf-splitter { pointer-events: none; }
.gf-feedrail {
  flex: 0 0 var(--gf-rail, 220px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-sidebar-fill);
}
.gf-splitter { flex: 0 0 5px; cursor: col-resize; position: relative; background: transparent; }
.gf-splitter::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 1px;
  background: var(--dsw-alias-border-l1);
}
@media (hover: hover) {
  .gf-splitter:hover::after {
    left: 1.5px;
    width: 2px;
    background: var(--dsw-alias-state-business-primary);
  }
}
.gf-listpane {
  position: relative;
  flex: 0 0 var(--gf-list, 430px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 0.5px solid var(--dsw-alias-border-l1);
}
.gf-listpane.wide { flex: 1 1 auto; border-right: 0; }
.gf-articlepane {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  min-width: 300px;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
}

.gf-rail-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  /* One band with the list's own bar beside it: 6 + 20 + 6. */
  padding: 6px 8px 6px 12px;
}
/* The fold control in that band, sized to it rather than to the 24px the rail's
   rows use for their own actions. */
.gf-rail-head .gf-iconbtn,
.gf-spine .gf-iconbtn { width: 20px; height: 20px; }
/* The folded source list: a spine where its header was, carrying the panel
   toggle that reopens it at that header's corner. It arrives at the fold's
   settle, from the edge the content was clipped at — the second half of the
   animation, as the pane finishes closing. */
.gf-spine {
  position: absolute;
  inset: 0 auto 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 32px;
  padding: 6px 0;
  border-right: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-sidebar-fill);
  animation: gf-spine-in 150ms var(--ds-ease-in-out, cubic-bezier(0.4, 0, 0.2, 1)) both;
}
@keyframes gf-spine-in {
  from { opacity: 0; transform: translateX(-6px); }
}
.gf-rail-title {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
}
.gf-feedlist { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 6px 14px; }
.gf-feedrail.compact .gf-feedlist { padding: 2px 4px 10px; }
.gf-feed {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 4px 0 8px;
  border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  user-select: none;
}
.gf-feedrail.compact .gf-feed { height: 26px; border-radius: var(--dsw-radius-sm); }
.gf-feed.on {
  background: var(--dsw-specific-sidebar-nav-item-active);
  color: var(--dsw-alias-label-primary);
}
.gf-feed.error .name { color: var(--dsw-alias-state-error-primary); }
@media (hover: hover) {
  .gf-feed:hover:not(.on) { background: var(--dsw-alias-interactive-bg-hover); }
}
.gf-feed .name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 20px;
}
.gf-feed .count {
  flex: none;
  font-size: 11px;
  line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
/* Row actions sit on the row the way "mark this source read" does: always
   there, tertiary until the pointer is on it, destructive color only on hover —
   the click still asks before anything is removed. */
.gf-rail-check, .gf-rail-x { color: var(--dsw-alias-label-tertiary); }
/* The folder picker's anchor: one control in a row that is mostly text. */
.gf-foldermenu { flex: none; display: inline-flex; }
.gf-foldermenu .gf-iconbtn { color: var(--dsw-alias-label-tertiary); }
@media (hover: hover) {
  .gf-feed:hover .gf-rail-x, .gf-folder-head:hover .gf-rail-x { color: var(--dsw-alias-state-error-primary); }
}
.gf-folder { margin-top: 2px; }
/* A row is a container: its name is a button of its own and the row's actions
   are siblings, so a row never announces its buttons' labels as its name. */
.gf-feed-main, .gf-folder-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.gf-folder-main { gap: 4px; }
.gf-folder-head {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 4px 0 8px;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  user-select: none;
}
@media (hover: hover) {
  .gf-folder-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.gf-folder-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}
.gf-folder-head .count { font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums; }
.gf-chevron { display: inline-flex; color: inherit; transition: transform .12s ease; }
.gf-chevron.open { transform: rotate(90deg); }
.gf-addform { display: grid; gap: 6px; padding: 6px 4px 8px; }
/* Moving a feed replaces its row, the way unsubscribing asks in place: the
   entry that is being changed stays on screen while it is changed. */
.gf-moveform { display: grid; gap: 6px; padding: 4px 4px 8px; }
.gf-moveform-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.gf-addrow { display: flex; gap: 6px; justify-content: flex-end; }
/* The subscriptions dialog: numbered steps in reading order, so the file comes
   first and the strategy is chosen with its consequences in view. The trade is
   a choice of two cards, not a pair of small buttons next to Import. */
.gf-subs-dialog { width: min(480px, 100%); }
.gf-subs { display: grid; gap: 18px; }
.gf-subs-step { display: grid; gap: 8px; }
.gf-subs-step-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.gf-subs-step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.gf-subs-drop {
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 18px 12px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-skeleton);
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  text-align: center;
  transition: border-color .12s ease, background .12s ease;
}
@media (hover: hover) {
  .gf-subs-drop:hover { border-color: var(--dsw-alias-border-l4); background: var(--dsw-alias-interactive-bg-hover); }
}
.gf-subs-drop.dragging {
  border-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color);
  background: var(--dsw-alias-interactive-bg-hover);
}
.gf-subs-drop:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: 2px;
}
.gf-subs-drop.picked { grid-template-columns: 1fr auto; justify-items: start; text-align: left; }
.gf-subs-file { display: none; }
.gf-subs-drop-main { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-primary); }
.gf-subs-drop-sub { font-size: 11px; line-height: 15px; }
.gf-subs-file-name {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-primary);
}
.gf-subs-file-size { font-size: 11px; line-height: 15px; font-variant-numeric: tabular-nums; }
.gf-subs-file-change { grid-column: 1 / -1; font-size: 11px; line-height: 15px; color: var(--dsw-alias-link); }
.gf-subs-modes { display: grid; gap: 8px; }
.gf-subs-mode {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) {
  .gf-subs-mode:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.gf-subs-mode:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: 2px;
}
.gf-subs-mode.on {
  border-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color);
  background: var(--dsw-alias-interactive-bg-hover);
}
/* Replace is a real choice, not a variant of Merge: the card that removes
   subscriptions reads in the warning colour, selected or not. */
.gf-subs-mode.danger .gf-subs-mode-head { color: var(--dsw-alias-state-warn-primary); }
.gf-subs-mode.danger.on { border-color: var(--dsw-alias-state-warn-primary); }
.gf-subs-mode-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-primary);
}
.gf-subs-mode-name { font-weight: 600; }
.gf-subs-badge {
  padding: 0 6px;
  border-radius: var(--dsw-radius-xs);
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  line-height: 16px;
}
.gf-subs-mode-hint { font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.gf-subs-export {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.gf-subs-export-text { display: grid; gap: 4px; }
.gf-subs-export-hint { margin: 0; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.gf-subs-download { flex: none; white-space: nowrap; }
.gf-confirm { height: auto; min-height: 32px; flex-wrap: wrap; padding: 4px 6px; gap: 4px; }
.gf-confirm .name { flex: 1 1 100%; font-size: 12px; line-height: 18px; }
`
