// The Trust matrix's row vocabulary, as pure functions the panel and its tests share.
//
// Trust is a VIEW over four existing `repoAllowlist`s (Foreman sends live, Workflows act,
// Inspector posts reviews, YOLO merges) plus the panel's staged list (`UiConfig.trustStaged`,
// the home for a repo added but granted nothing). Turning those five lists into one sorted
// table of repos, and spotting the dangerous combinations, is arithmetic - no React,
// no fetch - so it lives here where a render test can drive it without stubbing anything.

/**
 * The four allowlists a row is read from, by the grant each one confers.
 *
 * A named object rather than positional arguments because every member has the same type:
 * five bare `string[]`s in a row is a call site where transposing two of them type-checks
 * and silently attributes one subsystem's grants to another. `grantPatch` already took its
 * lists this way; `trustRows` now matches it.
 */
export interface TrustLists {
  foreman: readonly string[];
  /** Workflows' single allowlist. See `TrustRow.workflows` for what it actually permits. */
  workflows: readonly string[];
  inspector: readonly string[];
  shipping: readonly string[];
  staged: readonly string[];
}

/** One matrix row: a repo and which of the four grants it currently holds. */
export interface TrustRow {
  repo: string;
  /** In Foreman's allowlist: Foreman may answer prompts here without asking. */
  foreman: boolean;
  /**
   * In Workflows' allowlist. ONE cell, TWO capabilities, because it is one stored list:
   * `WorkflowConfig.repoAllowlist` gates Live repair delivery (typed into this repo's live
   * sessions) and Check-node command execution (branch-authored code, run with the daemon's
   * filesystem authority). Each still needs its own switch on the Workflows panel -
   * `liveEnabled` and `checksEnabled` - so this cell is necessary for both and sufficient
   * for neither. Splitting it into two columns would need two stored lists first; two
   * columns over one list would flip together and lie about being separate grants.
   */
  workflows: boolean;
  /** In the Inspector's allowlist: it may post review comments on this repo's PRs. */
  inspector: boolean;
  /** In Shipping's allowlist: clean, soaked PRs here may merge themselves. */
  merge: boolean;
}

/**
 * The sorted union of every repo any of the five lists names, each with its four grants.
 *
 * Staged repos are folded in exactly like allowlist repos, which is what makes an
 * ungranted row survive a reload; a staged repo that has since gained a grant appears once
 * (the union de-duplicates by path) with that grant, and its staged membership is
 * irrelevant to the row - the allowlists win. Sorted by path so the table has a stable
 * order no matter which list a repo entered through.
 */
export function trustRows(lists: TrustLists): TrustRow[] {
  const repos = new Set<string>([
    ...lists.foreman,
    ...lists.workflows,
    ...lists.inspector,
    ...lists.shipping,
    ...lists.staged,
  ]);
  return [...repos].sort().map((repo) => ({
    repo,
    foreman: lists.foreman.includes(repo),
    workflows: lists.workflows.includes(repo),
    inspector: lists.inspector.includes(repo),
    merge: lists.shipping.includes(repo),
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
 * The rows where a workflow Check node may execute branch-authored code right now.
 *
 * Not a contradiction like `mergeBlindSpots` - nothing here is trapped, and the grant does
 * exactly what it says. It is flagged because it is the strongest thing any cell in this
 * matrix permits and the *least* legible from the cell itself: the Workflows column reads
 * as one grant, its heavier half is armed by a switch on another page, and the confirm
 * dialog that spelled out "this is not a sandbox" was agreed to once and is never shown
 * again. Trust is where an operator comes months later to ask what is still on, so the
 * answer has to be visible without going and reading `checksEnabled`.
 *
 * Armed-only, on `mergeBlindSpots`' rule: a workflow grant with checks off cannot run a
 * command, and flagging inert grants is what teaches an operator to stop reading amber.
 */
export function checkExecutionGrants(
  rows: readonly TrustRow[],
  checksArmed: boolean,
): TrustRow[] {
  if (!checksArmed) return [];
  return rows.filter((r) => r.workflows);
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
export type GrantColumn = "foreman" | "workflows" | "inspector" | "merge";

/**
 * The write one cell click produces. Kept as data - which subsystem's config route the
 * FULL new list is written to, plus whether the staged list changed - so the component is
 * a thin dispatcher over it and the routing ("exactly the owning subsystem") is a pure
 * function a test can drive without a DOM. This repo renders with `renderToStaticMarkup`
 * and has no jsdom, so a cell click is unassertable any other way.
 */
export interface GrantPatch {
  /** The config route the new list is PUT to. `merge` is Shipping's grant, hence the map. */
  subsystem: "foreman" | "workflows" | "inspector" | "shipping";
  /** The owning allowlist after the toggle - the full new list, never a delta. */
  repoAllowlist: string[];
  /**
   * The staged list after the toggle, or null when it is unchanged. A FIRST grant retires
   * the staged entry (the repo now lives in a real allowlist); a revoke, or a grant on a
   * repo that was never staged, leaves it be.
   */
  trustStaged: string[] | null;
}

/**
 * Which subsystem's allowlist each column IS. A table rather than a ternary chain because
 * only one entry is a rename (`merge` is Shipping's list) and a chain buries that one fact
 * among three identities; this way the exception is a line you can point at.
 */
const COLUMN_OWNER = {
  foreman: "foreman",
  workflows: "workflows",
  inspector: "inspector",
  merge: "shipping",
} as const satisfies Record<GrantColumn, GrantPatch["subsystem"]>;

export function grantPatch(
  column: GrantColumn,
  repo: string,
  currentlyOn: boolean,
  lists: TrustLists,
): GrantPatch {
  const subsystem = COLUMN_OWNER[column];
  const current = lists[subsystem];
  const repoAllowlist = currentlyOn ? current.filter((p) => p !== repo) : [...current, repo];
  const trustStaged =
    !currentlyOn && lists.staged.includes(repo) ? lists.staged.filter((p) => p !== repo) : null;
  return { subsystem, repoAllowlist, trustStaged };
}
