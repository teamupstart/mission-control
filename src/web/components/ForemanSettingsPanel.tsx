import { useEffect, useRef, useState } from "react";
import type { ForemanState } from "../useForeman.ts";
import { Tooltip } from "./Tooltip.tsx";
import { ForemanEpisodeCard } from "./ForemanEpisodeCard.tsx";
import { fetchForemanEpisode } from "../lib/api.ts";
import { ModelField, ModelSuggestions } from "./ModelField.tsx";
import { TrustGrantSummary } from "./TrustPanel.tsx";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { FOREMAN_MODEL_ROLES, FOREMAN_MODEL_SPECS } from "@shared/foreman-models.ts";
import type { ForemanConfigPatch } from "@shared/protocol.ts";
import { LLM_RUNNER_IDS } from "@shared/llm.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import type { ForemanEpisode, ForemanEpisodeSummary, NoteDisposition } from "@shared/types.ts";
import type { ModelChoiceSpec } from "@shared/model-choice.ts";
import { FOREMAN_EPISODE_LEDGER, episodeOutcome } from "@shared/foreman.ts";
import type { EpisodeOutcome } from "@shared/foreman.ts";
import {
  FOREMAN_DEFAULT_TAB,
  FOREMAN_SETTINGS_TABS,
  foremanTabForAnchor,
  type ForemanSettingsTabId,
} from "../lib/foreman-settings-tabs.ts";
import { ago } from "./InspectorSettingsPanel.tsx";
import {
  ConsoleCard,
  ConsoleState,
  ConsoleStrip,
  ConsoleTable,
  SessionRef,
  sessionHandle,
  type ConsoleColumn,
  type ConsoleStat,
} from "./settings-console.tsx";

// Foreman's set-once configuration, as a settings category. The topbar popover keeps the
// in-the-moment knobs (enable, mode, work queues, on-drain); the durable posture lives
// here: the cheap-tier stance, completion safeguards, which model each call runs as, and
// the list of repos Foreman is trusted to send in live.
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
 * What the row's Outcome cell SAYS, which is no longer the bucket it is filed under.
 *
 * The bucket above stays a bare disposition on purpose - four piles, and the question they
 * answer is "does anyone still owe an answer here", which is the right axis for a filter
 * and for a tally. The word printed in the cell is a different question: "what actually
 * happened", and `skipped` was answering it for three unrelated events at once. See
 * `episodeOutcome` for the split and the numbers behind it.
 *
 * Keeping them separate is what lets the tiles keep accounting for every row while the
 * cells stop lying: `declined`, `stale` and `dismissed` all still file under `skipped`, so
 * the strip's guarantee holds and clicking it still selects all three.
 */
const OUTCOME_LABEL: Record<EpisodeOutcome, string> = {
  answered: "answered",
  drafted: "drafted",
  escalated: "escalated",
  declined: "declined",
  stale: "stale",
  dismissed: "dismissed",
};

/**
 * What each outcome MEANS, as the sentence a reader gets on hover.
 *
 * `stale` and `dismissed` carry the longest ones because they are the two the ledger has
 * never been able to say at all, and both read as an accusation without their explanation:
 * `stale` looks like Foreman failing when it is Foreman being beaten by the clock, and
 * `dismissed` looks like Foreman declining when it is the human who did.
 */
const OUTCOME_HINT: Record<EpisodeOutcome, string> = {
  answered: "A reply was delivered to the session.",
  drafted: "Foreman wrote a reply and is holding it for your confirmation.",
  escalated: "Foreman handed the decision to you, and nobody has answered it yet.",
  declined: "Foreman judged this one yours to make, and left it alone.",
  stale:
    "Foreman reached a verdict and the session moved on before it could be delivered, so nothing was sent. A race, not a judgment - the decision it had reached is still on the record below.",
  dismissed: "Foreman escalated this to you, and you closed it without answering.",
};

