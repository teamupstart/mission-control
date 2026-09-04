import { useEffect, useState } from "react";
import type {
  WorkflowConfig,
  WorkflowStatus,
  WorkflowSummary,
} from "@shared/workflow.ts";
import type { WorkflowSettingsState } from "../useWorkflowSettings.ts";
import type { SettingsNavigate } from "../lib/settings-registry.ts";
import { Tooltip } from "./Tooltip.tsx";
import { TrustGrantSummary } from "./TrustPanel.tsx";
import { TestEvidenceReadinessCard } from "./TestEvidenceReadinessCard.tsx";
import {
  ConsoleCard,
  ConsoleLinkStrip,
  ConsoleState,
  ConsoleSwitch,
  type ConsoleLink,
} from "./settings-console.tsx";
import {
  missionRouteHash,
  type WorkflowRunFilters,
} from "../workflows/useWorkflowRoute.ts";

import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "../workflows/WorkflowConfirmModal.tsx";

/**
 * Where workflow Commands are authored, as the hash the Library's own card produces.
 *
 * Built through the router's serializer rather than typed as a literal, so a shelf whose
 * segment ever moves takes this link with it instead of leaving a dead one in Settings.
 */
const COMMANDS_LIBRARY_HASH = missionRouteHash({ page: "library", shelf: "commands" });

// The Workflow subsystem's settings, as a settings category.
//
// It used to be a floating drawer hanging off the Workflows page header - a parallel
// settings surface with no rail row, no scope badge, no deep link and no search coverage,
// so the one switch in this app that can type into somebody's live agent session was the
// one switch you could not find by searching for it. Same routes, same config blob, same
// consent copy; what changed is that it is now where every other subsystem's settings are.
//
// It is drawn with the settings console's leaves (`settings-console.tsx`). It still has NO
// LEDGER, and that has not changed: `WorkflowRuns.tsx` is already the run list - cursor
// paging, SSE reconciliation, per-run actions, status chips - and the Workflows page header
// already links here. A run table in this panel would be a second, worse copy of that one,
// in a third CSS vocabulary, and the two would disagree the first time either changed. So
// the strip navigates to the real list instead of filtering a fake one, and the right column
// carries no `sc-ledger` / `sc-table` / `sc-row` markup at all.
//
// What DID change is the column count. This panel kept one column on the argument that the
// split is the ledger's shape and a panel without a ledger has nothing to put in the wide
// half. That was wrong about what it had: it had 2115px of content in an 831px scrollport -
// 2.55 screens - with its five health tiles and its health counters LAST, below y=1720, and
// 640px of unused width beside them the whole way down. A wide half is earned by anything
// worth reading at width, and readings are that; the thing it must not be filled with is a
// duplicate of a list another surface owns.
//
// So the two halves are split by how often what is in them CHANGES:
//
//   - Left, `.sc-controls`: set-once authorization. The dispatch default, the two switches
//     that act outside this panel, the Trust grant summary, and where Commands are authored.
//   - Right, `.wf-readings`: everything carrying a live number - the escalation strip, the
//     health counters, and the Test Evidence Auditor's rates.
//
// **`.wf-readings` is rendered FIRST and placed second.** The DOM is the focus order, and the
// panel is a single linear stack under 1081px where the visual sequence is unambiguous - so
// the readings lead the markup and `styles.css` puts `.sc-controls` in grid column 1 at
// desktop widths. Do not "tidy" this by restoring source order and reordering visually: an
// earlier cut did exactly that with `order: -1`, and because `order` moves boxes and never
// moves focus, the collapsed layout drew the readings first while the tab sequence still
// entered the policy switches first (WCAG 2.4.3) - with the relationship between the two
// INVERTING at the breakpoint. One sequence now serves both layouts.
//
// The honest cost: at desktop widths focus completes the readings column before entering the
// controls, so it traverses the right column before the left. That is the ordinary
// two-column tradeoff - each column's tabbables stay contiguous, which
// `settings-workflows-layout.spec.ts` asserts - and it is preferable to an order that depends
// on the window width.
//
// Run retention sits in the RIGHT column, which reads as a control in a readings column
// until you look at what it is measured against. Its three limits are meaningless without
// the readout under them ("31 of 1000 finished runs ranked by this limit", what the last
// sweep removed) - that readout exists precisely because the panel used to set three limits
// and show no measurement of the thing being limited - and that readout belongs beside the
// health counters, not two screens away from them. Placement was measured, not assumed:
// retention on the left gives 1411px with 487px of dead space under the readings, retention
// on the right gives 1170px with the two columns ending 65px apart.
//
// The two Trust-grant cards stay SEPARATE, and a future tidy-up must not merge them.
// `workflows/allowlist` and `workflows/command-catalog` are each a row in
// `settings-search.ts` with its own keywords, and `settings-sidebar-render.test.ts` requires
// every anchor to be unique and present - so one card cannot carry both, and merging them
// retires whichever one loses. An operator searching "check commands" for a table this panel
// no longer has is exactly who the second row exists for.
//
// The two confirmations go through the overlay registry (`WorkflowConfirmModal`) rather
// than `window.confirm`, for that component's own reason: a native dialog is invisible to
// the registry, so the fleet's global key handler stays live behind it.

