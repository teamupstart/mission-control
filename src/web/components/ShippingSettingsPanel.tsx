import { useEffect, useRef, useState } from "react";
import type { InspectorInspection } from "@shared/types.ts";
import { MERGE_BLOCK_LABEL } from "@shared/shipping.ts";
import type { MergeBlock } from "@shared/shipping.ts";
import { repoAllowlisted } from "@shared/allowlist.ts";
import type { InspectorConfig } from "@shared/protocol.ts";
import type { ShippingState } from "../useShipping.ts";
import { fetchRepos, resolveRepo } from "../lib/api.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import { candidateRepos } from "./ForemanSettingsPanel.tsx";
import { NumberSetting } from "./ForemanBar.tsx";
import { ago } from "./InspectorSettingsPanel.tsx";

// The Shipping category: YOLO mode, and the soak window that is its safety valve.
//
// Like the Inspector panel next door, the copy here is part of the feature rather than
// decoration around it - this is the only switch in the app that writes to a DEFAULT
// BRANCH. Unlike the Inspector's, it also has to say what YOLO mode will NOT do, because
// every one of those gates is a reason an operator otherwise concludes it is broken.

const METHOD_LABEL: Record<"squash" | "merge" | "rebase", string> = {
  squash: "Squash and merge",
  merge: "Merge commit",
  rebase: "Rebase and merge",
};

/**
 * Where one adopted PR stands with YOLO mode, in one phrase.
 *
 * A stored `mergeBlock` that is not a known code is the message `gh` gave when it refused
 * the merge - branch protection, a required check we cannot see - so it is shown verbatim
 * rather than dropped. That message is the only account the operator gets of a rule this
 * app cannot read.
 */
export function mergeStatus(row: InspectorInspection): string {
  if (row.mergedAt !== null) return "merged";
  if (row.state === "closed") return "closed";
  if (!row.mergeBlock) return "not looked at yet";
  return MERGE_BLOCK_LABEL[row.mergeBlock as MergeBlock] ?? row.mergeBlock;
}

/**
 * When this row last did anything: merged, or reviewed. Blank rather than "not yet
 * reviewed" for a PR neither has happened to - the state column beside it already says
 * so, and a row that repeats itself is a row nobody reads twice.
 */
function when(row: InspectorInspection, now: number): string {
  const at = row.mergedAt ?? row.lastReviewedAt;
  return at === null ? "" : ago(at, now);
}