/**
 * The ladder's own diagnosis, in words - `TriageOutcome.reason` as a reader can use it.
 *
 * TWO strings per reason, and the split is what makes the column fit. The cell gets a
 * label short enough to survive its track and short enough to SCAN, which is the column's
 * real use: a run of eight `low confidence` rows down a ledger is a threshold to tune, and
 * that pattern is invisible if every cell is a different clipped sentence. The sentence
 * itself moves to the hover, where it has no width to fit inside.
 *
 * The first cut put the sentences in the cell and rendered "the router said this n...",
 * "the router was not c...", "a review, which Fore..." - a column added to say why,
 * saying why up to about twenty characters.
 *
 * A partial map over an open vocabulary, and both halves of that are deliberate. Partial
 * because one arm interpolates (`tier1-failed: <err>`) and no map can cover it; open
 * because the fallback prints the raw reason rather than swallowing it, so a newer worker's
 * diagnosis reaches the screen unlabelled instead of not at all.
 */
const TRIAGE_REASON: Record<string, { label: string; hint: string }> = {
  "non-input-review": {
    label: "a review",
    hint: "The session posted a plan or diff review, and Foreman may not approve a review.",
  },
  "terminal-no-pane": {
    label: "no screen",
    hint: "The session was blocked with no terminal screen to read the ask from.",
  },
  "no-question": {
    label: "nothing to answer",
    hint: "The session needed you but posted no answerable question.",
  },
  "input-review-question-too-long": {
    label: "ask too long",
    hint: "The ask was longer than the router reads, so it went to the full review whole rather than being routed on a clipped copy.",
  },
  "needs-judgment": {
    label: "needs judgment",
    hint: "The router bucketed this as needing judgment, which it never supplies itself.",
  },
  "low-confidence": {
    label: "low confidence",
    hint: "The router was below the confidence floor, so it deferred rather than guess.",
  },
  "human-only-skip": {
    label: "human-only",
    hint: "Human-only, and with nothing worth surfacing - so it was left alone quietly.",
  },
  "human-only-escalate": {
    label: "human-only",
    hint: "The router bucketed this as yours to decide.",
  },
  "human-only-risky": {
    label: "human-only, risky",
    hint: "Human-only, and the ask matched the destructive denylist - so it was surfaced rather than left quiet.",
  },
  "access-risky-escalated": {
    label: "risky access",
    hint: "The router thought it routine and the destructive denylist disagreed, so it was handed to you with the drafted reply kept as a recommendation.",
  },
  "access-without-answer": {
    label: "no reply drafted",
    hint: "Bucketed as routine access, but the router produced no reply to send - so it did not guess.",
  },
  "no-transcript-context": {
    label: "no recent turns",
    hint: "There was no prose in the recent turns for the destructive-ask backstop to have read, so an auto-answer could not be trusted.",
  },
  "no-transcript-file": {
    label: "no transcript",
    hint: "The session had no resolvable transcript file at all, which is a different diagnosis from a window that came back empty.",
  },
  "no-window-boundary": {
    label: "turns unplaceable",
    hint: "The recent turns could not be placed in the session, so a clean scan over them was not evidence about this ask.",
  },
  "menu-needs-a-row": {
    label: "no menu row named",
    hint: "The answer named no row of the menu on screen, and the cheap tier cannot select one - so it went to the full review, which can.",
  },
  "routine-access": {
    label: "routine access",
    hint: "Bucketed as a routine access request with a reply to send.",
  },
  "tier1-unparseable": {
    label: "router unreadable",
    hint: "The router's answer failed validation, which is an honest diagnosis of a broken router rather than a considered deferral.",
  },
};

/**
 * The one line under the author that says WHY this row came out the way it did.
 *
 * Ordered by how specific the answer is, and it falls through rather than picking a
 * favourite: the ladder's reason is the real diagnosis and wins wherever it exists, the
 * classification is the reviewer's own bucketing and is the next best thing, and a row
 * with neither says nothing rather than padding the column with a restatement of the
 * outcome beside it.
 *
 * The hint always ends with the RECORDED string, so no label here can hide what was
 * actually stored - which matters most for the reasons this map has no sentence for.
 */
export function episodeWhy(row: ForemanEpisodeSummary): { text: string; hint: string } | null {
  if (row.triageReason) {
    const known = TRIAGE_REASON[row.triageReason];
    // An unmapped reason prints RAW - `tier1-failed: <err>` is the case this exists for,
    // and it is the single most useful thing this column can ever say.
    return {
      text: known?.label ?? row.triageReason,
      hint: known ? `${known.hint} (recorded as "${row.triageReason}")` : row.triageReason,
    };
  }
  if (row.classification) {
    return {
      text: row.classification,
      hint: `Foreman classified this ask as "${row.classification}". The tier ladder recorded no reason for this row.`,
    };
  }
  return null;
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
      // "left alone" rather than "skipped", because this pile has three ways into it and
      // only one of them is a skip. What they share is the only thing the tile claims:
      // nobody ever answered these. The row says which of the three each one was.
      label: "left alone",
      tone: "plain",
      hint: "Show only the decisions nobody answered - Foreman declined it, the session moved on before a verdict could be delivered, or you dismissed it",
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
  skipped: "Every decision here was answered by somebody.",
};