/** The retention boxes as typed text, so a half-entered number is not a config write. */
interface RetentionDraft {
  rawEvidenceDays: string;
  completedRunDays: string;
  maxCompletedRuns: string;
}

function draftOf(config: WorkflowConfig): RetentionDraft {
  return {
    rawEvidenceDays: String(config.retention.rawEvidenceDays),
    completedRunDays: String(config.retention.completedRunDays),
    maxCompletedRuns: String(config.retention.maxCompletedRuns),
  };
}

/**
 * The ranges the daemon's own schema enforces, restated here so the panel refuses locally
 * with a sentence instead of bouncing off a 400. Kept as one table because the number in
 * the message and the number in the `min`/`max` attributes have to be the same number.
 *
 * Exported so the Label-in-Name test can assert over the TABLE rather than over three
 * hardcoded strings: a fourth retention limit added with a divergent label then fails that
 * test instead of slipping past a list nobody remembered to extend.
 */
export const RETENTION_FIELDS = [
  {
    key: "rawEvidenceDays",
    label: "Raw evidence days",
    hint: "Days before raw evidence is compacted out of an eligible finished run.",
    min: 1,
    max: 365,
  },
  {
    key: "completedRunDays",
    label: "Completed run days",
    hint: "Days before a finished run family may be removed entirely.",
    min: 30,
    max: 3_650,
  },
  {
    key: "maxCompletedRuns",
    label: "Newest completed runs kept",
    hint: "This many newest finished runs are kept whatever their age.",
    min: 100,
    max: 10_000,
  },
] as const satisfies readonly {
  key: keyof RetentionDraft;
  /**
   * ONE phrase per field: what is printed beside the box, what assistive tech announces,
   * and the subject of the out-of-range message.
   *
   * It is deliberately not split into a short visible label and a longer accessible name.
   * That split shipped briefly and broke WCAG 2.5.3 (Label in Name) for two of these three
   * fields: "Run history" is not a substring of "Completed run days" at all, and "Newest
   * kept" is not contiguous inside "Newest completed runs kept", so anyone reading the
   * printed text and speaking it to voice control - or hearing one name while their
   * neighbour reads another - could not reach the input. It bought nothing either: the three
   * full phrases measure 100, 106 and 151px, so the row needs 455px and has 588 to 708px at
   * every width where it stays one line, and wraps below that as any flex row does.
   */
  label: string;
  hint: string;
  min: number;
  max: number;
}[];

/**
 * The typed retention boxes as numbers, or the sentence saying which one is out of range.
 *
 * Pure, and exported, because the interesting cases cannot be reached by rendering: a
 * static render types nothing, and this is the gate deciding whether a shortening confirm
 * is even offered.
 */
export function readRetention(
  draft: RetentionDraft,
): { ok: true; value: WorkflowConfig["retention"] } | { ok: false; error: string } {
  const out = {} as WorkflowConfig["retention"];
  for (const field of RETENTION_FIELDS) {
    const value = Number(draft[field.key]);
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      return {
        ok: false,
        error: `${field.label} must be a whole number between ${field.min} and ${field.max}.`,
      };
    }
    out[field.key] = value;
  }
  return { ok: true, value: out };
}

