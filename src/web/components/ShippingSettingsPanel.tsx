import type { InspectorInspection } from "@shared/types.ts";
import { MERGE_BLOCK_LABEL } from "@shared/shipping.ts";
import type { MergeBlock } from "@shared/shipping.ts";
import { repoAllowlisted } from "@shared/allowlist.ts";
import type { InspectorConfig } from "@shared/protocol.ts";
import type { ShippingState } from "../useShipping.ts";
import { Tooltip } from "./Tooltip.tsx";
import { TrustGrantSummary } from "./TrustPanel.tsx";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
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
  onNavigate,
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
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const { config, inspections, update, error } = state;
  const autoMerge = config?.autoMerge ?? false;
  const soakMinutes = config?.soakMinutes ?? 10;
  const method = config?.method ?? "squash";
  const allowlist = config?.repoAllowlist ?? [];
  const closeAfterMerge = config?.closeSessionAfterMerge ?? false;
  const now = Date.now();
  // Repos this panel would merge in that the Inspector may not review. Computed with the
  // same predicate the daemon gates on, so the warning cannot claim a repo is covered
  // when `inspectorPosture` will call it `not-allowlisted` an hour later. Only meaningful
  // once the Inspector is on and live - before that the warnings above are the answer.
  const untrustedByInspector =
    inspectorConfig?.enabled === true && inspectorConfig.mode === "live"
      ? allowlist.filter((p) => !repoAllowlisted(p, null, inspectorConfig.repoAllowlist))
      : [];

  return (
    <section className="settings-section">
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

      <Tooltip label="Merge our pull requests automatically once CI is green and review is clean">
        <label className="alert-row ship-toggle" data-anchor="shipping/yolo">
          <input
            type="checkbox"
            checked={autoMerge}
            disabled={!config}
            onChange={(e) => void update({ autoMerge: e.target.checked })}
          />
          <span>YOLO mode - merge our pull requests when they come out clean</span>
        </label>
      </Tooltip>

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
          qualify.{" "}
          <Tooltip label="Open the Inspector panel and flash its master switch">
            <button
              type="button"
              className="settings-link"
              onClick={() => onNavigate("inspector", "inspector/enabled")}
            >
              Turn it on in Inspector →
            </button>
          </Tooltip>
        </p>
      )}

      {autoMerge && inspectorConfig?.enabled === true && inspectorConfig.mode !== "live" && (
        <p className="settings-warn ship-needs-inspector">
          The Inspector is in dry run, so it reviews but publishes nothing - and YOLO mode
          will not merge on a review nobody can see.{" "}
          <Tooltip label="Open the Inspector panel and flash its mode control">
            <button
              type="button"
              className="settings-link"
              onClick={() => onNavigate("inspector", "inspector/mode")}
            >
              Set it to live in Inspector →
            </button>
          </Tooltip>
        </p>
      )}

      {/* The two allowlists are separate on purpose (see below), so this is the one state
          where both features are fully on and a specific repo still never merges. It is
          fixed on the Trust matrix - grant the review, or revoke the merge - so the link
          lands there rather than on the Inspector's (now editor-less) panel. */}
      {autoMerge && untrustedByInspector.length > 0 && (
        <p className="settings-warn ship-needs-inspector">
          The Inspector is not allowed to review {untrustedByInspector.join(", ")}, so
          nothing there will merge.{" "}
          <Tooltip label="Open the Trust matrix - grant the review, or revoke the merge">
            <button
              type="button"
              className="settings-link"
              onClick={() => onNavigate("trust", "trust/matrix")}
            >
              Fix in Trust →
            </button>
          </Tooltip>
        </p>
      )}

      <div className="ship-soak" data-anchor="shipping/soak">
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

      <fieldset className="ship-methods" data-anchor="shipping/method">
        <legend>How to merge</legend>
        {(["squash", "merge", "rebase"] as const).map((m) => (
          <Tooltip label={METHOD_LABEL[m]} key={m}>
            <label className="alert-row">
              <input
                type="radio"
                name="shipping-method"
                checked={method === m}
                disabled={!config}
                onChange={() => void update({ method: m })}
              />
              <span>{METHOD_LABEL[m]}</span>
            </label>
          </Tooltip>
        ))}
      </fieldset>

      {/* Deliberately NOT nested inside the `autoMerge` conditional above, unlike the
          warnings. This fires on ANY merge of a task's pull request, including one the
          operator performed on GitHub themselves, so hiding it behind YOLO mode would
          make a live setting invisible to everyone who merges by hand. */}
      <div className="ship-after-merge">
        <p className="settings-group-label">When a task's pull request merges</p>
        <p className="settings-hint">
          Its task is marked done either way - that is what lets the backlog autopilot use
          the agent again, and it is not optional. This decides whether the agent stays.
        </p>
        <Tooltip label="Kill the agent once its work lands, and free its checkout when nothing would be lost">
          <label className="alert-row ship-toggle">
            <input
              type="checkbox"
              checked={closeAfterMerge}
              disabled={!config}
              onChange={(e) => void update({ closeSessionAfterMerge: e.target.checked })}
            />
            <span>Close the session after merge - frees a slot for a new backlog task</span>
          </label>
        </Tooltip>
        <p className="settings-hint">
          {closeAfterMerge
            ? "A finished agent otherwise counts against the fleet ceiling for as long as it lives. Its checkout is reclaimed only when it holds no uncommitted or untracked files; otherwise it is kept for Clean up."
            : "The agent stays, keeping its checkout and its context, and the autopilot may hand it the next task in place - no worktree to provision, but it carries the last task's context into the next one."}
        </p>
      </div>

      <div className="foreman-repos" data-anchor="shipping/merge-repos">
        <p className="settings-group-label">Repositories that may merge themselves</p>
        {/* The consent copy stays with the count: its own list, not the Inspector's -
            letting it comment on a repo is not the same permission as letting it merge
            there. That distinction is the whole point of a separate column in Trust. */}
        <p className="settings-hint foreman-repos-hint">
          Its own list, not the Inspector's - letting it comment on a repo is not the same
          permission as letting it merge there. Worktrees of a trusted repo count too.
        </p>
        <TrustGrantSummary
          configured={Boolean(config)}
          count={allowlist.length}
          subject="YOLO may merge in"
          onNavigate={onNavigate}
        />
      </div>

      {/* An auto-merger's failure mode is not merging the wrong thing - it is merging
          nothing and never saying why. This is where that is said, per pull request. */}
      <div className="ship-log" data-anchor="shipping/pr-status">
        <p className="settings-group-label">Where each pull request stands</p>
        {inspections.length === 0 ? (
          <p className="settings-hint">
            Nothing yet. A pull request appears here once Mission Control opens one.
          </p>
        ) : (
          <ul className="ship-log-list">
            {inspections.map((row) => (
              <li className="ship-log-row" key={row.key}>
                <Tooltip label={`Open ${row.repo}#${row.number} on GitHub`}>
                  <a className="ship-log-pr" href={row.url} target="_blank" rel="noreferrer">
                    {row.repo}#{row.number}
                  </a>
                </Tooltip>
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
