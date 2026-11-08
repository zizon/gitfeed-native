/** Reader styles. Only the documented --dsw-alias-* theme tokens are used. */

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
  line-height: 1.5;
}
.gf *, .gf *::before, .gf *::after { box-sizing: border-box; }
.gf button, .gf input, .gf select { font: inherit; color: inherit; }
.gf button { cursor: pointer; }
.gf button:disabled { cursor: default; opacity: .5; }
.gf b { font-weight: 600; }
.gf-muted { color: var(--dsw-alias-label-secondary); }
.gf-warn { color: var(--dsw-alias-state-warn-primary); }
.gf-danger { color: var(--dsw-alias-state-error-primary); }

.gf-toolbar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.gf-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gf-brand-name { font-size: 20px; line-height: 28px; font-weight: 500; }
.gf-brand-count { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.gf-spacer { flex: 1 1 auto; }
.gf-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.gf-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
}
.gf-tab {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}
.gf-tab:hover { color: var(--dsw-alias-label-primary); }
.gf-tab.on {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l1) inset;
}
.gf-tabs.compact .gf-tab { padding: 0 7px; font-size: 12px; }

.gf-search {
  height: 28px;
  width: 220px;
  min-width: 120px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  outline: none;
}
.gf-search::placeholder { color: var(--dsw-alias-label-secondary); }
.gf-search:focus {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent);
}
.gf-search.compact { flex: 1 1 auto; width: auto; min-width: 80px; height: 26px; }

.gf-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  white-space: nowrap;
}
.gf-status b { color: var(--dsw-alias-label-primary); font-weight: 500; }

.gf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  text-decoration: none;
}
.gf-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.gf-btn.primary {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
}
.gf-btn.small { height: 26px; padding: 0 8px; font-size: 12px; }
.gf-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 15px;
  line-height: 1;
}
.gf-icon-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);
  color: var(--dsw-alias-label-primary);
}
.gf-icon-btn.star.on { color: var(--dsw-alias-state-warn-primary); }
.gf-linkbtn {
  border: 0;
  background: transparent;
  padding: 2px 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.gf-linkbtn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.gf-linkbtn.danger { color: var(--dsw-alias-state-error-primary); }
.gf-linkbtn.armed { color: var(--dsw-alias-state-error-primary); font-weight: 600; }
/* The mark menu and its counts: the action never hides how much it touches. */
.gf-menu-count {
  flex: none;
  min-width: 2.4em;
  text-align: right;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}
.gf-menu-row.danger { color: var(--dsw-alias-state-error-primary); }
.gf-menu-row.danger .gf-menu-count { color: inherit; }
.gf-menu-row.danger.armed { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); font-weight: 600; }
button.gf-menu-row:disabled { opacity: .45; cursor: default; }

.gf-body { flex: 1 1 auto; display: flex; min-width: 0; min-height: 0; }
.gf-feedrail {
  flex: 0 0 var(--gf-rail, 220px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l1);
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
.gf-splitter:hover::after {
  left: 1.5px;
  width: 2px;
  background: var(--dsw-alias-brand-primary);
}
.gf-listpane {
  position: relative;
  flex: 0 0 var(--gf-list, 430px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--dsw-alias-border-l1);
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
  gap: 6px;
  padding: 10px 10px 4px 12px;
}
.gf-rail-title {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary);
}
.gf-feedlist { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 6px 14px; }
.gf-rail-empty { padding: 18px 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; }
.gf-feed {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  user-select: none;
}
.gf-feed:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.gf-feed.on {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
  color: var(--dsw-alias-label-primary);
}
.gf-feed .name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.gf-feed .count {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.gf-feed.error .name { color: var(--dsw-alias-state-error-primary); }
.gf-dot-error {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-bg-base);
  font-size: 10px;
  font-weight: 700;
}
.gf-feed-check {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  /* Visible without hovering: the source and folder mark-read actions are
     what the reader uses most, and a hover reveal hid them entirely. */
  opacity: 1;
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
}
.gf-feed:hover .gf-feed-check, .gf-folder-head:hover .gf-feed-check, .gf-feed-check:focus-visible { opacity: 1; }
.gf-feed-check:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); color: var(--dsw-alias-label-primary); }
.gf-feed-x {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  opacity: 0;
  font-size: 13px;
  line-height: 1;
}
.gf-feed:hover .gf-feed-x, .gf-feed-x:focus-visible { opacity: 1; }
.gf-feed-x:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); color: var(--dsw-alias-label-primary); }
.gf-addbtn { color: var(--dsw-alias-label-secondary); }
.gf-confirm { flex-wrap: wrap; padding: 6px 8px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.gf-confirm .name { flex: 1 1 100%; font-size: 12px; }
.gf-folder { margin-top: 2px; }
.gf-folder-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  user-select: none;
}
.gf-folder-head:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.gf-folder-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.gf-folder-head .count { font-size: 11px; font-variant-numeric: tabular-nums; }
.gf-chevron { display: inline-flex; color: var(--dsw-alias-label-secondary); transition: transform .12s ease; }
.gf-chevron.open { transform: rotate(90deg); }

