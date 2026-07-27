import { useState } from "react";
import type { ForemanState } from "../useForeman.ts";
import { Tooltip } from "./Tooltip.tsx";
import { ModelField, ModelSuggestions } from "./ModelField.tsx";
import { TrustGrantSummary } from "./TrustPanel.tsx";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { FOREMAN_MODEL_ROLES, FOREMAN_MODEL_SPECS } from "@shared/foreman-models.ts";
import type { ForemanConfigPatch } from "@shared/protocol.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import type { ForemanEpisodeSummary, NoteDisposition } from "@shared/types.ts";
import type { ModelChoiceSpec } from "@shared/model-choice.ts";
import { FOREMAN_EPISODE_LEDGER } from "@shared/foreman.ts";
import { ago } from "./InspectorSettingsPanel.tsx";
import {
  ConsoleCard,
  ConsoleState,
  ConsoleStrip,
  SessionRef,
  type ConsoleStat,
} from "./settings-console.tsx";

// Foreman's set-once configuration, as a settings category. The topbar popover keeps the
// in-the-moment knobs (enable, mode, work queues, on-drain); the durable posture lives
// here: the cheap-tier stance, which model each call runs as, and the list of repos
// Foreman is trusted to send in live.
//
// It is drawn as a CONSOLE (`settings-console.tsx`), and the reason is the ledger. Every
// decision Foreman makes has been written to `foreman_episodes` since that table shipped -
// what it was asked, what it concluded, which tier decided, what reached the child - and
// until this panel existed the only way to read any of it was one session at a time,
// through that session's drawer. There was no answer anywhere to "what has Foreman
// actually been doing?", which is the question you open its settings to ask before
// deciding whether to give it more rope.

const TIER_LABEL: Record<"off" | "shadow" | "on", string> = {
  off: "Off - full review for every prompt",
  shadow: "Shadow - run the cheap tier alongside, measure it",
  on: "On - cheap tier answers the easy ones",
};

/** The same three postures as one word each, for the segmented control. */
const TIER_SHORT: Record<"off" | "shadow" | "on", string> = {
  off: "Off",
  shadow: "Shadow",
  on: "On",
};

// Unlike Foreman's own model calls, a backlog launch runs the task's chosen harness.
// Keep one field per harness: a Claude id cannot be a meaningful Codex default.
const BACKLOG_TASK_MODEL_SPECS: Record<(typeof AGENT_TYPES)[number], ModelChoiceSpec> = {
  claude: {
    label: "Claude backlog tasks",
    envVar: "",
    fallback: "the Harnesses default",
    blurb: "Used when Foreman launches an unpinned Claude task from the backlog.",
  },
  codex: {
    label: "Codex backlog tasks",
    envVar: "",
    fallback: "the Harnesses default",
    blurb: "Used when Foreman launches an unpinned Codex task from the backlog.",
  },
  pi: {
    label: "Pi backlog tasks",
    envVar: "",
    fallback: "the Harnesses default",
    blurb: "Used when Foreman launches an unpinned Pi task from the backlog.",
  },
};

/**
 * Which pile a ledger row belongs in - the axis the strip tallies and the filter selects.
 *
 * Today this is exactly the row's disposition, and it is still a named function rather
 * than a field read at both sites, for the reason `inspectionBucket` is: the tally and
 * the filter must be ONE question. A tile reading "4 escalated" over three rows is worse
 * than no tile, and the only structural guarantee against that is that both sides call
 * this. It is also the seam where a bucket that is not a bare disposition would go.
 */
export type EpisodeBucket = NoteDisposition;

export function episodeBucket(row: ForemanEpisodeSummary): EpisodeBucket {
  return row.disposition;
}

/**
 * The strip's tallies, in strip order. Folded over `episodeBucket`, never over
 * `ForemanStatus.counts` - see the STRIP comment for why those two are different
 * populations and must not be swapped for one another.
 */
