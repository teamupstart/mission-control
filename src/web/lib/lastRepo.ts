/**
 * The repo the last dispatch went to, remembered so the next one starts there.
 *
 * Operators dispatch in runs - three tasks into the same checkout, then a switch -
 * so an empty repo field asks the same question it was just answered. Seeding it
 * costs nothing to override (the combobox is still free text) and saves retyping
 * the answer for every task in a run.
 *
 * Persisted per-machine in localStorage next to the layout, alert settings and
 * keybindings: it's a fact about how this screen is being used, not about the fleet,
 * so it never goes near the daemon. Surviving a reload is the point - the tab is
 * refreshed far more often than the repo changes.
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
 * Remember the repo a dispatch was just submitted against.
 *
 * A blank is ignored rather than stored: submitting is impossible without a repo, so
 * the only way to get one here is a caller passing something it never sent, and
 * clearing the memory is not what that should mean.
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
