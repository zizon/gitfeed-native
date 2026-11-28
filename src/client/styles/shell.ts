/** Base geometry and the page bar. */

export const SHELL = `
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
  /* The bar is also the container that decides when its actions may drop
     their labels; below that width they become icon buttons with tooltips. */
  container: gf-pagebar / inline-size;
}
.gf-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gf-brand-name { font-size: 20px; line-height: 28px; font-weight: 500; }
.gf-spacer { flex: 1 1 auto; }
.gf-search { flex: 0 1 220px; min-width: 120px; }
.gf-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto; }
/* Page-toolbar actions keep the Harness page bar's control height and type
   size rather than the menu-sized 28px capsule. */
.gf-actbtn { height: 32px; padding: 0 12px; border-radius: var(--dsw-radius-md); font-size: 13px; line-height: 20px; }
/* The two things the bar acts on: the feeds' contents, and the git-backed
   archive that carries items and read state between machines. */
.gf-actionsep { width: 1px; align-self: stretch; margin: 6px 0; background: var(--dsw-alias-border-l1); }
@container gf-pagebar (max-width: 1140px) {
  .gf-actbtn { width: 32px; min-width: 32px; padding: 0; }
  .gf-actbtn-label { display: none; }
  /* The actions gave up their labels; the field gives up 70px so the bar
     stays one row instead of dropping the group under the filters. */
  .gf-search { flex-basis: 148px; }
}
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
`