export function episodeTallies(rows: readonly ForemanEpisodeSummary[]): Record<EpisodeBucket, number> {
  const t: Record<EpisodeBucket, number> = { escalated: 0, pending: 0, answered: 0, skipped: 0 };
  for (const row of rows) t[episodeBucket(row)] += 1;
  return t;
}

/**
 * The strip, one tile per bucket - and EVERY bucket, so the tiles account for every row.
 *
 * **These are folded out of the LEDGER ROWS, not out of `ForemanStatus.counts`**, and the
 * distinction is the whole reason this comment exists. `counts` is scoped to LIVE sessions
 * on purpose (`foreman/config.ts`, because `registry.listNotes()` would otherwise rehydrate
 * every note ever stored), while the ledger is historical and fleet-wide. They answer
 * different questions and will routinely disagree - a strip built from `counts` sitting
 * over rows built from the ledger would show "1 escalated" above eleven escalated rows,
 * and every other number on the panel is then worth nothing. The health card below is
 * where the live figures belong, and it says so.
 *
 * `escalated` and `pending` both carry the attention tone because both are exactly
 * `noteAwaitsYou`: one is Foreman handing the decision over, the other a draft it wants
 * confirmed, and either way somebody owes an answer.
 */
const STRIP: readonly { id: EpisodeBucket; label: string; tone: ConsoleStat["tone"]; hint: string }[] =
  [
    {
      id: "escalated",
      label: "escalated",
      tone: "attention",
      hint: "Show only the decisions Foreman declined to make and framed for you",
    },
    {
      id: "pending",
      label: "drafted",
      tone: "attention",
      hint: "Show only the replies Foreman wrote but has not sent - waiting on your confirm",
    },
    {
      id: "answered",
      label: "answered",
      tone: "ok",
      hint: "Show only the prompts Foreman answered on your behalf",
    },
    {
      id: "skipped",
      label: "skipped",
      tone: "plain",
      hint: "Show only the asks Foreman could not read, and left alone",
    },
  ];

/**
 * The buckets the strip has a tile for. Exported so a test can hold it against the bucket
 * vocabulary itself: a bucket with no tile is a pile of rows nothing on this screen counts,
 * which is how the Inspector's strip came to ignore 49 rows out of 50.
 */
export const FOREMAN_STRIP_BUCKETS: readonly EpisodeBucket[] = STRIP.map((s) => s.id);

/**
 * What an emptied filter says, per bucket. A `Record`, so the compiler asks for a sentence
 * whenever a bucket is added.
 *
 * Written out rather than composed from the bucket id, which is what produced the first
 * draft of the Inspector's equivalent: "No pull request is findings right now."
 */
const EMPTY_FILTER: Record<EpisodeBucket, string> = {
  escalated: "Foreman has not escalated anything.",
  pending: "Nothing is waiting on your confirmation.",
  answered: "Foreman has not answered anything itself yet.",
  skipped: "Foreman has understood every ask so far.",
};

/** How a divergence reads in the ledger, and how loud it is. */
const DIVERGENCE_LABEL: Record<string, string> = {
  agree: "agreed",
  "cheap-over-eager": "over-eager",
  "cheap-too-cautious": "cautious",
  minor: "minor",
  deferred: "deferred",
};

/**
 * Whether naming the cheap tier's action beside the divergence tells you anything.
 *
 * For two of the five it does not, because the classifier DEFINES them by that action:
 * `cheap-over-eager` is "the cheap tier answered and the review did not", and `deferred`
 * is "it routed up". Printing "over-eager (answer)" is the same word twice in a column
 * that is already the widest fixed track on the row. The other three are genuinely
 * informative - `agreed` on what, `cautious` in which direction, `minor` how - so they
 * keep it.
 */
function divergenceNamesItsAction(d: string): boolean {
  return d === "cheap-over-eager" || d === "deferred";
}