export function ShippingSettingsPanel({
  state,
  inspectorConfig,
}: {
  state: ShippingState;
  /**
   * The Inspector's consent settings, from the config the Inspector panel edits. Null
   * when the daemon is unreachable, which is "unknown", not "off".
   *
   * Passed in rather than polled again here because it is not this panel's setting - but
   * it IS this panel's biggest gotcha, and in three flavours rather than one. YOLO mode
   * merges what the Inspector reviewed AND PUBLISHED, so each of the Inspector's three
   * switches can independently leave this feature doing nothing: off reviews nothing,
   * and dry-run or a missing repo reviews without publishing, which `mergeVerdict`
   * refuses to act on. Without saying so, all three read as a feature that is broken.
   */
  inspectorConfig: Pick<InspectorConfig, "enabled" | "mode" | "repoAllowlist"> | null;
}): React.JSX.Element {
  const { config, inspections, update, error } = state;
  const [repos, setRepos] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    void fetchRepos().then(setRepos);
  }, []);

  const autoMerge = config?.autoMerge ?? false;
  const soakMinutes = config?.soakMinutes ?? 10;
  const method = config?.method ?? "squash";
  const allowlist = config?.repoAllowlist ?? [];
  // Same stale-closure guard as the Foreman and Inspector panels: `add` does a server
  // round-trip while the config polls underneath it, so the write must extend whatever is
  // in force when it lands rather than what was on screen when the button was clicked.
  const allowlistRef = useRef(allowlist);
  allowlistRef.current = allowlist;
  const candidates = candidateRepos(repos, allowlist);
  const now = Date.now();
  // Repos this panel would merge in that the Inspector may not review. Computed with the
  // same predicate the daemon gates on, so the warning cannot claim a repo is covered
  // when `inspectorPosture` will call it `not-allowlisted` an hour later. Only meaningful
  // once the Inspector is on and live - before that the warnings above are the answer.
  const untrustedByInspector =
    inspectorConfig?.enabled === true && inspectorConfig.mode === "live"
      ? allowlist.filter((p) => !repoAllowlisted(p, null, inspectorConfig.repoAllowlist))
      : [];

  async function add(): Promise<void> {
    const path = draft.trim();
    if (!path || adding || !config) return;
    setAdding(true);
    setAddError(null);
    const res = await resolveRepo(path);
    setAdding(false);
    if (!res.ok) {
      setAddError(res.error);
      return;
    }
    const current = allowlistRef.current;
    if (current.includes(res.repoRoot)) {
      setAddError(`${res.repoRoot} is already trusted`);
      return;
    }
    setDraft("");
    await update({ repoAllowlist: [...current, res.repoRoot] });
  }

  function remove(path: string): void {
    void update({ repoAllowlist: allowlist.filter((p) => p !== path) });
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Shipping</h3>
      </div>

      <p className="settings-hint">
        What lands without you. <strong>YOLO mode</strong> merges the pull requests Mission
        Control opened once the Inspector has reviewed the current push with nothing
        outstanding, CI is green, nobody has an unresolved thread on it, and it has been
        open for the soak window below.
      </p>

      {/* Same rule as the Inspector panel: the fallbacks below are the OFF posture, and
          presenting schema defaults as the daemon's answer tells the operator nothing is
          merging while the stored config may well be armed. */}
      {!config && (
        <p className="settings-warn ship-unknown">
          Can't reach the daemon, so whether YOLO mode is armed is unknown. The controls
          below are showing defaults, not its current state.
        </p>
      )}

      <label className="alert-row ship-toggle">
        <input
          type="checkbox"
          checked={autoMerge}
          disabled={!config}
          onChange={(e) => void update({ autoMerge: e.target.checked })}
        />
        <span>YOLO mode - merge our pull requests when they come out clean</span>
      </label>

      {/* Shown whenever it is armed, not only on the click that arms it: the risk is
          ongoing rather than momentary, and a merge is the one action here that no
          setting can take back. */}
      {autoMerge && (
        <p className="settings-warn ship-live-warn">
          Merges are performed on GitHub under your account and land on the base branch.
          Nothing in Mission Control can undo one.
        </p>
      )}

      {/* The gotchas that would otherwise read as a broken feature. Each names the switch
          to flip, and they are mutually exclusive in the order `inspectorPosture` checks
          them - telling someone whose Inspector is off that their repo is untrusted too
          is three problems presented where they can only act on the first. */}
      {autoMerge && inspectorConfig?.enabled === false && (
        <p className="settings-warn ship-needs-inspector">
          The Inspector is switched off, so no pull request is being reviewed and none will
          qualify. Turn it on in Settings → Inspector.
        </p>
      )}

      {autoMerge && inspectorConfig?.enabled === true && inspectorConfig.mode !== "live" && (
        <p className="settings-warn ship-needs-inspector">
          The Inspector is in dry run, so it reviews but publishes nothing - and YOLO mode
          will not merge on a review nobody can see. Set it to live in Settings → Inspector.
        </p>
      )}

      {/* The two allowlists are separate on purpose (see below), so this is the one state
          where both features are fully on and a specific repo still never merges. */}
      {autoMerge && untrustedByInspector.length > 0 && (
        <p className="settings-warn ship-needs-inspector">
          The Inspector is not allowed to review {untrustedByInspector.join(", ")}, so
          nothing there will merge. Add it in Settings → Inspector.
        </p>
      )}

      <div className="ship-soak">
        <p className="settings-group-label">Soak time</p>
        {/* Commits on blur, never per keystroke - see `NumberSetting`. It matters more
            here than where it came from: clearing the field to retype reads as `0`, which
            this schema ACCEPTS as "no soak at all", so a per-keystroke commit would
            silently disarm the safety valve rather than be refused. */}
        <NumberSetting
          value={soakMinutes}
          min={0}
          max={1440}
          label="minutes open before it may merge"
          disabled={!config}
          onCommit={(n) => void update({ soakMinutes: n })}
        />
        <p className="settings-hint">
          The window in which somebody can look at what an agent proposed and say no. Zero
          means merge as soon as everything else passes.
        </p>
      </div>

      <fieldset className="ship-methods">
        <legend>How to merge</legend>
        {(["squash", "merge", "rebase"] as const).map((m) => (
          <label className="alert-row" key={m}>
            <input
              type="radio"
              name="shipping-method"
              checked={method === m}
              disabled={!config}
              onChange={() => void update({ method: m })}
            />
            <span>{METHOD_LABEL[m]}</span>
          </label>
        ))}
      </fieldset>

      <div className="foreman-repos">
        <p className="settings-group-label">Repositories that may merge themselves</p>
        <p className="settings-hint foreman-repos-hint">
          Its own list, not the Inspector's - letting it comment on a repo is not the same
          permission as letting it merge there. Worktrees of a trusted repo count too.
        </p>

        {allowlist.length === 0 ? (
          <p className="settings-hint foreman-repos-empty">
            {config
              ? "No repos yet - nothing will merge itself anywhere."
              : "Unknown - the daemon hasn't said which repos are trusted."}
          </p>
        ) : (
          <ul className="foreman-repo-list">
            {allowlist.map((path) => (
              <li className="foreman-repo-row" key={path}>
                <span className="foreman-repo-path" title={path}>
                  {path}
                </span>
                <button
                  className="foreman-repo-remove"
                  onClick={() => remove(path)}
                  title="Stop auto-merging in this repo"
                  aria-label={`Stop auto-merging in ${path}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="foreman-repo-add">
          <RepoCombobox
            repos={candidates}
            value={draft}
            onChange={(v) => {
              setDraft(v);
              setAddError(null);
            }}
          />
          <button
            className="btn"
            disabled={!config || !draft.trim() || adding}
            onClick={() => void add()}
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
        {addError && <p className="settings-error">{addError}</p>}
      </div>

      {/* An auto-merger's failure mode is not merging the wrong thing - it is merging
          nothing and never saying why. This is where that is said, per pull request. */}
      <div className="ship-log">
        <p className="settings-group-label">Where each pull request stands</p>
        {inspections.length === 0 ? (
          <p className="settings-hint">
            Nothing yet. A pull request appears here once Mission Control opens one.
          </p>
        ) : (
          <ul className="ship-log-list">
            {inspections.map((row) => (
              <li className="ship-log-row" key={row.key}>
                <a className="ship-log-pr" href={row.url} target="_blank" rel="noreferrer">
                  {row.repo}#{row.number}
                </a>
                <span
                  className={`ship-log-state${row.mergedAt !== null ? " ship-log-merged" : ""}`}
                >
                  {mergeStatus(row)}
                </span>
                <span className="ship-log-when">{when(row, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