.gf-addform { display: grid; gap: 6px; padding: 8px; }
.gf-input {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  outline: none;
  font-size: 12px;
}
.gf-input:focus { border-color: var(--dsw-alias-brand-primary); }
.gf-addrow { display: flex; gap: 6px; }

.gf-markfloat {
  position: absolute;
  left: 50%;
  bottom: 14px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: calc(100% - 20px);
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
  transform: translateX(-50%);
  transition: opacity .15s ease;
}
.gf-markfloat.off { opacity: .5; }
/* Same shape, article side: the reading control appears once the reader is
   past the opening of the piece. */
.gf-readfloat {
  position: absolute;
  left: 50%;
  bottom: 14px;
  z-index: 30;
  display: flex;
  padding: 3px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
  transform: translateX(-50%);
}
.gf-markfloat-main {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 340px;
  padding: 5px 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}
.gf-markfloat-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gf-markfloat-main.wide .gf-markfloat-label { font-weight: 600; }
.gf-markfloat-main:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.gf-markfloat-count {
  flex: none;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
}
.gf-markfloat-more {
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 1;
}
.gf-markfloat-more:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); color: var(--dsw-alias-label-primary); }
.gf-toast-undo {
  margin-left: 10px;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-brand-primary);
  font-size: 12px;
  font-weight: 600;
  text-decoration: underline;
}
.gf-listbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.gf-count-label { flex: 1; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.gf-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; position: relative; }
.gf-listpane > .gf-scroll { padding-bottom: 46px; }
.gf-group { position: sticky; top: 0; z-index: 2; background: var(--dsw-alias-bg-base); }
.gf-row {
  height: 66px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  padding: 4px 12px;
  border-left: 2px solid transparent;
  cursor: pointer;
  user-select: none;
}
.gf-listpane.rows-plain .gf-row { height: 46px; }
.gf-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.gf-row.active {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 13%, transparent);
  border-left-color: var(--dsw-alias-brand-primary);
}
.gf-row-title { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.gf-row.unread .gf-row-title { color: var(--dsw-alias-label-primary); }
.gf-row.unread .gf-row-title .t { font-weight: 600; }
.gf-row-title .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gf-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.gf-star { flex: none; color: var(--dsw-alias-state-warn-primary); font-size: 11px; }
.gf-row-meta { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.gf-row-meta .feed-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gf-row-meta .when { flex: none; margin-left: auto; font-variant-numeric: tabular-nums; }
.gf-row-digest {
  min-width: 0;
  font-size: 12px;
  line-height: 1.3;
  color: var(--dsw-alias-label-secondary);
  opacity: .82;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gf-group {
  height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.gf-group-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gf-group-count { font-variant-numeric: tabular-nums; }
.gf-group-read { margin-left: auto; }
.gf-empty { padding: 40px 24px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.7; }
.gf-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 32px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
}
.gf-placeholder .big { font-size: 20px; line-height: 28px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.gf-placeholder p { margin: 0; font-size: 12px; }

.gf-article {
  position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
.gf-article-top {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.gf-article-meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.gf-article-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.gf-article-scroll { flex: 1; min-height: 0; overflow: auto; padding: 18px 22px 64px; }
.gf-article h1 { margin: 0 0 14px; font-size: 22px; line-height: 1.32; font-weight: 600; }
.gf-article h1 a { color: inherit; text-decoration: none; }
.gf-article h1 a:hover { text-decoration: underline; }
.gf-article-body { font-size: 14px; line-height: 1.72; overflow-wrap: anywhere; }
.gf-article-body p { margin: 0 0 1em; }
.gf-article-body a { color: var(--dsw-alias-brand-primary); }
.gf-article-body img, .gf-article-body video { max-width: 100%; height: auto; border-radius: 8px; }
.gf-article-body pre {
  overflow: auto;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
}
.gf-article-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
.gf-article-body blockquote {
  margin: 0 0 1em;
  padding-left: 12px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.gf-article-body table { max-width: 100%; border-collapse: collapse; }
.gf-article-body td, .gf-article-body th { padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l1); }
.gf-article-body hr { border: 0; border-top: 1px solid var(--dsw-alias-border-l1); margin: 1.5em 0; }
.gf-article-body figure { margin: 0 0 1em; }

.gf-railpage { }
.gf-rail-bar { flex: none; display: flex; align-items: center; gap: 4px; padding: 8px 8px 4px; }
.gf-rail-bar2 { flex: none; display: flex; align-items: center; gap: 6px; padding: 0 8px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.gf-refresh-state {
  flex: none;
  /* Fixed box so the age text does not reflow the bar as it ticks. */
  min-width: 4.4em;
  text-align: right;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: .9;
}
.gf-refresh-state.running { color: var(--dsw-alias-brand-primary); animation: gf-pulse 1.2s ease-in-out infinite; }
.gf-refresh-state.warn { color: var(--dsw-alias-state-warn-primary); }
@keyframes gf-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
.gf-icon-btn.spin { animation: gf-spin 1.1s linear infinite; }
@keyframes gf-spin { to { transform: rotate(360deg); } }
.gf-feed-trigger {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px;
  text-align: left;
}
.gf-feed-trigger .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gf-rail-article { flex: 1 1 auto; min-height: 0; display: flex; }
.gf-wide { flex: 1 1 auto; display: flex; min-height: 0; }
.gf-wide .gf-listpane { flex: 0 0 var(--gf-list, 340px); border-right: 1px solid var(--dsw-alias-border-l1); }
.gf-wide-article { flex: 1 1 auto; min-width: 0; display: flex; min-height: 0; }

.gf-popover {
  position: absolute;
  z-index: 30;
  top: 76px;
  left: 8px;
  right: 8px;
  display: flex;
  flex-direction: column;
  max-height: 70%;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 14px 36px color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent);
}
.gf-popover .gf-feedrail { flex: 1 1 auto; border-right: 0; background: transparent; min-height: 0; }
.gf-popover .gf-rail-head { padding-top: 8px; }
.gf-menu {
  position: absolute;
  z-index: 40;
  top: 38px;
  right: 8px;
  width: 264px;
  /* The anchored wrap is the button, not the pane, so a percentage cap would
     shrink this menu to the button's width. Cap against the viewport instead. */
  max-width: calc(100vw - 24px);
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 14px 36px color-mix(in srgb, var(--dsw-alias-label-primary) 20%, transparent);
}
.gf-prefs-wrap { position: relative; }
.gf-prefs { top: 34px; right: 0; width: 280px; }
.gf-menu-label {
  padding: 4px 8px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .05em;
  text-transform: uppercase;
}
.gf-menu-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  font-size: 13px;
}
button.gf-menu-row:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.gf-menu-text { flex: 1; min-width: 0; }
.gf-menu-sep { height: 1px; margin: 6px 4px; background: var(--dsw-alias-border-l1); }
.gf-menu-repo {
  padding: 2px 8px 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gf-menu-hint {
  padding: 0 8px 6px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font-size: 11px;
  line-height: 1.45;
  opacity: 0.85;
}
.gf-select {
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
}
.gf-switch {
  position: relative;
  flex: none;
  width: 30px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent);
}
.gf-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-base);
  transition: transform .15s ease;
}
.gf-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.gf-switch[aria-checked='true']::after { transform: translateX(12px); }

.gf-toasts {
  position: absolute;
  left: 50%;
  bottom: 14px;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: calc(100% - 24px);
  transform: translateX(-50%);
  pointer-events: none;
}
.gf-toast {
  padding: 8px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.gf-toast.error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }

.gf-banner {
  flex: none;
  padding: 6px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
.gf-errorpage {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
}
.gf-errorpage h2 { margin: 0; font-size: 18px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.gf-errorpage p { margin: 0; max-width: 560px; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.gf-errorpage .gf-btn { margin-top: 6px; }

.gf-header-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.gf-header-btn:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  color: var(--dsw-alias-label-primary);
}
.gf-tab-title { display: inline-flex; align-items: center; gap: 6px; }

/* Native pages carry the macOS hidden-titlebar clearance above their own top inset. */
[data-platform='darwin'] .gf-page .gf-toolbar { padding-top: calc(12px + var(--dsh-frame-top-clearance, 0px)); }

/* The scope menu opens upward from the floating bar at the bottom of the list;
   declared after .gf-menu so it wins the shared offsets. */
.gf-markfloat .gf-markmenu { top: auto; right: 0; bottom: 40px; width: 244px; }

@media (max-width: 760px) {
  .gf-toolbar { padding: 10px 12px; }
  .gf-brand-name { font-size: 18px; }
  .gf-articlepane { min-width: 260px; }
  .gf-feedrail { flex-basis: 180px; }
}
`