/**
 * The ledger's column names. The shadow column is appended only under the posture that
 * MEASURES - see `showShadow` for why an empty 112px track is not free.
 */
function columns(showShadow: boolean): readonly ConsoleColumn[] {
  return [
    { label: "Session" },
    { label: "Asked" },
    { label: "Outcome" },
    { label: "Decided by" },
    ...(showShadow ? [{ label: "Cheap tier" }] : []),
    { label: "When", className: "sc-when" },
  ];
}

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
  jumpAnchor,
  jumpRequestId,
}: {
  state: ForemanState;
  onNavigate: SettingsNavigate;
  jumpAnchor?: string | null;
  /** Distinguishes repeated requests for the same anchor after the operator changes tabs. */
  jumpRequestId?: number | null;
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
  // A web build newer than its daemon can receive neither key. Render those absences as on,
  // matching the schema default the daemon applies, instead of showing an unticked safeguard
  // while the server is enforcing it.
  const skipScoutWrapup = config?.skipScoutWrapup !== false;
  const skipReviewArtifactWrapup = config?.skipReviewArtifactWrapup !== false;
  const now = Date.now();
  const [tab, setTab] = useState<ForemanSettingsTabId>(FOREMAN_DEFAULT_TAB);
  const tabRefs = useRef(new Map<ForemanSettingsTabId, HTMLButtonElement>());
  // Select a deep link's owning tab DURING render. SettingsPage owns the later effect that
  // scrolls and flashes the anchor; choosing here means React commits a visible target before
  // that parent effect runs. An effect here would lose the race and flash a hidden panel.
  const jumpToken = jumpRequestId ?? jumpAnchor ?? null;
  const lastJump = useRef<string | number | null>(null);
  if (jumpToken !== lastJump.current) {
    lastJump.current = jumpToken;
    const owner = jumpAnchor ? foremanTabForAnchor(jumpAnchor) : null;
    if (owner && owner !== tab) setTab(owner);
  }
  const [filter, setFilter] = useState<string | null>(null);
  // Which decision is open, by episode id, and only ever one. An accordion rather than
  // independent toggles because the detail card is tall - it carries the captured screen -
  // and two of them open in a scroller pushes the row you opened first off the top.
  const [opened, setOpened] = useState<number | null>(null);
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

  function onTablistKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    const last = FOREMAN_SETTINGS_TABS.length - 1;
    const idx = FOREMAN_SETTINGS_TABS.findIndex((candidate) => candidate.id === tab);
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
        next = idx <= 0 ? last : idx - 1;
        break;
      case "ArrowRight":
        next = idx >= last ? 0 : idx + 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const nextId = FOREMAN_SETTINGS_TABS[next]?.id;
    if (!nextId) return;
    setTab(nextId);
    tabRefs.current.get(nextId)?.focus();
  }

  return (
    <section className="settings-section sc-section">
      <p className="settings-hint sc-lede">
        Foreman's set-once configuration, and the record of what it has decided. Turning it
        on, its mode, the work queues, and the wrap-up action stay in the topbar Foreman
        control. Completion safeguards and model posture live here because they change what
        Foreman considers eligible, not what it does in one moment.
      </p>

      <div className="sc-split">
        <div className="sc-controls">
          {/* Always visible: this is a reading, not a setting. In particular, a dead worker
              must never disappear behind whichever configuration group was open last. */}
          {!config ? (
            <ConsoleState tone="unknown">Unknown - the daemon has not answered</ConsoleState>
          ) : !enabled ? (
            <ConsoleState tone="off">Off - nothing is being answered</ConsoleState>
          ) : status && !status.running ? (
            <ConsoleState tone="danger">
              Enabled, but no worker is running - nothing is being answered
            </ConsoleState>
          ) : mode === "live" ? (
            <ConsoleState tone="danger">Live - replying in sessions on your behalf</ConsoleState>
          ) : mode === "semi-auto" ? (
            <ConsoleState tone="attention">Semi-auto - drafting replies for you to confirm</ConsoleState>
          ) : (
            <ConsoleState tone="attention">Dry run - deciding, sending nothing</ConsoleState>
          )}

          {/* Every control below falls back to a default while the daemon is unreachable, so
              the warning stays beside the posture line rather than vanishing with a tab. */}
          {!config && (
            <p className="settings-warn foreman-unknown">
              Can't reach the daemon, so what Foreman is actually set to is unknown. The
              controls below are showing defaults, not its current state.
            </p>
          )}

          <div
            className="sc-tabs"
            role="tablist"
            aria-label="Foreman configuration groups"
            onKeyDown={onTablistKey}
          >
            {FOREMAN_SETTINGS_TABS.map((group) => {
              const selected = tab === group.id;
              const count =
                group.anchors.length === 1 ? "1 setting" : `${group.anchors.length} settings`;
              return (
                <Tooltip key={group.id} label={`Show Foreman ${group.label} settings - ${count}`}>
                  <button
                    id={`foreman-settings-tab-${group.id}`}
                    type="button"
                    className={`sc-tab${selected ? " is-active" : ""}`}
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`foreman-settings-panel-${group.id}`}
                    tabIndex={selected ? 0 : -1}
                    ref={(el) => {
                      if (el) tabRefs.current.set(group.id, el);
                      else tabRefs.current.delete(group.id);
                    }}
                    onClick={() => setTab(group.id)}
                  >
                    {group.label}
                    {/* Out of the accessible name - "Models 5" announces as a nonsense
                        label. The count still reaches assistive tech through the tab's
                        tooltip description, which spells out "5 settings". */}
                    <span className="sc-tab-count" aria-hidden="true">
                      {group.anchors.length}
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </div>

          <div
            id="foreman-settings-panel-posture"
            role="tabpanel"
            aria-labelledby="foreman-settings-tab-posture"
            hidden={tab !== "posture"}
          >
            <ConsoleCard title="Posture">
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
            </ConsoleCard>
          </div>

          <div
            id="foreman-settings-panel-models"
            role="tabpanel"
            aria-labelledby="foreman-settings-tab-models"
            hidden={tab !== "models"}
          >
            <ConsoleCard title="Models">
              <p className="settings-hint">
                Foreman Provider controls all four model roles: Review, Verify, Triage, and
                the Backlog dependency planner.
              </p>
              <div className="sc-field" data-anchor="foreman/provider">
                <label className="sc-field-label" htmlFor="foreman-provider">
                  Provider
                </label>
                <Tooltip label="Runs every Foreman model role through this provider. Foreman spawns a fresh, isolated call for each. Review and Verify are the expensive ones; Triage and Backlog are deliberately cheaper.">
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
                    blurb="hover"
                    onCommit={(next) =>
                      // An empty box is a cleared override, and must be STORED as empty so
                      // the env/default ladder takes over again - not dropped from the patch,
                      // which would leave the old value in place and look like the edit
                      // didn't stick.
                      void update({
                        [FOREMAN_MODEL_SPECS[role].configKey]: next,
                      } as ForemanConfigPatch)
                    }
                  />
                ))}
              </div>
            </ConsoleCard>
          </div>

          <div
            id="foreman-settings-panel-launches"
            role="tabpanel"
            aria-labelledby="foreman-settings-tab-launches"
            hidden={tab !== "launches"}
          >
            <ConsoleCard title="Launches">
              <p className="settings-hint">
                When Foreman starts a fresh backlog task, this selects its model unless the
                task already names one. Handing work to an existing session leaves that
                session's model unchanged. These launch models are unrelated to the Backlog
                dependency planner.
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
                  blurb="hover"
                  onCommit={(next) =>
                    void update({ backlogDefaultModel: { [agent]: next || null } })
                  }
                />
              ))}
            </ConsoleCard>
          </div>

          <div
            id="foreman-settings-panel-safety"
            role="tabpanel"
            aria-labelledby="foreman-settings-tab-safety"
            hidden={tab !== "safety"}
          >
            <ConsoleCard title="Safety">
              <p className="settings-hint">
                Choose which finished work Foreman retires without showing Ship it, running
                No-Mistakes Review, or typing Straight to PR. A task matching either enabled
                safeguard is kept out of every automatic completion action.
              </p>

              <div className="kb-row" data-anchor="foreman/skip-scout-wrapup">
                <div className="kb-row-text">
                  <span className="kb-row-label">Skip automatic completion for Scout tasks</span>
                </div>
                <div className="kb-row-controls">
                  <Tooltip label="Keeps Scout tasks out of Ship it, No-Mistakes Review, and Straight to PR. Uses the task's durable Kind. The scout's findings remain the finished output.">
                    <label className="skill-switch">
                      <input
                        type="checkbox"
                        checked={skipScoutWrapup}
                        disabled={!config}
                        aria-label="Skip automatic completion for Scout tasks"
                        onChange={(e) => void update({ skipScoutWrapup: e.target.checked })}
                      />
                    </label>
                  </Tooltip>
                </div>
              </div>

              <div className="kb-row" data-anchor="foreman/skip-review-artifact-wrapup">
                <div className="kb-row-text">
                  <span className="kb-row-label">
                    Skip automatic completion for mockups and review artifacts
                  </span>
                </div>
                <div className="kb-row-controls">
                  <Tooltip label="Keeps mockups and review-only artifacts out of automatic completion actions. Reads the resolved objective and artifact-only changed paths. Mixed work that also requests implementation still follows the normal completion action.">
                    <label className="skill-switch">
                      <input
                        type="checkbox"
                        checked={skipReviewArtifactWrapup}
                        disabled={!config}
                        aria-label="Skip automatic completion for mockups and review artifacts"
                        onChange={(e) =>
                          void update({ skipReviewArtifactWrapup: e.target.checked })
                        }
                      />
                    </label>
                  </Tooltip>
                </div>
              </div>
            </ConsoleCard>
          </div>

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
              {status.planner && (
                <p className="sc-health-row">
                  <span>Dependency planner</span>
                  <span className={`sc-health-value${status.planner.state === "degraded" ? " sc-health-warn" : ""}`}>
                    {status.planner.state} · {status.planner.runner}/{status.planner.model}
                    {status.planner.failureCount > 0 && ` · ${status.planner.failureCount} failures`}
                  </span>
                </p>
              )}
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
          <ConsoleTable
            title="Decisions"
            variant="foreman"
            modifier={showShadow ? "has-shadow" : undefined}
            columns={columns(showShadow)}
            rows={rows}
            rowKey={(row) => `${row.noteKey}:${row.marker}`}
            filter={
              active && {
                label: active.label,
                hint: "Show every recorded decision again",
                onClear: () => setFilter(null),
              }
            }
            // Total, not `active!` - see the Inspector's for why. It is computed on every
            // render, including the ones where the table has rows to show instead.
            empty={
              active === null || episodes.length === 0
                ? "Nothing yet. Every prompt Foreman decides on appears here, across every session."
                : EMPTY_FILTER[active.id]
            }
            foot={
              <>
                The last {FOREMAN_EPISODE_LEDGER} decisions across every session, newest first.
                Episodes are kept for 30 days, so this list reaches back only as far as the cap
                allows. Open a row for the ask, the screen it was read on, Foreman&apos;s
                reasoning, and what was sent back.
              </>
            }
            renderRow={(row) => (
              <EpisodeLedgerRow
                row={row}
                now={now}
                showShadow={showShadow}
                open={opened === row.id}
                onToggle={() => setOpened(opened === row.id ? null : row.id)}
              />
            )}
          />
        </div>
      </div>

      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}