/**
 * What each divergence means, spelled out - the strip's tooltips do the same job.
 *
 * `cheap-over-eager` gets the sentence it does because it is the one that decides whether
 * this posture may be promoted to `on`: it is the cheap tier auto-answering where the full
 * review would not have.
 */
const DIVERGENCE_HINT: Record<string, string> = {
  agree: "The cheap tier reached the same action as the full review.",
  "cheap-over-eager":
    "The cheap tier would have ANSWERED where the full review did not. This is the one that has to stay near zero before turning the cheap tier on.",
  "cheap-too-cautious":
    "The cheap tier held back where the full review answered - safe, but it spent a full review to get there.",
  minor: "The two disagreed, but neither would have answered.",
  deferred: "The cheap tier routed up rather than deciding, so there was nothing to compare.",
};

/**
 * A short, stable handle for the session a row happened on.
 *
 * The ledger stores a `noteKey`, which is an `agentSessionId` (a UUID) when one is known
 * and a synthetic `proc:<tty>:<pid>:<start>` otherwise. Neither is readable at full
 * length, and this panel has no session list to resolve a name from - a fleet-wide,
 * historical ledger names sessions that mostly no longer exist, so there would be nothing
 * to resolve most rows against anyway. Truncating each form where it actually carries its
 * identity beats printing 36 characters of UUID in a table cell. Pure, and exported for
 * the test.
 */
export function sessionHandle(noteKey: string): string {
  if (noteKey.startsWith("proc:")) {
    const [, tty, pid] = noteKey.split(":");
    const dev = tty?.split("/").pop() ?? "";
    if (dev && pid) return `${dev}:${pid}`;
  }
  return noteKey.slice(0, 8) || "unknown";
}

/** Which tier decided, in the vocabulary the tier ladder uses. */
function tierLabel(tier: number | null): string {
  if (tier === 0) return "structural";
  if (tier === 1) return "cheap";
  if (tier === 2) return "review";
  return "";
}