/** Whether the new limits would let the next sweep remove more than the current ones. */
export function retentionShortens(
  next: WorkflowConfig["retention"],
  current: WorkflowConfig["retention"],
): boolean {
  return RETENTION_FIELDS.some((field) => next[field.key] < current[field.key]);
}

/**
 * The health strip's tiles: which `WorkflowStatus` scalar each shows, and which view of the
 * REAL run list reading it continues in.
 *
 * Ordered by escalation, not by data type, which is the point of the strip existing at all.
 * The twelve health scalars were a `<dl>` in which `uncertainDeliveries` - "a repair may or
 * may not have been typed into somebody's session and only a human can tell" - was rendered
 * in the same 10px grey as the count of Persona calls currently queued. Six of the twelve
 * are zero on a healthy install, so the two that mean somebody must look were the least
 * findable things on the panel.
 *
 * These counts do NOT sum, and no tile's count is the number of rows its link opens. They
 * are independent scalars over three populations - in-flight or uncertain deliveries, runs,
 * and delivered rows in retained run families - and the destination is the nearest honest
 * view of what the tile counted, not a re-derivation of it. `hint` therefore says what
 * clicking opens; see `ConsoleLinkStrip`.
 */
const STRIP_TILES = [
  {
    id: "needs-you",
    label: "Needs you",
    tone: "danger",
    hint: "Deliveries that could not be confirmed as typed in - only you can tell. "
      + "Opens the runs waiting on a session.",
    filters: { status: "waiting_for_session" },
    count: (s: WorkflowStatus) => s.uncertainDeliveries,
  },
  {
    id: "waiting",
    label: "Waiting",
    tone: "attention",
    hint: "Deliveries prepared or being sent right now. Opens the full run list.",
    filters: {},
    count: (s: WorkflowStatus) => s.waitingDeliveries,
  },
  {
    id: "gates",
    label: "GitHub Inspector gates",
    tone: "attention",
    hint: "Runs held at a GitHub Inspector gate. Opens the runs waiting for GitHub Inspector.",
    filters: { status: "waiting_for_inspector" },
    count: (s: WorkflowStatus) => s.inspectorGates,
  },
  {
    // "Active", not "Running", and it opens the WHOLE list rather than `status=running`.
    // `activeRuns` is every run not completed, cancelled or failed - so a blocked run and a
    // run waiting on a session are both in it - and the first cut labelled that "Running"
    // and linked it to `status=running`. Three populations in one tile: a fleet with blocked
    // work counted it here and then could not reach it through the tile that counted it.
    //
    // Counting only `running` rows would align the three, and it is the wrong repair: it
    // would need a second scalar, and blocked runs would then appear in no tile at all,
    // which is the state this strip exists to make visible. So the count stays the useful
    // one and the label and destination move to meet it. There is no single `status` filter
    // meaning "active", so the honest destination is the unfiltered list - the same one
    // Waiting opens, for the same reason.
    id: "active",
    label: "Active",
    tone: "plain",
    hint: "Runs that have not finished, in any state - running, waiting or blocked. "
      + "Opens the full run list.",
    filters: {},
    count: (s: WorkflowStatus) => s.activeRuns,
  },
  {
    id: "delivered",
    label: "Delivered",
    tone: "ok",
    hint: "Deliveries confirmed typed into a session among retained runs. "
      + "Opens the completed runs.",
    filters: { status: "completed" },
    count: (s: WorkflowStatus) => s.deliveredDeliveries,
  },
] as const satisfies readonly {
  id: string;
  label: string;
  tone: ConsoleLink["tone"];
  hint: string;
  filters: WorkflowRunFilters;
  count: (status: WorkflowStatus) => number;
}[];

/** Where a tile goes, as the hash the runs page's own filter chips would produce. */
function tileHref(filters: WorkflowRunFilters): string {
  return missionRouteHash({
    page: "runs",
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  });
}

