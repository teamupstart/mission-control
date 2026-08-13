import { Fragment, useEffect, useRef, useState } from "react";
import type { ForemanState } from "../useForeman.ts";
import type { InspectorState } from "../useInspector.ts";
import type { ShippingState } from "../useShipping.ts";
import type { WorkflowSettingsState } from "../useWorkflowSettings.ts";
import { useUiConfig, updateUiConfig } from "../lib/uiConfig.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import {
  candidateRepos,
  checkExecutionGrants,
  grantPatch,
  mergeBlindSpots,
  trustRows,
  type ChecksArmedReading,
  type GrantColumn,
  type TrustRow,
} from "../lib/trust.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { repoLeaf } from "../lib/format.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { RepositoryName } from "./RepositoryName.tsx";
import { Tooltip } from "./Tooltip.tsx";

// Trust: one repository x grant matrix over the four existing allowlists.
//
// It stores NOTHING of its own about who may act where - each column is a subsystem's own
// `repoAllowlist`, and a cell click patches that subsystem's config through the exact route
// its panel used to. The daemon's four consent gates are untouched; this is a view that
// happens to be able to write to what it shows. The one piece of state it does own is the
// staged list (`UiConfig.trustStaged`): a repo added to the table but granted nothing lives
// in no allowlist, so without a home of its own it would vanish on the next reload - which
// would quietly break the plan's "adding is configuration; enabling is consent".
//
// Two combinations are flagged amber, and they are different kinds of thing. The merge
// blind spot is a CONTRADICTION - a repo YOLO may merge but the Inspector may not review
// can never qualify, so nothing happens and the reason is invisible - and both the trapped
// merge cell and the empty inspector cell that would fix it go amber, with a footnote
// offering the two fixes in place. Armed check execution is not broken at all; it is
// flagged because it is the heaviest grant here and the one whose weight the cell cannot
// show on its own. See `checkExecutionGrants`.

/** The four columns, left to right, each naming the grant by what it permits. */
const COLUMNS = [
  {
    key: "foreman",
    label: "Foreman sends live",
    title: "Foreman answers prompts in this repo's sessions without asking you.",
  },
  {
    // Second, not last: the columns run local-blast-radius first (Foreman, Workflows) and
    // GitHub second (Inspector, YOLO), so the two halves of the "Acts on GitHub" badge the
    // rail draws over this category are contiguous rather than interleaved.
    key: "workflows",
    label: "Workflows act",
    // ONE cell, both capabilities, because it is one stored list - said in full here since
    // this tooltip is the only place the second one is visible from the matrix. Each still
    // needs its own switch on the Workflows panel, which is why this reads "may".
    title:
      "Workflows may act in this repo: Live repairs typed into its sessions, and workflow "
      + "Commands run against branch code with the daemon's filesystem authority. Each is "
      + "still armed separately in Workflows settings.",
  },
  {
    key: "inspector",
    label: "Inspector posts reviews",
    title: "Publishes review comments on this repo's PRs under your GitHub account.",
  },
  {
    key: "merge",
    label: "YOLO merges",
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
  const ui = useUiConfig();
  const [repos, setRepos] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
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
    !inspector.config && "the Inspector",
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

  async function add(): Promise<void> {
    const path = draft.trim();
    if (!path || adding) return;
    setAdding(true);
    setAddError(null);
    // Resolve + canonicalize server-side so the staged path is the realpath the daemon
    // gates on, exactly as the three panels did before a cell can grant against it.
    const res = await resolveRepo(path);
    setAdding(false);
    if (!res.ok) {
      setAddError(res.error);
      return;
    }
    const root = res.repoRoot;
    // Duplicate-checked against the whole matrix - the allowlists AND the staged list - so a
    // repo already granted somewhere, or already staged, is refused rather than staged twice.
    const present = new Set([
      ...foremanRef.current,
      ...workflowsRef.current,
      ...inspectorRef.current,
      ...shippingRef.current,
      ...stagedRef.current,
    ]);
    if (present.has(root)) {
      setAddError(`${root} is already in the matrix`);
      return;
    }
    setDraft("");
    // Grants NOTHING: it only stages the row. Enabling is a separate, deliberate cell click.
    await updateUiConfig({ trustStaged: [...stagedRef.current, root] });
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

  const candidates = candidateRepos(repos, [
    ...foremanList,
    ...workflowsList,
    ...inspectorList,
    ...shippingList,
    ...staged,
  ]);

  return (
    <section className="settings-section">
      <p className="settings-hint">
        Every grant that lets Mission Control act outside this app, in one table. Each column
        is its subsystem's own allowlist - clicking a cell writes there, and the Foreman,
        Workflows, Inspector and Shipping panels keep working against the same lists.
        Worktrees of a trusted repo count too, wherever they live on disk.
      </p>

      {unknown.length > 0 && (
        <p className="settings-warn trust-unknown">
          Can't reach the daemon for {unknown.join(", ")}, so those grants are unknown, not
          off. The cells below are showing what was last cached, not current state.
        </p>
      )}

      <div className="trust-matrix" data-anchor="trust/matrix">
        <div className="trust-grid" role="table" aria-label="Repository trust grants">
          <div className="trust-h trust-h-repo">Repository</div>
          {COLUMNS.map((c) => (
            <div className="trust-h" key={c.key}>
              {c.label}
            </div>
          ))}
          <div className="trust-h" aria-hidden />
          {rows.map((row) => (
            <Fragment key={row.repo}>
              <div className="trust-c trust-repo">
                <RepositoryName path={row.repo} className="trust-repo-path" />
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
        {rows.length === 0 && (
          <p className="settings-hint trust-empty">
            No repositories yet. Add one below, then grant it what it needs.
          </p>
        )}
      </div>

      {blindSpots.length > 0 && (
        <p className="settings-warn trust-trap-note">
          † YOLO may merge in <WarningRepositoryList repos={blindRepos} />, but the Inspector
          may not review there
          - so no pull request will ever qualify.{" "}
          <Tooltip label="Add these repos to the Inspector's allowlist">
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
          , or revoke a repo's Workflows cell above - which also stops Live delivery there.
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

      <div className="trust-add" data-anchor="trust/add">
        <RepoCombobox
          repos={candidates}
          value={draft}
          onChange={(v) => {
            setDraft(v);
            setAddError(null);
          }}
        />
        <Tooltip label="Add this repo to the matrix - it grants nothing until you click a cell">
          <button className="btn" disabled={!draft.trim() || adding} onClick={() => void add()}>
            {adding ? "Adding…" : "Add"}
          </button>
        </Tooltip>
      </div>
      <p className="settings-hint trust-add-note">
        Adding a repo grants nothing yet - cells start empty, one deliberate click each.
        Adding is configuration; enabling is consent.
      </p>
      {addError && <p className="settings-error">{addError}</p>}
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