/**
 * One ledger row, and the decision it opens onto.
 *
 * A button, not a div, and the whole reason this is now its own component. The panel used
 * to print five cells and stop: the ask (which is not an identity - `Needs approval: Bash`
 * covers 318 rows of a real 833-row ledger, `running AskUserQuestion` another 126), one
 * word of disposition, who and which tier, and a relative time. Every field that answers
 * "why did it decide that" - the purpose, the brief, the recommendation, the classification,
 * the confidence, the screen it read, the words it sent - was already stored, already
 * rendered by `ForemanEpisodeCard`, and reachable only by finding the session it happened
 * on and opening that session's drawer. Most of a 30-day ledger names sessions that no
 * longer exist, so for most rows it was reachable nowhere at all.
 */
function EpisodeLedgerRow({
  row,
  now,
  showShadow,
  open,
  onToggle,
}: {
  row: ForemanEpisodeSummary;
  now: number;
  showShadow: boolean;
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const outcome = episodeOutcome(row);
  const why = episodeWhy(row);
  return (
    <>
      <button
        type="button"
        className={`sc-row sc-row-open${open ? " is-open" : ""}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <SessionRef handle={sessionHandle(row.noteKey)} tooltip={`Session key ${row.noteKey}`} />
        {/* Purpose FIRST, ask second, and that ordering is the fix.
            `purpose` is Foreman's own reading of what the decision was for, and it is the
            only field that reliably differs between two rows - it was already fetched,
            already on the wire, and spent on a tooltip, which is to say spent on nothing a
            reader scanning the table can see. The verbatim ask stays underneath because it
            is the thing a reader RECOGNISES a moment by; it just cannot carry the row on
            its own. Reduced by the daemon, not here: the inputs are the captured screen and
            the menu rows, which is what must not ride a 4s poll. */}
        <span className="sc-ask">
          <span className="sc-ask-purpose">{row.purpose ?? row.ask}</span>
          {row.purpose && <span className="sc-ask-raw">{row.ask}</span>}
        </span>
        <Tooltip label={OUTCOME_HINT[outcome]}>
          <span className={`sc-verdict sc-verdict-${outcome}`}>{OUTCOME_LABEL[outcome]}</span>
        </Tooltip>
        {/* Why it came out that way, under who decided it. The two belong in one cell
            because they are one sentence - "foreman · cheap, because the router was not
            confident enough" - and splitting them would cost the ask another fixed track.

            "Who" is `resolvedBy`, never `sentBy`: a dismissal resolves an episode without
            delivering a word, and reading authorship off the send made one read back as an
            approval. Blank while nobody has decided yet. */}
        <span className="sc-decided">
          <span className="sc-decided-who">
            {[row.resolvedBy, tierLabel(row.tier)].filter(Boolean).join(" · ")}
          </span>
          {why && (
            // The RECORDED reason on hover, under the readable one. The label map is
            // partial over an open vocabulary, so this is what keeps it from being able to
            // hide what was actually stored - and it is a `Tooltip` rather than a native
            // `title` for the reason the whole app is: `title` never fires on focus, so a
            // keyboard reader would be the one person who could not reach it.
            <Tooltip label={why.hint}>
              <span className="sc-decided-why">{why.text}</span>
            </Tooltip>
          )}
        </span>
        {showShadow && (
          <span className="sc-shadow">
            {/* Blank, not "agreed", when nothing was measured: rows written before the
                shadow columns existed, and rows decided under a posture that takes no
                measurement, have no answer here. Printing agreement for them would
                manufacture evidence for the one question this column exists to answer. */}
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
      </button>
      {open && <EpisodeLedgerDetail id={row.id} />}
    </>
  );
}

/**
 * The opened decision, fetched on demand.
 *
 * Fetched here rather than folded into the ledger poll, and that is the trade
 * `ForemanEpisodeSummary` was built to make: the pane alone was 50.6% of the response on a
 * real database and the drawer-only fields came to 82KB every four seconds. One row's worth
 * of that, once, when someone actually asks to read it, costs nothing at all.
 *
 * It renders `ForemanEpisodeCard` rather than a settings-shaped copy of it, so the ledger,
 * the session drawer and the transcript cannot come to disagree about what a decision was -
 * which they would, because the interesting fields here are exactly the ones with judgment
 * in them.
 */
function EpisodeLedgerDetail({ id }: { id: number }): React.JSX.Element {
  const [episode, setEpisode] = useState<ForemanEpisode | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    // Cleared on every id change, so a slower fetch for a row you have since closed and
    // reopened elsewhere cannot paint the previous decision under the new one.
    setEpisode(null);
    setMissing(false);
    void fetchForemanEpisode(id).then((e) => {
      if (!alive) return;
      if (e) setEpisode(e);
      else setMissing(true);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="sc-detail">
      {episode ? (
        <ForemanEpisodeCard episode={episode} detail />
      ) : missing ? (
        // A real state, not a defensive branch: episodes are pruned at 30 days and the
        // ledger is a snapshot that can outlive one by a poll. Saying so beats a spinner
        // that never resolves.
        <p className="settings-hint">
          This decision is no longer stored - episodes are kept for 30 days.
        </p>
      ) : (
        <p className="settings-hint">Reading the decision...</p>
      )}
    </div>
  );
}
