/**
 * The repo the last dispatch went to, remembered so the next one starts there.
 *
 * Operators dispatch in runs - three tasks into the same checkout, then a switch -
 * so an empty repo field asks the same question it was just answered. Seeding it
 * costs nothing to override (the combobox is still free text) and saves retyping
 * the answer for every task in a run.
 *
 * In localStorage, and the LAST thing here - the layout, alert settings and keybindings
 * that used to sit beside it are the daemon's now, because losing a setting to a rename
 * or a new port was a real bug (docs/plans/ui-settings-to-daemon/plan.md). This stays
 * because it is a convenience, not a preference: it is never chosen, only observed, and
 * losing it costs one retype of a field that is still free text. Surviving a reload is
 * the point - the tab is refreshed far more often than the repo changes - and being
 * per-origin is not wrong for it the way it was wrong for a setting.
 */

const KEY = "mission-control.dispatch.repo";

/** The remembered repo, or "" when there is none (or storage is unavailable). */
export function readLastDispatchRepo(): string {
  try {
    return localStorage.getItem(KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Remember the primary repo a dispatch was just submitted against.
 *
 * A blank primary is ignored rather than stored: submitting is impossible without a repo,
 * so the only way to get one here is a caller passing something it never sent, and
 * clearing the memory is not what that should mean. Secondary repos are deliberately not
 * remembered: they widen one task's worktree and write scope, rather than describing the
 * run of work the primary-repo convenience is meant to speed up.
 */
export function rememberDispatchRepo(repoRoot: string): void {
  const root = repoRoot.trim();
  if (!root) return;
  try {
    localStorage.setItem(KEY, root);
  } catch {
    /* storage unavailable - the seed just doesn't survive this tab */
  }
}
