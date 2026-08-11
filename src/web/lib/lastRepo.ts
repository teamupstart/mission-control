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

/**
 * The attached secondary repos of the last dispatch.
 *
 * A SECOND key rather than a JSON array under the first, so a build that predates
 * multi-repo tasks - or one an operator rolls back to - still reads the primary it always
 * read, out of the same string it always read it from. The whole value of this file is
 * that it survives a reload; a format change that made the existing value unreadable
 * would spend that to save a key.
 */
const EXTRAS_KEY = "mission-control.dispatch.extraRepos";

/** The remembered repo, or "" when there is none (or storage is unavailable). */
export function readLastDispatchRepo(): string {
  try {
    return localStorage.getItem(KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * The remembered secondary repos, or [] when there are none.
 *
 * Anything unreadable - absent, malformed, not an array of strings - reads as none, for
 * the reason every defensive parse in this app gives: a stale blob must not be able to
 * seed a dispatch form with something the operator cannot see is there.
 */
export function readLastDispatchExtraRepos(): string[] {
  try {
    const raw = localStorage.getItem(EXTRAS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * Remember the repos a dispatch was just submitted against.
 *
 * A blank primary is ignored rather than stored: submitting is impossible without a repo,
 * so the only way to get one here is a caller passing something it never sent, and
 * clearing the memory is not what that should mean. The secondaries are written on every
 * accepted dispatch INCLUDING an empty list, which is the opposite rule and the right one:
 * dispatching a single-repo task is the operator saying this run is one repo, and seeding
 * the next form with attachments they just dropped would be the surprise.
 */
export function rememberDispatchRepo(repoRoot: string, extraRepoRoots: string[] = []): void {
  const root = repoRoot.trim();
  if (!root) return;
  try {
    localStorage.setItem(KEY, root);
    const extras = extraRepoRoots.map((r) => r.trim()).filter(Boolean);
    if (extras.length > 0) localStorage.setItem(EXTRAS_KEY, JSON.stringify(extras));
    else localStorage.removeItem(EXTRAS_KEY);
  } catch {
    /* storage unavailable - the seed just doesn't survive this tab */
  }
}
