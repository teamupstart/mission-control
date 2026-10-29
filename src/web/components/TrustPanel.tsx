import { Fragment, useEffect, useRef, useState } from "react";
import type { ForemanState } from "../useForeman.ts";
import type { InspectorState } from "../useInspector.ts";
import type { ShippingState } from "../useShipping.ts";
import type { WorkflowSettingsState } from "../useWorkflowSettings.ts";
import { useUiConfig, updateUiConfig } from "../lib/uiConfig.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import {
  addRepositoriesPatch,
  candidateRepos,
  checkExecutionGrants,
  DEFAULT_ADD_GRANTS,
  grantPatch,
  mergeBlindSpots,
  trustRows,
  type ChecksArmedReading,
  type GrantColumn,
  type TrustRow,
} from "../lib/trust.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { repoLeaf } from "../lib/format.ts";
import { useTourTargetRef } from "../tour/target-context.tsx";
import { filterRepos, repoOptionLabels } from "./RepoCombobox.tsx";
import { RepositoryName } from "./RepositoryName.tsx";
import { Tooltip } from "./Tooltip.tsx";

// Trust: one repository x grant matrix over the four existing allowlists.
//
// It stores NOTHING of its own about who may act where - each column is a subsystem's own
// `repoAllowlist`, and a cell click patches that subsystem's config through the exact route
// its panel used to. The daemon's four consent gates are untouched; this is a view that
// happens to be able to write to what it shows. The one piece of state it does own is the
// staged list (`UiConfig.trustStaged`): a repo in the table that holds no grant lives in no
// allowlist, so without a home of its own it would vanish on the next reload. Adding grants
// `DEFAULT_ADD_GRANTS` straight away, so a repo lands there only when none of those writes
// could be made - or because an older build staged it ungranted.
//
// The page is two panes side by side, so adding never sits below a long table: the left
// pane picks any number of the workspace's repositories (or a typed path) and adds them in
// one batch, the right pane is the matrix with a filter of its own. Each pane scrolls inside
// itself.
//
// Two combinations are flagged amber, and they are different kinds of thing. The merge
// blind spot is a CONTRADICTION - a repo YOLO may merge but the Inspector may not review
// can never qualify, so nothing happens and the reason is invisible - and both the trapped
// merge cell and the empty inspector cell that would fix it go amber, with a footnote
// offering the two fixes in place. Armed check execution is not broken at all; it is
// flagged because it is the heaviest grant here and the one whose weight the cell cannot
// show on its own. See `checkExecutionGrants`.

/**
 * The four columns, left to right, each naming the grant by what it permits.
 *
 * `label` is the grant's full name, which every cell's accessible name and the header's
 * tooltip carry. `short` is what the header prints: the matrix shares its row with the add
 * pane, and the full names would not fit four columns of pills beside it.
 */
const COLUMNS = [
  {
    key: "foreman",
    label: "Foreman sends live",
    short: "Foreman",
    title: "Foreman answers prompts in this repo's sessions without asking you.",
  },
  {
    // Second, not last: the columns run local-blast-radius first (Foreman, Workflows) and
    // GitHub second (Inspector, YOLO), so the two halves of the "Acts on GitHub" badge the
    // rail draws over this category are contiguous rather than interleaved.
    key: "workflows",
    label: "Workflows act",
    short: "Workflows",
    // ONE cell, both capabilities, because it is one stored list - said in full here since
    // this tooltip is the only place the second one is visible from the matrix.
    //
    // It no longer says the two are "armed separately in Workflows settings". Both switches
    // now ship ON, so on a machine nobody has reconfigured this cell is the LAST gate for
    // both, and describing the grant as half a decision would understate it at exactly the
    // moment it is being made.
    //
    // But it must not overstate it either, and "both are on unless you turned them off" did:
    // a policy stored before `checksEnabled` existed is held OFF by `getWorkflowPolicy`, so
    // an upgraded machine can grant this cell and still run no Command. Pointing at the
    // Workflows panel rather than asserting a state is the honest form - that panel says
    // which way each switch actually is, and this tooltip cannot know. The double dagger
    // below the matrix answers it for real, naming the repositories where Commands are live.
    title:
      "Workflows may act in this repo: Live repairs typed into its sessions, and workflow "
      + "Commands run against branch code with the daemon's filesystem authority. New "
      + "installations ship both on; Workflows settings shows where yours stand.",
  },
  {
    key: "inspector",
    label: "GitHub Inspector posts reviews",
    short: "GitHub Inspector",
    title: "Publishes review comments on this repo's PRs under your GitHub account.",
  },
  {
    key: "merge",
    label: "YOLO merges",
    short: "YOLO merges",
    title: "Clean, soaked PRs in this repo merge themselves to the base branch.",
  },
] as const;

