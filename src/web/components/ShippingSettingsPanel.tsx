import { useState } from "react";
import type { InspectorInspection } from "@shared/types.ts";
import { repoAllowlisted } from "@shared/allowlist.ts";
// The standing folds moved to `lib/pr-standing.ts` when the Ship log became their second
// reader, and are NOT re-exported from here: this panel is one consumer of them now, and a
// second import path would be the beginning of a second answer to "did this land".
import { mergeBucket, mergeStatus, mergeTallies, type MergeBucket } from "../lib/pr-standing.ts";
import type { InspectorConfig } from "@shared/protocol.ts";
import type { ShippingState } from "../useShipping.ts";
import { Tooltip } from "./Tooltip.tsx";
import { TrustGrantSummary } from "./TrustPanel.tsx";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { NumberSetting } from "./ForemanBar.tsx";
import { ago } from "./InspectorSettingsPanel.tsx";
import {
  ConsoleCard,
  ConsoleState,
  ConsoleStrip,
  ConsoleSwitch,
  PrLink,
  type ConsoleStat,
} from "./settings-console.tsx";

// The Shipping category: YOLO mode, and the soak window that is its safety valve.
//
// Like the Inspector panel next door, the copy here is part of the feature rather than
// decoration around it - this is the only switch in the app that writes to a DEFAULT
// BRANCH. Unlike the Inspector's, it also has to say what YOLO mode will NOT do, because
// every one of those gates is a reason an operator otherwise concludes it is broken.
//
// It shares the Inspector's console shape (`settings-console.tsx`) because it is the same
// panel about the other half of the same pipeline. The ledger earns the wide column here
// for a sharper reason than next door: an auto-merger's failure mode is not merging the
// wrong thing, it is merging NOTHING and never saying why, and the per-pull-request
// reason column is the entire answer to that.

const METHOD_LABEL: Record<"squash" | "merge" | "rebase", string> = {
  squash: "Squash and merge",
  merge: "Merge commit",
  rebase: "Rebase and merge",
};

/** The same three methods as one word, for the segmented control. */
const METHOD_SHORT: Record<"squash" | "merge" | "rebase", string> = {
  squash: "Squash",
  merge: "Commit",
  rebase: "Rebase",
};

/**
 * When this row last did anything: merged, or reviewed. Blank rather than "not yet
 * reviewed" for a PR neither has happened to - the state column beside it already says
 * so, and a row that repeats itself is a row nobody reads twice.
 */
function when(row: InspectorInspection, now: number): string {
  const at = row.mergedAt ?? row.lastReviewedAt;
  return at === null ? "" : ago(at, now);
}

const STRIP: readonly { id: MergeBucket; label: string; tone: ConsoleStat["tone"]; hint: string }[] = [
  {
    id: "soaking",
    label: "soaking",
    tone: "attention",
    hint: "Show only pull requests that pass every gate and are waiting out the soak window",
  },
  {
    id: "blocked",
    label: "held at a gate",
    tone: "danger",
    hint: "Show only pull requests something is stopping - each row says which gate",
  },
  {
    id: "waiting",
    label: "not looked at",
    tone: "plain",
    hint: "Show only pull requests no merge sweep has reached yet",
  },
  { id: "merged", label: "merged", tone: "merged", hint: "Show only pull requests YOLO mode landed" },
  {
    id: "closed",
    label: "closed",
    tone: "plain",
    hint: "Show only pull requests that closed without merging",
  },
];

/** The buckets the strip has a tile for - see `INSPECTION_STRIP_BUCKETS` next door. */
export const MERGE_STRIP_BUCKETS: readonly MergeBucket[] = STRIP.map((s) => s.id);

/** What an emptied filter says, per bucket - see `EMPTY_FILTER` next door for why these
 *  are written out rather than composed from the bucket id. */
