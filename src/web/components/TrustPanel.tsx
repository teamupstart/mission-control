import { Fragment, useEffect, useRef, useState } from "react";
import type { ForemanState } from "../useForeman.ts";
import type { InspectorState } from "../useInspector.ts";
import type { ShippingState } from "../useShipping.ts";
import { useUiConfig, updateUiConfig } from "../lib/uiConfig.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import {
  candidateRepos,
  grantPatch,
  mergeBlindSpots,
  trustRows,
  type GrantColumn,
  type TrustRow,
} from "../lib/trust.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { Tooltip } from "./Tooltip.tsx";

// Trust: one repository x grant matrix over the three existing allowlists.
//
// It stores NOTHING of its own about who may act where - each column is a subsystem's own
// `repoAllowlist`, and a cell click patches that subsystem's config through the exact route
// its panel used to. The daemon's three consent gates are untouched; this is a view that
// happens to be able to write to what it shows. The one piece of state it does own is the
// staged list (`UiConfig.trustStaged`): a repo added to the table but granted nothing lives
// in no allowlist, so without a home of its own it would vanish on the next reload - which
// would quietly break the plan's "adding is configuration; enabling is consent".
//
// The blind spot the three separate panels could only warn about in prose renders here
// structurally: a repo that YOLO may merge but the Inspector may not review can never
// qualify, and both the trapped merge cell and the empty inspector cell that would fix it
// go amber, with a footnote offering the two fixes in place.

/** The three columns, left to right, each naming the grant by what it permits. */
const COLUMNS = [
  {
    key: "foreman",
    label: "Foreman sends live",
    title: "Foreman answers prompts in this repo's sessions without asking you.",
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

export function TrustPanel({
  foreman,
  inspector,
  shipping,
}: {
  /**
   * The three subsystem states, OWNED ELSEWHERE and passed in: Foreman by App (the topbar
   * shares it), the Inspector and Shipping by `SettingsPage`. Trust must not instantiate a
   * second `useForeman`/`useInspector`/`useShipping` - that would double-poll the same
   * routes App and the page already poll, and let a cell and a panel disagree about a list.
   */
  foreman: ForemanState;
  inspector: InspectorState;
  shipping: ShippingState;
}): React.JSX.Element {
  const ui = useUiConfig();
  const [repos, setRepos] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // The workspace's git repos, for the add picker - same source the three panels used.
  useEffect(() => {
    void fetchRepos().then(setRepos);
  }, []);

  const foremanList = foreman.config?.repoAllowlist ?? [];
  const inspectorList = inspector.config?.repoAllowlist ?? [];
  const shippingList = shipping.config?.repoAllowlist ?? [];
  const staged = ui.trustStaged;
  const yolo = shipping.config?.autoMerge ?? false;

  // The stale-closure guard the three panels use, four times over: every write does a
  // server round-trip while the configs poll every 4s underneath it, so a cell click must
  // extend whatever is in force when it lands, not what was on screen when it was clicked.
  const foremanRef = useRef(foremanList);
  foremanRef.current = foremanList;
  const inspectorRef = useRef(inspectorList);
  inspectorRef.current = inspectorList;
  const shippingRef = useRef(shippingList);
  shippingRef.current = shippingList;
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  const rows = trustRows(foremanList, inspectorList, shippingList, staged);
  const blindSpots = mergeBlindSpots(rows, yolo);
  const blindRepos = blindSpots.map((r) => r.repo);

  // "Unknown, not off" (D7): a null config is an unreachable daemon, which is not evidence
  // the grant is absent. Name which subsystems we cannot read rather than drawing their
  // columns as if empty were fact.
  const unknown = [
    !foreman.config && "Foreman",
    !inspector.config && "the Inspector",
    !shipping.config && "Shipping",
  ].filter((x): x is string => Boolean(x));

  function grant(key: GrantColumn, repo: string, on: boolean): void {
    // The decision - owning subsystem, full new list, staged prune - is a pure function so
    // it can be tested without a click; the refs feed it whatever is in force right now.
    const plan = grantPatch(key, repo, on, {
      foreman: foremanRef.current,
      inspector: inspectorRef.current,
      shipping: shippingRef.current,
      staged: stagedRef.current,
    });
    if (plan.subsystem === "foreman") {
      if (!foreman.config) return;
      void foreman.update({ repoAllowlist: plan.repoAllowlist });
    } else if (plan.subsystem === "inspector") {
      if (!inspector.config) return;
      void inspector.update({ repoAllowlist: plan.repoAllowlist });
    } else {
      if (!shipping.config) return;
      void shipping.update({ repoAllowlist: plan.repoAllowlist });
    }
    // A first grant retires the staged entry: the repo now lives in a real allowlist.
    if (plan.trustStaged !== null) {
      void updateUiConfig({ trustStaged: plan.trustStaged });
    }
  }

  function removeRow(row: TrustRow): void {
    if (row.foreman && foreman.config) {
      void foreman.update({ repoAllowlist: foremanRef.current.filter((p) => p !== row.repo) });
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

  function cell(row: TrustRow, col: (typeof COLUMNS)[number]): React.JSX.Element {
    const on = row[col.key];
    const blind = yolo && row.merge && !row.inspector;
    // The merge cell that is trapped, and the empty inspector cell that would untrap it,
    // both go amber - the second is where the fix goes.
    const trapCell = (col.key === "merge" && blind) || (col.key === "inspector" && blind);
    const trappedPill = col.key === "merge" && blind;
    const configFor =
      col.key === "foreman"
        ? foreman.config
        : col.key === "inspector"
          ? inspector.config
          : shipping.config;
    return (
      <div key={col.key} className={`trust-c${trapCell ? " is-trap" : ""}`}>
        <Tooltip label={col.title}>
          <button
            type="button"
            className={`trust-grant ${on ? "is-on" : "is-off"}${trappedPill ? " is-trapped" : ""}`}
            disabled={!configFor}
            aria-pressed={on}
            aria-label={`${on ? "Revoke" : "Grant"}: ${col.label} for ${row.repo}`}
            onClick={() => grant(col.key, row.repo, on)}
          >
            <span className="trust-grant-dot" aria-hidden />
            {on ? (trappedPill ? "allowed †" : "allowed") : "grant"}
          </button>
        </Tooltip>
      </div>
    );
  }

  const candidates = candidateRepos(repos, [
    ...foremanList,
    ...inspectorList,
    ...shippingList,
    ...staged,
  ]);

  return (
    <section className="settings-section">
      <p className="settings-hint">
        Every grant that lets Mission Control act outside this app, in one table. Each column
        is its subsystem's own allowlist - clicking a cell writes there, and the Foreman,
        Inspector and Shipping panels keep working against the same lists. Worktrees of a
        trusted repo count too, wherever they live on disk.
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
                <Tooltip label={row.repo}>
                  <span className="trust-repo-path">{row.repo}</span>
                </Tooltip>
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
          † YOLO may merge in {blindRepos.join(", ")}, but the Inspector may not review there
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
 * The grant-count summary the three outbound panels show where their repo editor used to be,
 * plus the deep-link into Trust. Colocated here because "how many repos hold this grant, and
 * where do you change it" is the matrix's vocabulary, not each panel's.
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