/**
 * Compact repository names inside a warning, except where compacting would make two entries
 * read as the same repository. In that collision only, the full paths stay visible as well
 * as available on hover; `api, api` would otherwise look like a rendering error and leave the
 * reader unable to tell which grant each occurrence names.
 */
function WarningRepositoryList({ repos }: { repos: string[] }): React.JSX.Element {
  const leafCounts = new Map<string, number>();
  for (const repo of repos) {
    const leaf = repoLeaf(repo);
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);
  }

  return (
    <>
      {repos.map((repo, index) => {
        const ambiguous = (leafCounts.get(repoLeaf(repo)) ?? 0) > 1;
        return (
          <Fragment key={repo}>
            {index > 0 ? ", " : null}
            {ambiguous ? (
              <Tooltip label={repo}>
                <span className="trust-warning-repo">{repo}</span>
              </Tooltip>
            ) : (
              <RepositoryName path={repo} className="trust-warning-repo" />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

export function TrustPanel({
  foreman,
  workflows,
  inspector,
  shipping,
  checks,
}: {
  /**
   * The four subsystem states, OWNED ELSEWHERE and passed in: Foreman by App (the topbar
   * shares it), Workflows, the Inspector and Shipping by `SettingsPage`. Trust must not
   * instantiate a second `useForeman`/`useWorkflowSettings`/`useInspector`/`useShipping` -
   * that would double-poll the same routes App and the page already poll, and let a cell
   * and a panel disagree about a list.
   */
  foreman: ForemanState;
  workflows: WorkflowSettingsState;
  inspector: InspectorState;
  shipping: ShippingState;
  /**
   * Whether a Check node may run branch-authored code, and whether that is confirmed.
   *
   * PASSED IN, not derived from `workflows.config` here, because it has to survive a failed
   * poll: `useWorkflowSettings` nulls its config on any read that fails, and this panel
   * unmounts whenever another category is open, so a memory kept here would reset every
   * time you navigated away. `SettingsPage` is mounted for the whole settings session and
   * owns it, which is also what keeps this footnote and the rail dot saying the same thing.
   */
  checks: ChecksArmedReading;
}): React.JSX.Element {
  // The two spotlights the Setup tour's Trust half points at: the whole matrix, and the pane
  // that adds repositories to it. The matrix rather than a cell or a column - which grants a
  // machine needs depends on which repositories it works in, and a row may not exist yet.
  const matrixTourRef = useTourTargetRef<HTMLDivElement>("setup:trust-matrix");
  const addTourRef = useTourTargetRef<HTMLDivElement>("setup:trust-add");
  const ui = useUiConfig();
  /** The workspace's repositories, or null until the first read lands. */
  const [repos, setRepos] = useState<string[] | null>(null);
  /** The add pane's search over repositories not yet in the matrix. */
  const [pickQuery, setPickQuery] = useState("");
  /** Picked repositories, kept across searches so a batch can be built from several. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  /** A path typed by hand, for a checkout the workspace scan did not find. */
  const [pathDraft, setPathDraft] = useState("");
  /** The matrix pane's filter over repositories already in it. */
  const [trustedQuery, setTrustedQuery] = useState("");
  /** The last batch added, tagged "new" in the matrix so the rows can be found again. */
  const [recent, setRecent] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // The workspace's git repos, for the add picker - same source the four panels used.
  useEffect(() => {
    void fetchRepos().then(setRepos);
  }, []);

  const foremanList = foreman.config?.repoAllowlist ?? [];
  const workflowsList = workflows.config?.repoAllowlist ?? [];
  const inspectorList = inspector.config?.repoAllowlist ?? [];
  const shippingList = shipping.config?.repoAllowlist ?? [];
  const staged = ui.trustStaged;
  const yolo = shipping.config?.autoMerge ?? false;
  const checksArmed = checks.armed;

  // The stale-closure guard the panels use, five times over: every write does a server
  // round-trip while the configs poll every 4-5s underneath it, so a cell click must
  // extend whatever is in force when it lands, not what was on screen when it was clicked.
  const foremanRef = useRef(foremanList);
  foremanRef.current = foremanList;
  const workflowsRef = useRef(workflowsList);
  workflowsRef.current = workflowsList;
  const inspectorRef = useRef(inspectorList);
  inspectorRef.current = inspectorList;
  const shippingRef = useRef(shippingList);
  shippingRef.current = shippingList;
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  // Workflows' route is a PUT of the WHOLE config, not a patch like the other three, so a
  // write here has to spread a config object - and spreading the render-time one would post
  // a stale `liveEnabled`/`checksEnabled`/retention back over whatever a poll or another tab
  // changed in the meantime. Held as a ref for the same reason the lists are.
  const workflowConfigRef = useRef(workflows.config);
  workflowConfigRef.current = workflows.config;

  const rows = trustRows({
    foreman: foremanList,
    workflows: workflowsList,
    inspector: inspectorList,
    shipping: shippingList,
    staged,
  });
  const blindSpots = mergeBlindSpots(rows, yolo);
  const blindRepos = blindSpots.map((r) => r.repo);
  const checkGrants = checkExecutionGrants(rows, checksArmed);
  const checkRepos = checkGrants.map((r) => r.repo);

  // "Unknown, not off" (D7): a null config is an unreachable daemon, which is not evidence
  // the grant is absent. Name which subsystems we cannot read rather than drawing their
  // columns as if empty were fact.
  const unknown = [
    !foreman.config && "Foreman",
    !workflows.config && "Workflows",
    !inspector.config && "GitHub Inspector",
    !shipping.config && "Shipping",
  ].filter((x): x is string => Boolean(x));

  async function grant(key: GrantColumn, repo: string, on: boolean): Promise<void> {
    // The decision - owning subsystem, full new list, staged prune - is a pure function so
    // it can be tested without a click; the refs feed it whatever is in force right now.
    const plan = grantPatch(key, repo, on, {
      foreman: foremanRef.current,
      workflows: workflowsRef.current,
      inspector: inspectorRef.current,
      shipping: shippingRef.current,
      staged: stagedRef.current,
    });
    let ok: boolean;
    if (plan.subsystem === "foreman") {
      if (!foreman.config) return;
      ok = await foreman.update({ repoAllowlist: plan.repoAllowlist });
    } else if (plan.subsystem === "workflows") {
      const config = workflowConfigRef.current;
      if (!config) return;
      ok = await workflows.update({ ...config, repoAllowlist: plan.repoAllowlist });
    } else if (plan.subsystem === "inspector") {
      if (!inspector.config) return;
      ok = await inspector.update({ repoAllowlist: plan.repoAllowlist });
    } else {
      if (!shipping.config) return;
      ok = await shipping.update({ repoAllowlist: plan.repoAllowlist });
    }
    // Retire the staged entry ONLY after the grant write is confirmed: pruning it
    // eagerly would, on a rejected write, leave the repo in no allowlist AND no longer
    // staged - vanishing the row despite the operator's click. A failed grant keeps the
    // staged row, so the ungranted repo stays visible to try again.
    if (ok && plan.trustStaged !== null) {
      void updateUiConfig({ trustStaged: plan.trustStaged });
    }
  }

  function removeRow(row: TrustRow): void {
    if (row.foreman && foreman.config) {
      void foreman.update({ repoAllowlist: foremanRef.current.filter((p) => p !== row.repo) });
    }
    if (row.workflows && workflowConfigRef.current) {
      void workflows.update({
        ...workflowConfigRef.current,
        repoAllowlist: workflowsRef.current.filter((p) => p !== row.repo),
      });
    }
    if (row.inspector && inspector.config) {
      void inspector.update({ repoAllowlist: inspectorRef.current.filter((p) => p !== row.repo) });
    }
    if (row.merge && shipping.config) {
      void shipping.update({ repoAllowlist: shippingRef.current.filter((p) => p !== row.repo) });
    }
    if (stagedRef.current.includes(row.repo)) {
      void updateUiConfig({ trustStaged: stagedRef.current.filter((p) => p !== row.repo) });
    }
  }

  // The dagger's two fixes, applied in place - the operator is already on Trust, so there is
  // nowhere to navigate. Grant the review adds the trapped repos to the Inspector's list;
  // revoke the merge drops them from Shipping's. Either one resolves the blind spot.
  function grantReview(): void {
    if (!inspector.config) return;
    const add = blindRepos.filter((r) => !inspectorRef.current.includes(r));
    if (add.length === 0) return;
    void inspector.update({ repoAllowlist: [...inspectorRef.current, ...add] });
  }
  function revokeMerge(): void {
    if (!shipping.config) return;
    void shipping.update({
      repoAllowlist: shippingRef.current.filter((p) => !blindRepos.includes(p)),
    });
  }

  /**
   * Disarm check execution everywhere, from the footnote that named it.
   *
   * The ONE fix offered, deliberately, though the double dagger has two. Revoking the
   * workflow grants would also silence Live delivery in those repos - a strictly larger
   * change than the operator asked for, applied to every flagged repo at once - so that
   * half stays a sentence pointing at the cells, which are right there and already know how
   * to revoke one repo at a time.
   */
  function disarmChecks(): void {
    const config = workflowConfigRef.current;
    if (!config) return;
    void workflows.update({ ...config, checksEnabled: false });
  }

  /**
   * Add every picked repository, plus a typed path, in one batch - each with the default
   * grants (`DEFAULT_ADD_GRANTS`), and YOLO merges left for a deliberate cell click.
   *
   * One write per owning allowlist rather than one per repository: each config route takes
   * the whole list, so writing them repo by repo would race every write against the last.
   */
  async function add(): Promise<void> {
    const typed = pathDraft.trim();
    const chosen = candidates.filter((r) => picked.has(r));
    if ((chosen.length === 0 && !typed) || adding) return;
    setAdding(true);
    setAddError(null);
    // Resolve + canonicalize server-side - picked repos as well as the typed path - so every
    // grant is written against the realpath the daemon gates on.
    const asked = typed ? [...chosen, typed] : chosen;
    const resolved = await Promise.all(asked.map((path) => resolveRepo(path)));
    // Duplicate-checked against the whole matrix - the allowlists AND the staged list - so a
    // repo already in it is never added twice.
    const present = new Set(currentRepos());
    const errors: string[] = [];
    const roots: string[] = [];
    /** Which of `asked` were refused, so only those stay in the form to be corrected. */
    const refused = new Set<number>();
    resolved.forEach((res, i) => {
      if (!res.ok) {
        errors.push(`${asked[i]}: ${res.error}`);
        refused.add(i);
      } else if (present.has(res.repoRoot)) {
        errors.push(`${res.repoRoot} is already in the matrix.`);
        refused.add(i);
      } else if (!roots.includes(res.repoRoot)) {
        roots.push(res.repoRoot);
      }
    });

    if (roots.length > 0) {
      const patch = addRepositoriesPatch(roots, {
        foreman: foremanRef.current,
        workflows: workflowsRef.current,
        inspector: inspectorRef.current,
        shipping: shippingRef.current,
        staged: stagedRef.current,
      });
      const workflowConfig = workflowConfigRef.current;
      const written = await Promise.all([
        foreman.config ? foreman.update({ repoAllowlist: patch.foreman }) : false,
        workflowConfig
          ? workflows.update({ ...workflowConfig, repoAllowlist: patch.workflows })
          : false,
        inspector.config ? inspector.update({ repoAllowlist: patch.inspector }) : false,
      ]);
      const failed = ["Foreman", "Workflows", "GitHub Inspector"].filter((_, i) => !written[i]);
      if (failed.length === DEFAULT_ADD_GRANTS.length) {
        // Nothing landed, so the new repos sit in no allowlist. Stage them so the rows still
        // show, and their cells can be granted once the daemon answers again.
        await updateUiConfig({ trustStaged: [...stagedRef.current, ...roots] });
      }
      if (failed.length > 0) {
        errors.push(
          `Couldn't grant ${failed.join(", ")} for the new ${
            roots.length === 1 ? "repository" : "repositories"
          } - click a cell to try again.`,
        );
      }
      setRecent(new Set(roots));
    }

    // Keep only what was refused, so a failed pick or path can be corrected and retried. A
    // refused pick that is already in the matrix drops out of the list by itself.
    setPicked(new Set(chosen.filter((_, i) => refused.has(i))));
    if (!typed || !refused.has(asked.length - 1)) setPathDraft("");
    setAdding(false);
    setAddError(errors.length > 0 ? errors.join(" ") : null);
  }

  /** Every repository the matrix holds, in any allowlist or staged. */
  function currentRepos(): string[] {
    return [
      ...foremanRef.current,
      ...workflowsRef.current,
      ...inspectorRef.current,
      ...shippingRef.current,
      ...stagedRef.current,
    ];
  }

  /** Whether each column's owning daemon has answered, so a cell can disable rather than lie. */
  const configPresent: Record<GrantColumn, boolean> = {
    foreman: Boolean(foreman.config),
    workflows: Boolean(workflows.config),
    inspector: Boolean(inspector.config),
    merge: Boolean(shipping.config),
  };

  function cell(row: TrustRow, col: (typeof COLUMNS)[number]): React.JSX.Element {
    const on = row[col.key];
    const blind = yolo && row.merge && !row.inspector;
    // The merge cell that is trapped, and the empty inspector cell that would untrap it,
    // both go amber - the second is where the fix goes.
    const trapCell = (col.key === "merge" && blind) || (col.key === "inspector" && blind);
    const trappedPill = col.key === "merge" && blind;
    // Armed check execution. Only ever the workflows cell, and only when it is granted:
    // unlike the merge trap there is no second cell that would fix it, because the fix is
    // either this grant or a switch that lives on another page.
    const arms = col.key === "workflows" && on && checksArmed;
    // The marker the pill flies, or none. Kept as one expression so the two amber states
    // cannot both claim the same pill - they are on different columns, and this says so.
    const marker = trappedPill ? " †" : arms ? " ‡" : "";
    return (
      <div key={col.key} className={`trust-c${trapCell || arms ? " is-trap" : ""}`}>
        <Tooltip label={col.title}>
          <button
            type="button"
            className={`trust-grant ${on ? "is-on" : "is-off"}${
              trappedPill ? " is-trapped" : ""
            }${arms ? " is-armed" : ""}`}
            disabled={!configPresent[col.key]}
            aria-pressed={on}
            aria-label={`${on ? "Revoke" : "Grant"}: ${col.label} for ${row.repo}`}
            onClick={() => void grant(col.key, row.repo, on)}
          >
            <span className="trust-grant-dot" aria-hidden />
            {on ? `allowed${marker}` : "grant"}
          </button>
        </Tooltip>
      </div>
    );
  }

  const candidates = candidateRepos(repos ?? [], [
    ...foremanList,
    ...workflowsList,
    ...inspectorList,
    ...shippingList,
    ...staged,
  ]);
  // The add pane's list, narrowed by its own search. Picks survive a search that hides them,
  // so the count and the button read from every candidate rather than only the shown ones.
  const shownCandidates = filterRepos(candidates, pickQuery);
  const pickedCount = candidates.filter((r) => picked.has(r)).length;
  const addCount = pickedCount + (pathDraft.trim() ? 1 : 0);
  // The matrix pane's filter, by the same name-first rule as every repository picker.
  const keepRows = new Set(filterRepos(rows.map((r) => r.repo), trustedQuery));
  const shownRows = rows.filter((r) => keepRows.has(r.repo));

  function togglePick(repo: string): void {
    setAddError(null);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }

  return (
    <section className="settings-section trust-section">
      <p className="settings-hint">
        Every grant that lets Mission Control act outside this app, in one table. Each column
        is its subsystem's own allowlist - clicking a cell writes there, and the Foreman,
        Workflows, GitHub Inspector and Shipping panels keep working against the same lists.
        Worktrees of a trusted repo count too, wherever they live on disk.
      </p>

      {unknown.length > 0 && (
        <p className="settings-warn trust-unknown">
          Can't reach the daemon for {unknown.join(", ")}, so those grants are unknown, not
          off. The cells below are showing what was last cached, not current state.
        </p>
      )}

      <div className="trust-split">
        <div
          className="trust-pane trust-add"
          data-anchor="trust/add"
          ref={addTourRef}
          role="group"
          aria-labelledby="trust-add-title"
        >
          <div className="trust-pane-head">
            <div className="trust-pane-title-row">
              <h3 className="trust-pane-title" id="trust-add-title">
                Add repositories
              </h3>
              <span className="trust-pane-count">{candidates.length} available</span>
            </div>
            <input
              type="search"
              className="trust-search"
              placeholder="Search repositories…"
              aria-label="Search repositories to add"
              value={pickQuery}
              onChange={(e) => setPickQuery(e.target.value)}
            />
            <div className="trust-pick-actions">
              <button
                type="button"
                className="btn"
                disabled={shownCandidates.length === 0}
                onClick={() => setPicked((prev) => new Set([...prev, ...shownCandidates]))}
              >
                Select all shown
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pickedCount === 0}
                onClick={() => setPicked(new Set())}
              >
                Clear
              </button>
              <span className="trust-pane-count trust-picked-count">{pickedCount} selected</span>
            </div>
          </div>

          <ul className="trust-pick-list" aria-label="Repositories to add">
            {repoOptionLabels(shownCandidates).map(({ repo, name, hint }) => {
              const on = picked.has(repo);
              return (
                <li key={repo}>
                  <Tooltip label={repo}>
                    <label className={`trust-pick${on ? " is-picked" : ""}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={`Select ${repo}`}
                        onChange={() => togglePick(repo)}
                      />
                      <span className="trust-pick-name">{name}</span>
                      {hint && <span className="trust-pick-hint">{hint}</span>}
                    </label>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
          {shownCandidates.length === 0 && (
            <p className="settings-hint trust-pick-empty">
              {repos === null
                ? "Looking for repositories…"
                : repos.length === 0
                  ? "No repositories found in your workspace. Type a path below to add one."
                  : candidates.length === 0
                    ? "Every repository in your workspace is already trusted. Type a path below to add another."
                    : "No repositories match that search."}
            </p>
          )}

          <div className="trust-pane-foot">
            <input
              className="trust-path"
              placeholder="or type a path…"
              aria-label="Repository path"
              value={pathDraft}
              onChange={(e) => {
                setPathDraft(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
            />
            <p className="trust-defaults">
              <span>New repositories get</span>
              {COLUMNS.map((c) => {
                const on = (DEFAULT_ADD_GRANTS as readonly GrantColumn[]).includes(c.key);
                return (
                  <span
                    key={c.key}
                    className={`trust-grant trust-default ${on ? "is-on" : "is-off"}`}
                  >
                    <span className="trust-grant-dot" aria-hidden />
                    {on ? c.short : `${c.short} off`}
                  </span>
                );
              })}
            </p>
            <button
              type="button"
              className="btn btn-primary trust-add-btn"
              disabled={addCount === 0 || adding}
              onClick={() => void add()}
            >
              {adding
                ? "Adding…"
                : addCount === 0
                  ? "Add repositories"
                  : `Add ${addCount} ${addCount === 1 ? "repository" : "repositories"}`}
            </button>
            {addError && <p className="settings-error trust-add-error">{addError}</p>}
          </div>
        </div>

        <div className="trust-pane trust-matrix" data-anchor="trust/matrix" ref={matrixTourRef}>
          <div className="trust-pane-head trust-matrix-head">
            <h3 className="trust-pane-title">Trusted</h3>
            <span className="trust-pane-count">{rows.length}</span>
            <input
              type="search"
              className="trust-search"
              placeholder="Filter trusted…"
              aria-label="Filter trusted repositories"
              value={trustedQuery}
              onChange={(e) => setTrustedQuery(e.target.value)}
            />
          </div>
          <div className="trust-grid" role="table" aria-label="Repository trust grants">
            <div className="trust-h trust-h-repo">Repository</div>
            {COLUMNS.map((c) => (
              <Tooltip key={c.key} label={`${c.label}: ${c.title}`}>
                <div className="trust-h">{c.short}</div>
              </Tooltip>
            ))}
            <div className="trust-h" aria-hidden />
            {shownRows.map((row) => (
              <Fragment key={row.repo}>
                <div className="trust-c trust-repo">
                  <RepositoryName path={row.repo} className="trust-repo-path" />
                  {recent.has(row.repo) && <span className="trust-new-tag">new</span>}
                </div>
                {COLUMNS.map((c) => cell(row, c))}
                <div className="trust-c trust-remove-c">
                  <Tooltip label={`Remove ${row.repo} - revokes every grant it holds`}>
                    <button
                      type="button"
                      className="trust-remove"
                      aria-label={`Remove every grant for ${row.repo}`}
                      onClick={() => removeRow(row)}
                    >
                      ✕
                    </button>
                  </Tooltip>
                </div>
              </Fragment>
            ))}
          </div>
          {rows.length === 0 ? (
            <p className="settings-hint trust-empty">
              No repositories yet. Pick some on the left and add them.
            </p>
          ) : (
            shownRows.length === 0 && (
              <p className="settings-hint trust-empty">No trusted repositories match that filter.</p>
            )
          )}
        </div>
      </div>

      {blindSpots.length > 0 && (
        <p className="settings-warn trust-trap-note">
          † YOLO may merge in <WarningRepositoryList repos={blindRepos} />, but GitHub Inspector
          may not review there
          - so no pull request will ever qualify.{" "}
          <Tooltip label="Add these repos to GitHub Inspector's allowlist">
            <button type="button" className="settings-link" onClick={grantReview}>
              Grant the review
            </button>
          </Tooltip>
          , or{" "}
          <Tooltip label="Remove these repos from the merge allowlist">
            <button type="button" className="settings-link" onClick={revokeMerge}>
              revoke the merge
            </button>
          </Tooltip>
          .
        </p>
      )}

      {checkGrants.length > 0 && (
        <p className="settings-warn trust-arm-note">
          ‡ Workflow Commands are on, so a workflow may run <strong>branch-authored code</strong>{" "}
          in <WarningRepositoryList repos={checkRepos} /> with this daemon's filesystem
          authority. It is not a
          sandbox.{" "}
          <Tooltip label="Switch off workflow Commands everywhere">
            <button type="button" className="settings-link" onClick={disarmChecks}>
              Turn Commands off
            </button>
          </Tooltip>
          , or revoke a repo's Workflows cell in the matrix - which also stops Live delivery there.
        </p>
      )}

      {/* The same warning, for the window where the daemon has stopped answering.
          `checkGrants` is empty here whatever the arming says - the rows come from the
          Workflows allowlist, and an unreadable config contributes none - so the confirmed
          note above cannot cover this case, and letting it fall through to nothing is the
          exact self-retiring warning this reading exists to prevent. It names no repository
          because it genuinely does not know which; what it will not do is go quiet. */}
      {checks.armed && !checks.confirmed && (
        <p className="settings-warn trust-arm-note trust-arm-unconfirmed">
          ‡ Workflow Commands were <strong>on</strong> at the last reading, so a workflow may be
          able to run <strong>branch-authored code</strong> with this daemon's filesystem
          authority. Which repositories cannot be listed while Workflows is unreachable, and
          nothing here has been disarmed - only rendered unverifiable.
        </p>
      )}
    </section>
  );
}

/**
 * The grant-count summary the three grant-consuming panels show where their repo editor used
 * to be, plus the deep-link into Trust. Colocated here because "how many repos hold this grant,
 * and where do you change it" is the matrix's vocabulary, not each panel's.
 */
export function TrustGrantSummary({
  configured,
  count,
  subject,
  onNavigate,
}: {
  /** Whether the daemon has answered. False renders "unknown", never "0 repositories". */
  configured: boolean;
  count: number;
  /**
   * The clause the count is the object of, e.g. "Foreman may send live in". Phrased this
   * way so the count reads correctly at one ("...in 1 repository") as well as many, which a
   * verb-after-the-count phrasing ("1 repository grant...") cannot.
   */
  subject: string;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  return (
    <p className="settings-hint trust-summary">
      {!configured
        ? "Unknown - the daemon hasn't said which repos are trusted. "
        : count === 0
          ? `${subject} no repositories yet. `
          : `${subject} ${count} ${count === 1 ? "repository" : "repositories"}. `}
      Grants live in one place now -{" "}
      <Tooltip label="Open the Trust matrix to change these grants">
        <button
          type="button"
          className="settings-link"
          onClick={() => onNavigate("trust", "trust/matrix")}
        >
          Manage in Trust
        </button>
      </Tooltip>
      .
    </p>
  );
}
