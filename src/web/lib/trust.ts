// The Trust matrix's row vocabulary, as pure functions the panel and its tests share.
//
// Trust is a VIEW over three existing `repoAllowlist`s (Foreman sends live, Inspector
// posts reviews, YOLO merges) plus the panel's staged list (`UiConfig.trustStaged`, the
// home for a repo added but granted nothing). Turning those four lists into one sorted
// table of repos, and spotting the one dangerous combination, is arithmetic - no React,
// no fetch - so it lives here where a render test can drive it without stubbing anything.

/** One matrix row: a repo and which of the three grants it currently holds. */
export interface TrustRow {
  repo: string;
  /** In Foreman's allowlist: Foreman may answer prompts here without asking. */
  foreman: boolean;
  /** In the Inspector's allowlist: it may post review comments on this repo's PRs. */
  inspector: boolean;
  /** In Shipping's allowlist: clean, soaked PRs here may merge themselves. */
  merge: boolean;
}

/**
 * The sorted union of every repo any of the four lists names, each with its three grants.
 *
 * Staged repos are folded in exactly like allowlist repos, which is what makes an
 * ungranted row survive a reload; a staged repo that has since gained a grant appears once
 * (the union de-duplicates by path) with that grant, and its staged membership is
 * irrelevant to the row - the allowlists win. Sorted by path so the table has a stable
 * order no matter which list a repo entered through.
 */
export function trustRows(
  foremanList: readonly string[],
  inspectorList: readonly string[],
  shippingList: readonly string[],
  staged: readonly string[],
): TrustRow[] {
  const repos = new Set<string>([...foremanList, ...inspectorList, ...shippingList, ...staged]);
  return [...repos].sort().map((repo) => ({
    repo,
    foreman: foremanList.includes(repo),
    inspector: inspectorList.includes(repo),
    merge: shippingList.includes(repo),
  }));
}

/**
 * The rows where the merge-without-review blind spot is live: YOLO would merge here, but
 * the Inspector may not review here, so nothing will ever qualify and nothing merges.
 *
 * Only meaningful while YOLO is armed - a merge grant with YOLO off is inert, so warning
 * about it would train the operator to ignore the amber. This is the same fact the
 * Shipping panel's `untrustedByInspector` computes and the daemon's `inspectorPosture`
 * gates on, projected onto the matrix's rows.
 */
export function mergeBlindSpots(rows: readonly TrustRow[], yoloArmed: boolean): TrustRow[] {
  if (!yoloArmed) return [];
  return rows.filter((r) => r.merge && !r.inspector);
}

/**
 * Repos worth offering in the add picker: known repos, minus the ones already in the
 * matrix. Moved here from `ForemanSettingsPanel` when the three panels stopped editing
 * repo lists - the Trust add row is its one remaining consumer.
 */
export function candidateRepos(repos: readonly string[], present: readonly string[]): string[] {
  return repos.filter((r) => !present.includes(r));
}

/** Which matrix column a cell belongs to, keyed by the grant it toggles. */
export type GrantColumn = "foreman" | "inspector" | "merge";

/**
 * The write one cell click produces. Kept as data - which subsystem's config route the
 * FULL new list is written to, plus whether the staged list changed - so the component is
 * a thin dispatcher over it and the routing ("exactly the owning subsystem") is a pure
 * function a test can drive without a DOM. This repo renders with `renderToStaticMarkup`
 * and has no jsdom, so a cell click is unassertable any other way.
 */
export interface GrantPatch {
  /** The config route the new list is PUT to. `merge` is Shipping's grant, hence the map. */
  subsystem: "foreman" | "inspector" | "shipping";
  /** The owning allowlist after the toggle - the full new list, never a delta. */
  repoAllowlist: string[];
  /**
   * The staged list after the toggle, or null when it is unchanged. A FIRST grant retires
   * the staged entry (the repo now lives in a real allowlist); a revoke, or a grant on a
   * repo that was never staged, leaves it be.
   */
  trustStaged: string[] | null;
}

export function grantPatch(
  column: GrantColumn,
  repo: string,
  currentlyOn: boolean,
  lists: {
    foreman: readonly string[];
    inspector: readonly string[];
    shipping: readonly string[];
    staged: readonly string[];
  },
): GrantPatch {
  const subsystem = column === "foreman" ? "foreman" : column === "inspector" ? "inspector" : "shipping";
  const current =
    column === "foreman" ? lists.foreman : column === "inspector" ? lists.inspector : lists.shipping;
  const repoAllowlist = currentlyOn ? current.filter((p) => p !== repo) : [...current, repo];
  const trustStaged =
    !currentlyOn && lists.staged.includes(repo) ? lists.staged.filter((p) => p !== repo) : null;
  return { subsystem, repoAllowlist, trustStaged };
}
