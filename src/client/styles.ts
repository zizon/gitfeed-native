/**
 * Reader layout and the few surfaces the shared atoms do not cover.
 *
 * Controls (buttons, inputs, menus, switches, toasts, icons) come from
 * `@deepseek-ai/dsh-client-ui-primitives`; this sheet only carries the reader's
 * own geometry and is written against the documented `--dsw-*` tokens.
 */

export const CSS = `
.gf {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 13px;
  line-height: 20px;
}
.gf *, .gf *::before, .gf *::after { box-sizing: border-box; }
.gf b { font-weight: 500; }
.gf-muted { color: var(--dsw-alias-label-tertiary); }
.gf-warn { color: var(--dsw-alias-state-warn-primary); }
.gf-danger { color: var(--dsw-alias-state-error-primary); }

.gf-toolbar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  min-height: 44px;
  padding: 8px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.gf-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gf-brand-name { font-size: 20px; line-height: 28px; font-weight: 500; }
.gf-spacer { flex: 1 1 auto; }
.gf-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.gf-search { width: 220px; min-width: 120px; flex: none; }
.gf-search.compact { flex: 1 1 auto; width: auto; min-width: 90px; }
.gf-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.gf-pills.compact { flex-wrap: nowrap; gap: 4px; }

.gf-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.gf-status b { color: var(--dsw-alias-label-primary); font-weight: 500; }

.gf-iconbtn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.gf-iconbtn.sm { width: 24px; height: 24px; border-radius: var(--dsw-radius-xs); }
.gf-iconbtn.on { color: var(--dsw-alias-state-warn-primary); }
.gf-iconbtn.danger { color: var(--dsw-alias-state-error-primary); }
.gf-iconbtn:disabled { opacity: .45; cursor: default; }
.gf-iconbtn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
@media (hover: hover) {
  .gf-iconbtn:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
  }
  .gf-iconbtn.danger:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover-danger);
    color: var(--dsw-alias-state-error-primary);
  }
}
.gf-iconbtn.spin > svg { animation: gf-spin 1.1s linear infinite; }
@keyframes gf-spin { to { transform: rotate(360deg); } }

.gf-body { flex: 1 1 auto; display: flex; min-width: 0; min-height: 0; }
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
  padding: 8px 8px 4px 12px;
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
@media (hover: hover) {
  .gf-feed:hover .gf-rail-x, .gf-folder-head:hover .gf-rail-x { color: var(--dsw-alias-state-error-primary); }
}
.gf-folder { margin-top: 2px; }
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
.gf-addrow { display: flex; gap: 6px; justify-content: flex-end; }
.gf-confirm { height: auto; min-height: 32px; flex-wrap: wrap; padding: 4px 6px; gap: 4px; }
.gf-confirm .name { flex: 1 1 100%; font-size: 12px; line-height: 18px; }

.gf-listbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.gf-count-label { flex: 1; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.gf-scrollwrap { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; position: relative; }
.gf-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; position: relative; }
.gf-listpane .gf-scroll { padding-bottom: 52px; }

.gf-group {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-menu-group-header-fill);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}
/* The header of the section the viewport sits in, while that header's own row
   is above the mounted band. It holds the top edge instead of pulling the rows
   back to it, so a section of thousands of rows costs one header, not all of
   them. */
.gf-group-pinned {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 3;
}

/* A section whose unread rows have all been read: kept on screen only so
   nothing moved under the pointer, and now on its way out. */
.gf-fade {
  opacity: 0;
  pointer-events: none;
  transition: opacity 340ms ease;
}

.gf-group-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gf-group-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.gf-group-unsub { color: var(--dsw-alias-label-tertiary); }
@media (hover: hover) {
  .gf-group-unsub:hover { color: var(--dsw-alias-state-error-primary); }
}

.gf-row {
  height: 66px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 4px 12px;
  cursor: pointer;
  user-select: none;
}
.gf-listpane.rows-plain .gf-row { height: 46px; }
.gf-row.active { background: var(--dsw-alias-interactive-bg-active); }
/* A row that landed while the reader was open fades in where it belongs
   instead of appearing as a hard cut in the middle of a scroll. */
.gf-row.gf-row-in { animation: gf-row-in 260ms ease-out both; }
@keyframes gf-row-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .gf-row.gf-row-in { animation: none; }
}
@media (hover: hover) {
  .gf-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.gf-row-title { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.gf-row.unread .gf-row-title { color: var(--dsw-alias-label-primary); }
.gf-row.unread .gf-row-title .t { font-weight: 500; }
.gf-row-title .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gf-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-brand-primary-new-colorprimary-new-color);
}
.gf-star { flex: none; display: inline-flex; color: var(--dsw-alias-state-warn-primary); }
.gf-row-meta { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.gf-row-meta .feed-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gf-row-meta .when { flex: none; margin-left: auto; font-variant-numeric: tabular-nums; }
.gf-row-digest {
  min-width: 0;
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gf-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 24px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.gf-placeholder.compact { padding: 40px 16px; justify-content: flex-start; }
.gf-placeholder-glyph { color: var(--dsw-alias-label-caption); margin-bottom: 4px; display: inline-flex; }
.gf-placeholder-title { font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.gf-placeholder-hint { margin: 0; max-width: 52ch; color: var(--dsw-alias-label-tertiary); }
.gf-placeholder-hint.error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.gf-placeholder-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-link);
  font-size: 13px;
  line-height: 20px;
}

.gf-banner {
  flex: none;
  padding: 6px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
  color: var(--dsw-alias-state-warn-primary);
  font-size: 12px;
  line-height: 18px;
}

.gf-article { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
.gf-article-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.gf-article-meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.gf-article-actions { display: flex; align-items: center; gap: 2px; flex: none; }
/* An anchor that reads as the shared small ghost button. */
.gf-article-open {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  text-decoration: none;
  white-space: nowrap;
}
@media (hover: hover) {
  .gf-article-open:hover { background: var(--dsw-alias-interactive-bg-hover); }
}
.gf-article-scroll { flex: 1; min-height: 0; overflow: auto; padding: 20px 24px 72px; }
.gf-article h1 { margin: 0 0 14px; font-size: 20px; line-height: 28px; font-weight: 600; }
.gf-article h1 a { color: inherit; text-decoration: none; }
@media (hover: hover) {
  .gf-article h1 a:hover { text-decoration: underline; }
}
.gf-article-body { font-size: 14px; line-height: 1.75; overflow-wrap: anywhere; }
.gf-article-body p { margin: 0 0 1em; }
.gf-article-body a { color: var(--dsw-alias-link); }
.gf-article-body img, .gf-article-body video { max-width: 100%; height: auto; border-radius: var(--dsw-radius-md); }
.gf-article-body pre {
  overflow: auto;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  line-height: 20px;
}
.gf-article-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.gf-article-body blockquote {
  margin: 0 0 1em;
  padding-left: 12px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.gf-article-body table { max-width: 100%; border-collapse: collapse; }
.gf-article-body td, .gf-article-body th { padding: 4px 8px; border: 0.5px solid var(--dsw-alias-border-l1); }
.gf-article-body hr { border: 0; border-top: 0.5px solid var(--dsw-alias-border-l1); margin: 1.5em 0; }
.gf-article-body figure { margin: 0 0 1em; }

/* Floating surfaces near a scroll edge: the shared floating fill plus panel
   elevation, with the stroke carried by the elevation inside the shadow. */
.gf-markfloat, .gf-readfloat {
  position: absolute;
  left: 50%;
  bottom: 14px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: calc(100% - 20px);
  padding: 3px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-button-floating-fill);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l3);
  box-shadow: var(--dsw-elevation-panel);
  transform: translateX(-50%);
  transition: opacity var(--ds-transition-duration-fast) ease;
}
.gf-markfloat.off { opacity: .55; }
/* The bar's action keeps the capsule's own padding and radius, because the
   shared Button would otherwise draw its 28px rounded rectangle inside it. */
.gf-markfloat .gf-markfloat-main, .gf-readfloat .gf-markfloat-main {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 340px;
  min-height: 28px;
  height: auto;
  padding: 4px 12px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.gf-markfloat-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gf-nextbtn { cursor: pointer; }
.gf-markfloat-count {
  flex: none;
  padding-inline-end: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}
@media (hover: hover) {
  .gf-markfloat .gf-markfloat-main:hover:not(:disabled),
  .gf-readfloat .gf-markfloat-main:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}

.gf-railpage { }
.gf-rail-bar { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 8px 4px; }
.gf-rail-bar2 { flex: none; display: flex; align-items: center; gap: 6px; padding: 0 8px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.gf-refresh-state {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  /* Fixed box so the age text does not reflow the bar as it ticks. */
  min-width: 4.4em;
  justify-content: flex-end;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}
.gf-refresh-state.running { color: var(--dsw-alias-state-business-primary); }
.gf-refresh-state.running > svg { animation: gf-spin 1.1s linear infinite; }
.gf-refresh-state.warn { color: var(--dsw-alias-state-warn-primary); }
.gf-feed-trigger {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  text-align: left;
}
.gf-feed-trigger .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gf-feed-trigger:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 0;
}
.gf-rail-article { flex: 1 1 auto; min-height: 0; display: flex; }
.gf-wide { flex: 1 1 auto; display: flex; min-height: 0; }
.gf-wide .gf-listpane { flex: 0 0 var(--gf-list, 340px); border-right: 0.5px solid var(--dsw-alias-border-l1); }
.gf-wide-article { flex: 1 1 auto; min-width: 0; display: flex; min-height: 0; }

/* Placement only: the menu material, radius, and elevation come from the
   shared MenuSurface. */
.gf .gf-popover {
  position: absolute;
  z-index: 40;
  top: 44px;
  left: 8px;
  right: 8px;
  max-height: 70%;
  display: flex;
  flex-direction: column;
}
.gf .gf-popover .gf-feedrail { flex: 1 1 auto; border-right: 0; background: transparent; min-height: 0; }
.gf-prefs-wrap { position: relative; display: flex; }
.gf .gf-prefs { top: 34px; right: 0; left: auto; width: 288px; max-height: none; }
.gf-prefrow {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
  padding: 4px 8px;
  border-radius: var(--dsw-radius-sm);
  font-size: 13px;
  line-height: 20px;
}
.gf-prefrow-label { flex: 1; min-width: 0; }
.gf-prefgroup { padding: 6px 8px 4px; }
.gf-prefgroup-label { padding: 2px 0 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; font-weight: 500; }
.gf-menubtn {
  justify-content: flex-start;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md);
  font-size: 13px;
  line-height: 20px;
}
.gf-menu-row { display: flex; align-items: center; gap: 8px; width: 100%; }
.gf-menu-count { margin-inline-start: auto; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
.gf-menu-label { padding: 6px 8px 2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; font-weight: 500; }
.gf-menu-info {
  padding: 2px 8px 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gf-menu-sep { height: 0.5px; margin: 4px 8px; background: var(--dsw-alias-border-l2); }

.gf-tab-title { display: inline-flex; align-items: center; gap: 6px; }

/* Native pages carry the macOS hidden-titlebar clearance above their own top inset. */
[data-platform='darwin'] .gf-page .gf-toolbar { padding-top: calc(8px + var(--dsh-frame-top-clearance, 0px)); }

@media (max-width: 760px) {
  .gf-toolbar { padding: 8px 10px; }
  .gf-brand-name { font-size: 18px; }
  .gf-articlepane { min-width: 260px; }
  .gf-feedrail { flex-basis: 180px; }
}
`