export function ForemanSettingsPanel({
  state,
  onNavigate,
}: {
  state: ForemanState;
  onNavigate: SettingsNavigate;
}): React.JSX.Element {
  const { config, status, episodes, update, error } = state;
  // The provider actually in force, not `config.runner ?? "claude"`. An unset `runner`
  // falls to the app-wide ladder, whose env layer the browser cannot see - so the daemon
  // reports the resolution and this renders it. See `ForemanStatus.runner`.
  const runner = config?.runner ?? status?.runner ?? "claude";
  const allowlist = config?.repoAllowlist ?? [];
  const triage = config?.triage ?? "shadow";
  const enabled = config?.enabled ?? false;
  const mode = config?.mode ?? "dry-run";
  const now = Date.now();
  const [filter, setFilter] = useState<string | null>(null);
  const tallies = episodeTallies(episodes);
  const active = STRIP.find((s) => s.id === filter) ?? null;
  const rows = active === null ? episodes : episodes.filter((r) => episodeBucket(r) === active.id);
  // The shadow column earns its width only under the posture that actually MEASURES.
  //
  // Keyed on the posture rather than on whether any row happens to carry a divergence, so
  // flipping to Shadow shows the column immediately - empty, and about to fill - instead
  // of leaving the operator wondering whether the setting took.
  //
  // But `shadow` ONLY, not "anything but off". Under `on` the cheap tier IS the decision,
  // so `shadowBoth` never runs and no row will ever carry a measurement: the column is
  // permanently empty, and it was costing the ask 132 of the 716 pixels this table gets at
  // 1500px. Pointing the panel at a real ledger is what made that obvious - 95 of 100
  // cells blank - and it is the same claim the write path already makes, that `off` and
  // `on` both record null because neither has a second opinion to compare against.
  const showShadow = triage === "shadow";

  return (
    <section className="settings-section sc-section">
      <p className="settings-hint sc-lede">
        Foreman's set-once configuration, and the record of what it has decided. Turning it
        on, its mode, the work queues, and the on-drain action stay in the topbar Foreman
        control - the things you reach for while watching the fleet.
      </p>

      <div className="sc-split">
        <div className="sc-controls">
          <ConsoleCard title="Foreman">
            {/* No switch in this card's action slot, unlike Inspector and Shipping. The
                enable toggle lives in the topbar popover and stays there: that is the
                in-the-moment control, and this panel is the durable posture. What the card
                carries instead is the posture line, which is the half the popover cannot
                show you - and which nothing in the app showed at all before this. */}
            {!config ? (
              <ConsoleState tone="unknown">Unknown - the daemon has not answered</ConsoleState>
            ) : !enabled ? (
              <ConsoleState tone="off">Off - nothing is being answered</ConsoleState>
            ) : status && !status.running ? (
              /* This OUTRANKS the mode, and it is the reading this panel exists to
                 surface. `ForemanStatus.running` means a worker holds the lease and
                 renewed it recently; when it is false, Foreman is enabled and set to
                 whatever mode you chose and NOTHING IS EXECUTING IT. A dead worker and an
                 idle one look identical everywhere else in the app - same config, same
                 quiet fleet - so a panel that led with "Live" here would be confidently
                 describing a posture nothing is in. */
              <ConsoleState tone="danger">
                Enabled, but no worker is running - nothing is being answered
              </ConsoleState>
            ) : mode === "live" ? (
              <ConsoleState tone="danger">Live - replying in sessions on your behalf</ConsoleState>
            ) : mode === "semi-auto" ? (
              <ConsoleState tone="attention">
                Semi-auto - drafting replies for you to confirm
              </ConsoleState>
            ) : (
              <ConsoleState tone="attention">Dry run - deciding, sending nothing</ConsoleState>
            )}

            {/* Said out loud, for the reason the Inspector's equivalent is: every control
                below falls back to a default when the daemon is unreachable, and a
                disabled input showing `shadow` is not a claim that shadow is what is
                stored. */}
            {!config && (
              <p className="settings-warn foreman-unknown">
                Can't reach the daemon, so what Foreman is actually set to is unknown. The
                controls below are showing defaults, not its current state.
              </p>
            )}

            <fieldset className="sc-field sc-seg" data-anchor="foreman/cheap-tier">
              <legend className="sc-field-label">Cheap tier</legend>
              <div className="sc-seg-row">
                {(["off", "shadow", "on"] as const).map((t) => (
                  <Tooltip key={t} label={TIER_LABEL[t]}>
                    <label className={`sc-seg-opt${triage === t ? " is-on" : ""}`}>
                      <input
                        type="radio"
                        name="foreman-triage-settings"
                        checked={triage === t}
                        disabled={!config}
                        onChange={() => void update({ triage: t })}
                      />
                      <span>{TIER_SHORT[t]}</span>
                    </label>
                  </Tooltip>
                ))}
              </div>
              <p className="settings-hint">{TIER_LABEL[triage]}.</p>
              {triage === "shadow" && (
                <p className="settings-hint">
                  Every decision below carries what the cheap tier would have done. Promote
                  it to On once <b>over-eager</b> has stayed at zero for a while.
                </p>
              )}
            </fieldset>

            <div className="sc-field" data-anchor="foreman/provider">
              <label className="sc-field-label" htmlFor="foreman-provider">
                Provider
              </label>
              <Tooltip label="Which model provider Foreman's own calls are spawned with">
                <select
                  id="foreman-provider"
                  className="field-input sc-input"
                  value={runner}
                  disabled={!config}
                  onChange={(e) => {
                    const next = e.target.value as (typeof LLM_RUNNER_IDS)[number];
                    void update({
                      runner: next,
                      reviewModel: "",
                      verifyModel: "",
                      triageModel: "",
                      backlogModel: "",
                    });
                  }}
                >
                  {LLM_RUNNER_IDS.map((r) => (
                    <option key={r} value={r}>
                      {AGENT_IDENTITY[r].label}
                    </option>
                  ))}
                </select>
              </Tooltip>
              <p className="settings-hint">
                Runs every Foreman model role through this provider. Foreman spawns a fresh,
                isolated call for each. Review and Verify are the expensive ones; Triage and
                Backlog are deliberately cheaper.
              </p>
            </div>

            <div className="sc-field sc-model">
              <ModelSuggestions providerLabel={AGENT_IDENTITY[runner].label} />
              {FOREMAN_MODEL_ROLES.map((role) => (
                <ModelField
                  key={role}
                  anchor={`foreman/model-${role}`}
                  id={`foreman-model-${role}`}
                  spec={FOREMAN_MODEL_SPECS[role]}
                  value={config?.[FOREMAN_MODEL_SPECS[role].configKey] ?? ""}
                  resolved={status?.models?.[role]}
                  runner={runner}
                  disabled={!config}
                  onCommit={(next) =>
                    // An empty box is a cleared override, and must be STORED as empty so
                    // the env/default ladder takes over again - not dropped from the patch,
                    // which would leave the old value in place and look like the edit
                    // didn't stick.
                    void update({ [FOREMAN_MODEL_SPECS[role].configKey]: next } as ForemanConfigPatch)
                  }
                />
              ))}
            </div>
          </ConsoleCard>

          <ConsoleCard title="Backlog launch models">
            <p className="settings-hint">
              When Foreman starts a fresh backlog task, this selects its model unless the
              task already names one. Handing work to an existing session leaves that
              session's model unchanged.
            </p>
            {AGENT_TYPES.map((agent) => (
              <ModelField
                key={agent}
                anchor={`foreman/backlog-model-${agent}`}
                id={`foreman-backlog-task-model-${agent}`}
                spec={BACKLOG_TASK_MODEL_SPECS[agent]}
                value={config?.backlogDefaultModel?.[agent] ?? ""}
                resolved={undefined}
                runner={agent}
                disabled={!config}
                onCommit={(next) => void update({ backlogDefaultModel: { [agent]: next || null } })}
              />
            ))}
          </ConsoleCard>

          <ConsoleCard title="Live repositories" anchor="foreman/live-repos">
            {/* The scope-of-consent sentence stays here beside the count even though
                editing moved to Trust: it is about the grant, not the editor. "I set it
                live and it still asks me" reads as a bug without it. */}
            <p className="settings-hint">
              When Foreman is Live it only sends on your behalf in these repos - their
              worktrees count too, wherever they live on disk.
            </p>
            <TrustGrantSummary
              configured={Boolean(config)}
              count={allowlist.length}
              subject="Foreman may send live in"
              onNavigate={onNavigate}
            />
          </ConsoleCard>

          {/* The LIVE figures, and labelled as such. These come off `ForemanStatus`, which
              is scoped to sessions that exist right now - so they are deliberately not the
              same population as the ledger's strip, and putting them in their own card
              under their own heading is what keeps the two from reading as a contradiction. */}
          {status && (
            <ConsoleCard title="Right now" anchor="foreman/health">
              <p className="sc-health-row">
                <span>Worker</span>
                <span className={`sc-health-value${status.running ? "" : " sc-health-bad"}`}>
                  {status.running ? "running" : "not running"}
                </span>
              </p>
              <p className="sc-health-row">
                <span>Sessions needing you</span>
                <span className="sc-health-value">{status.queueDepth}</span>
              </p>
              <p className="sc-health-row">
                <span>Last decision</span>
                <span className="sc-health-value">
                  {status.lastActionAt === null ? "never" : ago(status.lastActionAt, now)}
                </span>
              </p>
              <p className="sc-health-row">
                <span>Backlog autopilot</span>
                <span className="sc-health-value">
                  {status.autopilot.on
                    ? `on - ${status.autopilot.active}/${status.autopilot.max} agents, ${status.autopilot.ready} ready`
                    : "off"}
                </span>
              </p>
            </ConsoleCard>
          )}
        </div>

        {/* The reason this panel is a console. Every one of these rows was already being
            written; none of them was readable anywhere except one session at a time. */}
        <div className="sc-ledger" data-anchor="foreman/episodes">
          <ConsoleStrip
            stats={STRIP.map((s) => ({ ...s, count: tallies[s.id] }))}
            active={filter}
            onPick={setFilter}
          />
          <div className={`sc-table sc-table-foreman${showShadow ? " has-shadow" : ""}`}>
            <div className="sc-head">
              <h3>Decisions</h3>
              {active && (
                <Tooltip label="Show every recorded decision again">
                  <button type="button" className="sc-clear" onClick={() => setFilter(null)}>
                    {active.label} only - show all
                  </button>
                </Tooltip>
              )}
            </div>
            <div className="sc-row sc-row-head" aria-hidden="true">
              <span>Session</span>
              <span>Asked</span>
              <span>Outcome</span>
              <span>Decided by</span>
              {showShadow && <span>Cheap tier</span>}
              <span className="sc-when">When</span>
            </div>
            {rows.length === 0 ? (
              <p className="settings-hint sc-empty">
                {episodes.length === 0
                  ? "Nothing yet. Every prompt Foreman decides on appears here, across every session."
                  : EMPTY_FILTER[active!.id]}
              </p>
            ) : (
              rows.map((row) => (
                <div className="sc-row" key={`${row.noteKey}:${row.marker}`}>
                  <SessionRef
                    handle={sessionHandle(row.noteKey)}
                    tooltip={`Session key ${row.noteKey}`}
                  />
                  {/* Reduced by the daemon, not here: the inputs are the captured
                      screen and the menu rows, which is exactly what must not ride a
                      4s poll. See `ForemanEpisodeSummary`. */}
                  <Tooltip label={row.purpose ?? row.ask}>
                    <span className="sc-ask">{row.ask}</span>
                  </Tooltip>
                  <span className={`sc-verdict sc-verdict-${row.disposition}`}>
                    {row.disposition === "pending" ? "drafted" : row.disposition}
                  </span>
                  {/* Who DECIDED it and which tier produced the verdict, in one cell.
                      Two tracks for two short closed vocabularies cost the ask 130px of
                      the 716 this table gets at 1500px, and the ask is the only cell whose
                      useful length is unbounded.

                      "Who" is `resolvedBy`, never `sentBy`: a dismissal resolves an episode
                      without delivering a word, and reading authorship off the send made one
                      read back as an approval. Blank while nobody has decided yet. */}
                  <span className="sc-decided">
                    {[row.resolvedBy, tierLabel(row.tier)].filter(Boolean).join(" · ")}
                  </span>
                  {showShadow && (
                    <span className="sc-shadow">
                      {/* Blank, not "agreed", when nothing was measured: rows written
                          before the shadow columns existed, and rows decided under a
                          posture that takes no measurement, have no answer here. Printing
                          agreement for them would manufacture evidence for the one
                          question this column exists to answer. */}
                      {row.divergence === null ? (
                        ""
                      ) : (
                        <Tooltip label={DIVERGENCE_HINT[row.divergence] ?? ""}>
                          <span className={`sc-div sc-div-${row.divergence}`}>
                            {DIVERGENCE_LABEL[row.divergence] ?? row.divergence}
                            {row.cheapAction && !divergenceNamesItsAction(row.divergence)
                              ? ` (${row.cheapAction})`
                              : ""}
                          </span>
                        </Tooltip>
                      )}
                    </span>
                  )}
                  <span className="sc-when">{ago(row.createdAt, now)}</span>
                </div>
              ))
            )}
          </div>
          <p className="settings-hint sc-foot">
            The last {FOREMAN_EPISODE_LEDGER} decisions across every session, newest first.
            Episodes are kept for 30 days. Open a session's Foreman drawer for the full
            question, the screen it was asked on, and what was sent back.
          </p>
        </div>
      </div>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