/**
 * The strip's tiles for one status reading.
 *
 * Exported so a test can assert that each tile carries the scalar it claims - the failure
 * this rules out is silent and permanent, because a tile wired to the wrong field still
 * renders a plausible number and nothing on the panel contradicts it.
 *
 * A zero count still gets a tile. A missing tile reads as a missing subsystem, and "no
 * retained delivery is confirmed as sent" is a reading an operator who has just enabled
 * Live delivery specifically wants.
 */
export function workflowStripLinks(status: WorkflowStatus): ConsoleLink[] {
  return STRIP_TILES.map((tile) => ({
    id: tile.id,
    label: tile.label,
    tone: tile.tone,
    hint: tile.hint,
    count: tile.count(status),
    href: tileHref(tile.filters),
  }));
}

export function WorkflowSettingsPanel({
  state,
  workflows = [],
  foremanEnabled = false,
  onNavigate,
  onOpenRuns,
}: {
  state: WorkflowSettingsState;
  /** Live catalog; only active published workflows are valid dispatch defaults. */
  workflows?: WorkflowSummary[];
  /** The completion detector that turns the default into an automatic run. */
  foremanEnabled?: boolean;
  /**
   * Deep-link into Trust, for the grant summary that replaced this panel's repo editor.
   * The same prop Foreman, the Inspector and Shipping take for the same reason.
   */
  onNavigate: SettingsNavigate;
  /**
   * Follow a health tile to the nearest corresponding Workflows run-list view.
   *
   * Its own prop rather than a widening of `SettingsNavigate`, which the other three panels
   * take: that one is typed to settings categories, and this navigation leaves the settings
   * page entirely. Optional, so a render test can mount the panel without a router - the
   * tiles are still real links with real hashes, so nothing about them is untestable.
   */
  onOpenRuns?: (filters: WorkflowRunFilters) => void;
}): React.JSX.Element {
  const { config, status, testEvidenceAudit, update, error } = state;
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [retention, setRetention] = useState<RetentionDraft>({
    rawEvidenceDays: "",
    completedRunDays: "",
    maxCompletedRuns: "",
  });
  // Adopt the daemon's values once, when the first read lands. Keyed on the config object
  // rather than on its numbers so a later poll cannot overwrite a half-typed box - the
  // boxes are a draft the operator applies, not a mirror of what is stored.
  const [adopted, setAdopted] = useState(false);
  useEffect(() => {
    if (config && !adopted) {
      setRetention(draftOf(config));
      setAdopted(true);
    }
  }, [config, adopted]);

  const liveEnabled = config?.liveEnabled ?? false;
  const allowlist = config?.repoAllowlist ?? [];
  const checksEnabled = config?.checksEnabled ?? false;
  const publishedWorkflows = workflows.filter(
    (workflow) => workflow.archivedAt === null && workflow.currentVersionId !== null,
  );

  const save = async (next: WorkflowConfig): Promise<void> => {
    setBusy(true);
    setLocalError(null);
    try {
      await update(next);
    } finally {
      setBusy(false);
    }
  };

  const toggleLive = (enabled: boolean): void => {
    if (!config) return;
    if (!enabled) {
      void save({ ...config, liveEnabled: false });
      return;
    }
    setConfirm({
      title: "Enable Live workflow delivery",
      body:
        "Mission Control may paste deterministic Persona repair instructions into agent " +
        "sessions running in the repositories granted the Workflows cell in Trust. Preview " +
        "bindings stay read-only.",
      confirmLabel: "Enable Live delivery",
      confirmHint: "Allow repair packets to be typed into allowlisted sessions",
      onConfirm: () => void save({ ...config, liveEnabled: true }),
    });
  };

  const toggleChecks = (enabled: boolean): void => {
    if (!config) return;
    if (!enabled) {
      void save({ ...config, checksEnabled: false });
      return;
    }
    // The confirm copy names what is actually being authorized, which is not "running a
    // command" but running THIS BRANCH's code. The argv is the operator's; everything that
    // argv loads belongs to whoever wrote the change under review.
    //
    // This is the ONE confirmation, and it is why the panel no longer carries a permanent
    // warning banner repeating it: an operator who has read and accepted this sentence does
    // not need it shouted at them on every later visit to the page.
    setConfirm({
      title: "Allow workflow Commands",
      body:
        "A Command node runs the argv configured in Library, in a commit-pinned checkout of " +
        "the repository under review, with this daemon's filesystem authority. That command " +
        "loads scripts, dependencies and source from the branch being reviewed, so allowing " +
        "this executes branch-authored code. It is not a sandbox. Only repositories granted " +
        "the Workflows cell in Trust are reached.",
      confirmLabel: "Allow Commands",
      confirmHint: "Allow branch-authored code to run with the daemon's filesystem authority",
      danger: true,
      onConfirm: () => void save({ ...config, checksEnabled: true }),
    });
  };

  const applyRetention = (): void => {
    if (!config || busy) return;
    const read = readRetention(retention);
    if (!read.ok) {
      setLocalError(read.error);
      return;
    }
    setLocalError(null);
    const next = { ...config, retention: read.value };
    if (!retentionShortens(read.value, config.retention)) {
      void save(next);
      return;
    }
    setConfirm({
      title: "Shorten Workflow retention",
      body:
        "The next sweep can permanently compact evidence, or delete eligible completed and " +
        "cancelled run history, that today's limits would have kept. Active, waiting, " +
        "blocked, failed, orphaned and delivery-uncertain work is never age-pruned.",
      confirmLabel: "Shorten retention",
      confirmHint: "Save the shorter limits and let the next sweep act on them",
      danger: true,
      onConfirm: () => void save(next),
    });
  };

  const openTile = (id: string): void => {
    const tile = STRIP_TILES.find((candidate) => candidate.id === id);
    if (tile) onOpenRuns?.(tile.filters);
  };

  return (
    <section className="settings-section sc-section wf-settings">
      <p className="settings-hint sc-lede">
        Review workflows run Personas over a session's submitted work and route their
        verdicts back to it. What is configured here is the subsystem <em>policy</em>: whether
        repairs may be typed into a live session, whether a Command may run at all, and how
        much run history is kept. What each thing IS - workflows, Personas, actions, and the
        commands behind each Command slot - is authored in <strong>Library</strong>.
      </p>

      {/* The daemon has not answered. Said out loud, on the Inspector panel's rule: the
          fallbacks below are "off" and "no repos", the safe posture, and drawing them as
          the daemon's answer tells the operator nothing can be pasted anywhere while the
          stored config may well have Live enabled. */}
      {!config && (
        <p className="settings-warn wf-settings-unknown">
          Can't reach the daemon, so what Workflow delivery is actually set to is unknown.
          The controls below are showing defaults, not its current state.
        </p>
      )}

      {/* The READINGS come first in the DOM, and the control column is placed into grid
          column 1 beside them at desktop widths. Reading order is therefore identical at
          every window size.

          The first cut had the controls first in the DOM and gave `.wf-readings`
          `order: -1` when the split collapsed, so the readings LOOKED first under 1081px
          while focus still entered the policy switches first - WCAG 2.4.3, and worse, the
          relationship between the visual and focus order flipped at the breakpoint. Visual
          reordering with `order` never moves focus; only the DOM does. See `.sc-split`
          placement in `styles.css`. */}
      <div className="sc-split">
        {/* Right half: everything carrying a live number. The strip leads it, because the
            two tiles that can mean "somebody must look" are the reason this panel is opened
            after a run goes wrong, and they used to be the last thing on it.

            NOT `sc-ledger`: that class says a ledger table lives here, and this panel still
            has no run list. See the module comment. */}
        <div className="wf-readings">
          {status && (
            <ConsoleLinkStrip
              stats={workflowStripLinks(status)}
              // Withheld rather than stubbed when nothing is listening, so the tiles fall
              // back to being plain links the browser follows instead of dead ones.
              onOpen={onOpenRuns ? openTile : undefined}
            />
          )}

          <ConsoleCard title="Workflow health" anchor="workflows/health">
            <p className="settings-hint">
              Counters only, refreshed while this panel is open. No prompt, diff, transcript,
              Persona guidance, model output or delivery payload passes through here.
            </p>
            {status ? (
              /* Two across, not six full-width rows. Three of these readings are single
                 digits and two are timestamps; a row spanning the whole column to say "0"
                 is what made this card the tallest thing below the fold. */
              <div className="wf-health-grid">
                <p className="sc-health-row">
                  <span>Retained runs</span>
                  <span className="sc-health-value">{status.retainedRunCount}</span>
                </p>
                <p className="sc-health-row">
                  <span>Queued Persona calls</span>
                  <span className="sc-health-value">{status.queuedPersonaCalls}</span>
                </p>
                <p className="sc-health-row">
                  <span>Running Persona calls</span>
                  <span className="sc-health-value">{status.runningPersonaCalls}</span>
                </p>
                <p className="sc-health-row">
                  <span>Last sweep error</span>
                  <span
                    className={`sc-health-value${status.lastRetentionError ? " sc-health-bad" : ""}`}
                  >
                    {status.lastRetentionError ?? "None"}
                  </span>
                </p>
                <p className="sc-health-row">
                  <span>Last recovery</span>
                  <span className="sc-health-value">
                    {status.lastRecoveryAt
                      ? new Date(status.lastRecoveryAt).toLocaleString()
                      : "Not yet run"}
                  </span>
                </p>
                <p className="sc-health-row">
                  <span>Last retention sweep</span>
                  <span className="sc-health-value">
                    {status.lastRetentionAt
                      ? new Date(status.lastRetentionAt).toLocaleString()
                      : "Not yet run"}
                  </span>
                </p>
              </div>
            ) : (
              // "has not answered", not "has not answered YET": a null status is the pre-poll
              // instant AND a daemon that has stopped answering, and the second is the one
              // where a still-loading sentence would be read as a delay rather than a gap.
              <p className="settings-hint wf-settings-empty">
                Workflow health is unavailable - the daemon has not answered.
              </p>
            )}
          </ConsoleCard>

          <ConsoleCard title="Run retention" anchor="workflows/retention">
          <p className="settings-hint">
            Active, waiting, blocked, failed, orphaned and delivery-uncertain work is never
            age-pruned. Completed and cancelled runs go through the two stages below.
          </p>
          {/* One row: three boxes and the Apply that saves them. Stacked, this was 150px to
              ask three questions whose answers are two to four digits each - and the button
              needed its own wrapper to stop a `.sc-card-body` flex column stretching it to
              the panel's width.

              Each box prints its FULL label and takes its accessible name from that same
              text, through the wrapping `<label>`. No `aria-label` here on purpose: an
              `aria-label` that differs from the printed words is how this row briefly broke
              WCAG 2.5.3, and the row does not need the space that bought. See
              `RETENTION_FIELDS`. */}
          <div className="wf-retention-inline">
            {RETENTION_FIELDS.map((field) => (
              <Tooltip key={field.key} label={field.hint}>
                <label>
                  <span>{field.label}</span>
                  <input
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={retention[field.key]}
                    disabled={!config || busy}
                    onChange={(event) => setRetention((draft) => ({
                      ...draft,
                      [field.key]: event.target.value,
                    }))}
                  />
                </label>
              </Tooltip>
            ))}
            <Tooltip label="Save these retention limits - shortening one asks first">
              <button className="btn" disabled={!config || busy} onClick={applyRetention}>
                Apply
              </button>
            </Tooltip>
          </div>

          {/* What the limits above are measured AGAINST. The panel set three of them and
              showed no measurement of the thing being limited; the only related number on
              the page was "Retained runs", under Health, which is `COUNT(*)` over every run
              row of any status and so cannot be read against `maxCompletedRuns` at all.
              `completedRunCount` is the population that limit actually ranks - finished,
              with a completion time, not pinned by an uncertain delivery - so this is a
              like-for-like reading rather than a ratio of two different questions. */}
          <div className="wf-settings-readout">
            <p className="sc-health-row">
              <span>Finished runs ranked by this limit</span>
              <span className="sc-health-value">
                {status && config
                  ? `${status.completedRunCount} of ${config.retention.maxCompletedRuns}`
                  : "unknown"}
              </span>
            </p>
            <p className="sc-health-row">
              <span>Last sweep removed</span>
              {/* Guarded on whether a sweep has ever run, rather than printing the zeros a
                  never-swept daemon carries: "0 compacted, 0 deleted" is a reading, and a
                  daemon that has not swept has not taken one. */}
              <span className="sc-health-value">
                {!status
                  ? "unknown"
                  : status.lastRetentionAt === null
                    ? "not yet run"
                    : `${status.lastRetentionCompacted} compacted, `
                      + `${status.lastRetentionDeleted} deleted`}
              </span>
            </p>
          </div>
          <p className="settings-hint">
            Only finished runs are ranked by the newest-kept limit. Everything still working,
            waiting or failed sits outside that population and is never counted against it.
          </p>
        </ConsoleCard>

        {/* Beside the health counters, not two screens from them. It is a READING and
            nothing in it can be changed here; it answers "is the evidence contract working",
            where the card above answers "is the subsystem working". An operator who has just
            had a submission rejected opens this panel to ask the first question, so it is in
            the readings column and last, where the deepest detail belongs. */}
          <TestEvidenceReadinessCard aggregate={testEvidenceAudit} workflows={workflows} />
        </div>
        <div className="sc-controls">
          <ConsoleCard title="Dispatch default" anchor="workflows/dispatch-default">
            <p className="settings-hint">
              Arm every new single-agent dispatch with a published Workflow. The dispatch form
              shows this choice inline and can override it per task.
            </p>
            <div className="wf-default-row">
              <span className="wf-default-flow" aria-hidden>task → workflow</span>
              <Tooltip label="Workflow preselected for every new single-agent dispatch">
                <select
                  className="field-input wf-default-select"
                  value={config?.defaultWorkflowId ?? ""}
                  disabled={!config || busy}
                  aria-label="Default after-work Workflow for dispatched tasks"
                  onChange={(event) => {
                    if (!config) return;
                    void save({
                      ...config,
                      defaultWorkflowId: event.target.value || null,
                    });
                  }}
                >
                  <option value="">None</option>
                  {publishedWorkflows.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name} · v{workflow.publishedVersion}
                    </option>
                  ))}
                  {config?.defaultWorkflowId
                    && !publishedWorkflows.some(
                      (workflow) => workflow.id === config.defaultWorkflowId,
                    )
                    && (
                      <option value={config.defaultWorkflowId}>
                        Unavailable Workflow
                      </option>
                    )}
                </select>
              </Tooltip>
            </div>
            {config?.defaultWorkflowId && !foremanEnabled && (
              <p className="settings-warn wf-default-warning">
                Foreman is off. Turn it on before dispatching with this default, or choose None
                in the dispatch form.
              </p>
            )}
            {publishedWorkflows.length === 0 && (
              <p className="settings-hint wf-settings-empty">
                Publish a Workflow before choosing a dispatch default.
              </p>
            )}
          </ConsoleCard>

          <ConsoleCard
            title="Live delivery"
            anchor="workflows/live-delivery"
            action={(
              <ConsoleSwitch
                label="Enable Live workflow delivery"
                tooltip="Allow repair packets to be typed into sessions in the repos granted in Trust"
                checked={liveEnabled}
                disabled={!config || busy}
                // The one switch in this app that types into a live agent's terminal. Its
                // blast radius is a keystroke in somebody's composer, not a comment on a pull
                // request, and the tone is what says so before the confirm dialog does.
                tone="danger"
                onChange={toggleLive}
              />
            )}
          >
            {!config ? (
              <ConsoleState tone="unknown">Unknown - the daemon has not answered</ConsoleState>
            ) : liveEnabled ? (
              <ConsoleState tone="danger">
                Live - repairs are typed into agent sessions
              </ConsoleState>
            ) : (
              <ConsoleState tone="off">Off - nothing is delivered</ConsoleState>
            )}

            {liveEnabled && (
              <p className="settings-warn wf-settings-live-warn">
                Live bindings write into a real terminal pane. A repair packet is typed into the
                agent's own composer, in the repositories granted the Workflows cell in Trust
                and nowhere else.
              </p>
            )}
          </ConsoleCard>

          <ConsoleCard title="Allowed repositories" anchor="workflows/allowlist">
            {/* The editor moved to Trust, and this became the summary the other three
                grant-consuming panels already show. The comment that used to sit here argued
                Workflows was not a Trust column and that making it one would MOVE this list
                rather than summarise it; that is exactly what happened.

                The card stays rather than the anchor disappearing: `workflows/allowlist` is a
                settings-search target, and a live subsystem's consent scope is worth stating
                where its switches are even when it is not editable here. */}
            {/* The scope-of-consent sentence sits with the count, not with the switch: it is
                about the grant. "I turned Live on and it still previews" reads as a bug
                without it. */}
            <p className="settings-hint">
              Live delivery only sends in the repositories granted the Workflows cell in Trust
              - their worktrees count too, wherever they live on disk. Revoking one keeps
              existing bindings visible and refuses their next delivery; nothing is silently
              downgraded to Preview. The same grant is what lets a Command node run a command.
            </p>
            <TrustGrantSummary
              configured={Boolean(config)}
              count={allowlist.length}
              subject="Workflows may act in"
              onNavigate={onNavigate}
            />
          </ConsoleCard>

          {/* Authorization, and nothing else. The catalog of argvs this switch governs moved to
              Library › Commands, where a command is authored once and reused - what stays here
              is the machine-wide decision to let one run at all, which is policy and belongs
              beside the other policy switches. */}
          <ConsoleCard
            title="Workflow Commands"
            anchor="workflows/checks"
            action={(
              <ConsoleSwitch
                label="Allow workflow Commands"
                tooltip="Allow a workflow's Command node to run the argv configured in Library"
                checked={checksEnabled}
                disabled={!config || busy}
                // Branch-authored code with the daemon's filesystem authority. The tone says so
                // before the confirm dialog does, exactly as Live delivery's does.
                tone="danger"
                onChange={toggleChecks}
              />
            )}
          >
            {!config ? (
              <ConsoleState tone="unknown">Unknown - the daemon has not answered</ConsoleState>
            ) : checksEnabled ? (
              <ConsoleState tone="danger">
                Allowed - a Command runs branch-authored code
              </ConsoleState>
            ) : (
              <ConsoleState tone="off">Paused - every Command passes with a note</ConsoleState>
            )}
            {/* ONE sentence, stated whether the switch is on or off, replacing the persistent
                red banner that repeated the enable dialog to an operator who had already read
                and accepted it. It says what is authorized rather than shouting that something
                is dangerous: the argv is the operator's, and everything that argv loads belongs
                to whoever wrote the branch under review. */}
            <p className="settings-hint">
              A Command runs in a commit-pinned checkout of the branch under review, without a
              shell, with this daemon's filesystem authority - so it executes that branch's
              scripts, dependencies and build steps. It is not a sandbox. Only repositories
              granted the Workflows cell in Trust can run one.
            </p>
          </ConsoleCard>

          {/* Where the commands went, said in the place an operator who remembers the old table
              will look for it. A link rather than a smaller copy of the editor: two surfaces
              authoring one catalog is how they start disagreeing. */}
          <ConsoleCard title="What each Command runs" anchor="workflows/command-catalog">
            <p className="settings-hint">
              A workflow names a portable slot - <code>test</code>, <code>lint</code>,{" "}
              <code>typecheck</code>, <code>build</code> - never an argv, so the same workflow
              travels between repositories. Library › Commands is where this machine says what
              each slot runs: one global default per slot, plus any repository or subdirectory
              exceptions. A slot with nothing configured passes with a note rather than failing.
            </p>
            <p className="wf-settings-commands-link">
              <Tooltip label="Open the Commands shelf in Library, where each slot's argv is set">
                <a className="btn btn-ghost" href={COMMANDS_LIBRARY_HASH}>
                  Open Commands in Library →
                </a>
              </Tooltip>
            </p>
          </ConsoleCard>
        </div>
      </div>

      {(localError ?? error) && (
        <p className="settings-error" role="alert">{localError ?? error}</p>
      )}

      {confirm && (
        <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />
      )}
    </section>
  );
}