const EMPTY_FILTER: Record<MergeBucket, string> = {
  soaking: "Nothing is soaking - no pull request has passed every other gate.",
  blocked: "Nothing is held at a gate.",
  waiting: "Every adopted pull request has been looked at.",
  merged: "YOLO mode has not merged anything yet.",
  closed: "No adopted pull request has closed without merging.",
};

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
  const [filter, setFilter] = useState<string | null>(null);
  const tallies = mergeTallies(inspections);
  const active = STRIP.find((s) => s.id === filter) ?? null;
  const rows = active === null ? inspections : inspections.filter((r) => mergeBucket(r) === active.id);
  // Repos this panel would merge in that the Inspector may not review. Computed with the
  // same predicate the daemon gates on, so the warning cannot claim a repo is covered
  // when `inspectorPosture` will call it `not-allowlisted` an hour later. Only meaningful
  // once the Inspector is on and live - before that the warnings above are the answer.
  const untrustedByInspector =
    inspectorConfig?.enabled === true && inspectorConfig.mode === "live"
      ? allowlist.filter((p) => !repoAllowlisted(p, null, inspectorConfig.repoAllowlist))
      : [];
  // Whether anything the operator can act on is standing between "armed" and "merging".
  // Only asked while armed: a settings page that warns about a feature nobody switched on
  // trains people to ignore warnings.
  const inspectorOff = autoMerge && inspectorConfig?.enabled === false;
  const inspectorQuiet =
    autoMerge && inspectorConfig?.enabled === true && inspectorConfig.mode !== "live";
  const someRepoUnreviewed = autoMerge && untrustedByInspector.length > 0;
  const anyBlocker = inspectorOff || inspectorQuiet || someRepoUnreviewed;

  return (
    <section className="settings-section sc-section">
      <p className="settings-hint sc-lede">
        What lands without you. <strong>YOLO mode</strong> merges the pull requests Mission
        Control opened once the Inspector has reviewed the current push with nothing
        outstanding, CI is green, nobody has an unresolved thread on it, and it has been
        open for the soak window below.
      </p>

      <div className="sc-split">
        <div className="sc-controls">
          <ConsoleCard
            title="YOLO mode"
            anchor="shipping/yolo"
            action={
              <ConsoleSwitch
                label="YOLO mode - merge our pull requests when they come out clean"
                tooltip="Merge our pull requests automatically once CI is green and review is clean"
                checked={autoMerge}
                disabled={!config}
                onChange={(next) => void update({ autoMerge: next })}
              />
            }
          >
            {!config ? (
              <ConsoleState tone="unknown">Unknown - the daemon has not answered</ConsoleState>
            ) : !autoMerge ? (
              <ConsoleState tone="off">Off - nothing merges without you</ConsoleState>
            ) : (
              <ConsoleState tone="danger">Armed - clean pull requests merge themselves</ConsoleState>
            )}

            {/* Same rule as the Inspector panel: the fallbacks below are the OFF posture, and
                presenting schema defaults as the daemon's answer tells the operator nothing is
                merging while the stored config may well be armed. */}
            {!config && (
              <p className="settings-warn ship-unknown">
                Can't reach the daemon, so whether YOLO mode is armed is unknown. The controls
                below are showing defaults, not its current state.
              </p>
            )}

            {/* Shown whenever it is armed, not only on the click that arms it: the risk is
                ongoing rather than momentary, and a merge is the one action here that no
                setting can take back. */}
            {autoMerge && (
              <p className="settings-warn ship-live-warn">
                Merges are performed on GitHub under your account and land on the base branch.
                Nothing in Mission Control can undo one.
              </p>
            )}

            <div className="sc-field" data-anchor="shipping/soak">
              <span className="sc-field-label">Soak time</span>
              {/* Auto-saves only after a settled edit, and flushes on blur or unmount - see
                  `NumberSetting`. It matters more here than where it came from: clearing the
                  field to retype reads as `0`, which this schema ACCEPTS as "no soak at all",
                  so an immediate per-keystroke commit would silently disarm the safety valve
                  rather than be refused. */}
              <div className="sc-number">
                <NumberSetting
                  value={soakMinutes}
                  min={0}
                  max={1440}
                  label="minutes open before it may merge"
                  disabled={!config}
                  onCommit={(n) => void update({ soakMinutes: n })}
                />
              </div>
              <p className="settings-hint">
                The window in which somebody can look at what an agent proposed and say no. Zero
                means merge as soon as everything else passes.
              </p>
            </div>

            <fieldset className="sc-field sc-seg" data-anchor="shipping/method">
              <legend className="sc-field-label">How to merge</legend>
              <div className="sc-seg-row">
                {(["squash", "merge", "rebase"] as const).map((m) => (
                  <Tooltip label={METHOD_LABEL[m]} key={m}>
                    <label className={`sc-seg-opt${method === m ? " is-on" : ""}`}>
                      <input
                        type="radio"
                        name="shipping-method"
                        checked={method === m}
                        disabled={!config}
                        onChange={() => void update({ method: m })}
                      />
                      <span>{METHOD_SHORT[m]}</span>
                    </label>
                  </Tooltip>
                ))}
              </div>
              <p className="settings-hint">{METHOD_LABEL[method]}.</p>
            </fieldset>
          </ConsoleCard>

          {/* The gotchas that would otherwise read as a broken feature, gathered into one
              card instead of three stacked amber paragraphs. Each names the switch to flip
              and carries the navigation to it, and they stay mutually exclusive in the
              order `inspectorPosture` checks them - telling someone whose Inspector is off
              that their repo is untrusted too is three problems presented where they can
              only act on the first.

              Rendered only while armed, and only while something is genuinely unmet: an
              always-present checklist of green ticks is a checklist nobody reads on the
              day one of them turns red. The condition is `anyBlocker` alone for exactly
              that reason - it was `anyBlocker || inspectorConfig !== null`, which drew the
              card with a green all-clear on every healthy install, which is the thing the
              sentence above says not to do. */}
          {autoMerge && anyBlocker && (
            <ConsoleCard title="Prerequisites">
              {inspectorOff && (
                <p className="sc-blocker">
                  <span className="sc-dot sc-dot-attention" aria-hidden="true" />
                  <span>
                    The Inspector is switched off, so no pull request is being reviewed and none
                    will qualify.{" "}
                    <Tooltip label="Open the Inspector panel and flash its master switch">
                      <button
                        type="button"
                        className="settings-link"
                        onClick={() => onNavigate("inspector", "inspector/enabled")}
                      >
                        Turn it on in Inspector →
                      </button>
                    </Tooltip>
                  </span>
                </p>
              )}

              {inspectorQuiet && (
                <p className="sc-blocker">
                  <span className="sc-dot sc-dot-attention" aria-hidden="true" />
                  <span>
                    The Inspector is in dry run, so it reviews but publishes nothing - and YOLO
                    mode will not merge on a review nobody can see.{" "}
                    <Tooltip label="Open the Inspector panel and flash its mode control">
                      <button
                        type="button"
                        className="settings-link"
                        onClick={() => onNavigate("inspector", "inspector/mode")}
                      >
                        Set it to live in Inspector →
                      </button>
                    </Tooltip>
                  </span>
                </p>
              )}

              {/* The two allowlists are separate on purpose (see below), so this is the one
                  state where both features are fully on and a specific repo still never
                  merges. It is fixed on the Trust matrix - grant the review, or revoke the
                  merge - so the link lands there rather than on the Inspector's panel. */}
              {someRepoUnreviewed && (
                <p className="sc-blocker">
                  <span className="sc-dot sc-dot-attention" aria-hidden="true" />
                  <span>
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
                  </span>
                </p>
              )}

            </ConsoleCard>
          )}

          <ConsoleCard title="May merge in" anchor="shipping/merge-repos">
            {/* The consent copy stays with the count: its own list, not the Inspector's -
                letting it comment on a repo is not the same permission as letting it merge
                there. That distinction is the whole point of a separate column in Trust. */}
            <p className="settings-hint">
              Its own list, not the Inspector's - letting it comment on a repo is not the same
              permission as letting it merge there. Worktrees of a trusted repo count too.
            </p>
            <TrustGrantSummary
              configured={Boolean(config)}
              count={allowlist.length}
              subject="YOLO may merge in"
              onNavigate={onNavigate}
            />
          </ConsoleCard>

          {/* Deliberately NOT gated on `autoMerge`, unlike the prerequisites above. This
              fires on ANY merge of a task's pull request, including one the operator
              performed on GitHub themselves, so hiding it behind YOLO mode would make a
              live setting invisible to everyone who merges by hand. */}
          <ConsoleCard
            title="After any merge"
            action={
              <ConsoleSwitch
                label="Close the session after its pull request merges"
                tooltip="After recording the merged task as complete, close its idle agent and free the checkout when nothing would be lost"
                checked={closeAfterMerge}
                disabled={!config}
                tone="ok"
                onChange={(next) => void update({ closeSessionAfterMerge: next })}
              />
            }
          >
            <p className="sc-after-merge">
              Complete the task, then close its session - frees a slot for a new backlog task.
            </p>
            <p className="settings-hint">
              Mission Control marks the task complete either way - it never gives the task Kill's
              failed outcome. This setting only decides whether the completed agent stays
              available for more work.
            </p>
            <p className="settings-hint">
              {closeAfterMerge
                ? "A finished agent otherwise counts against the fleet ceiling for as long as it lives. Its checkout is reclaimed only when it holds no uncommitted or untracked files; otherwise it is kept for Clean up."
                : "The agent stays, keeping its checkout and its context, and the autopilot may hand it the next task in place - no worktree to provision, but it carries the last task's context into the next one."}
            </p>
          </ConsoleCard>
        </div>

        {/* An auto-merger's failure mode is not merging the wrong thing - it is merging
            nothing and never saying why. This is where that is said, per pull request. */}
        <div className="sc-ledger" data-anchor="shipping/pr-status">
          <ConsoleStrip
            stats={STRIP.map((s) => ({ ...s, count: tallies[s.id] }))}
            active={filter}
            onPick={setFilter}
          />
          <div className="sc-table sc-table-shipping">
            <div className="sc-head">
              <h3>Merge queue</h3>
              {active && (
                <Tooltip label="Show every adopted pull request again">
                  <button type="button" className="sc-clear" onClick={() => setFilter(null)}>
                    {active.label} only - show all
                  </button>
                </Tooltip>
              )}
            </div>
            <div className="sc-row sc-row-head" aria-hidden="true">
              <span>Pull request</span>
              <span>Where it stands</span>
              <span className="sc-when">Last event</span>
            </div>
            {rows.length === 0 ? (
              <p className="settings-hint sc-empty">
                {inspections.length === 0
                  ? "Nothing yet. A pull request appears here once Mission Control opens one."
                  : EMPTY_FILTER[active!.id]}
              </p>
            ) : (
              rows.map((row) => {
                const bucket = mergeBucket(row);
                return (
                  <div
                    className={`sc-row${bucket === "closed" ? " is-retired" : ""}`}
                    key={row.key}
                  >
                    <PrLink
                      repo={row.repo}
                      number={row.number}
                      url={row.url}
                      tooltip={`Open ${row.repo}#${row.number} on GitHub`}
                    />
                    <span className={`sc-standing sc-standing-${bucket}`}>{mergeStatus(row)}</span>
                    <span className="sc-when">{when(row, now)}</span>
                  </div>
                );
              })
            )}
          </div>
          <p className="settings-hint sc-foot">
            Every row states its own reason, including a refusal <code>gh</code> gave us that this
            app cannot interpret - branch protection, or a required check we cannot see.
          </p>
        </div>
      </div>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
