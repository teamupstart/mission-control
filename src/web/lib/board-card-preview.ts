import type { Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";

/**
 * The session the Board card panel's preview draws, and the only session fixture in
 * `src/web`.
 *
 * The panel mounts the REAL `SessionTile` against this rather than a hand-drawn mock. A
 * mock would be a second source of truth for what a card looks like, which is the thing
 * this whole feature exists to avoid - and it would drift the first time the tile changed.
 *
 * The one hard constraint on this object: it must populate EVERY item in
 * `DISPLAY_ITEMS` with `group: "card"`. An item the fixture leaves empty draws nothing
 * whether it is checked or not, which reads as a broken checkbox rather than as an empty
 * session. `test/board-card-items.test.ts` holds this to account.
 *
 * There is no fixture in `test/helpers/session-fixture.ts` to share: that file is under
 * `test/` and the web bundle cannot import it. The Tour spotlights real tiles rather than
 * a fixture, and demo mode seeds a fleet in the daemon rather than in the browser.
 */

/** A path long enough to show why the card prints the leaf and puts the rest on hover. */
const PREVIEW_CWD = "/Users/you/.mission-control/worktrees/mission-control-3/parser-fix";

/** The fixture session's stable id, so the run below can name it without a cycle. */
const PREVIEW_SESSION_ID = "board-card-preview";

/**
 * The fixture, stamped against a clock.
 *
 * `now` is a parameter rather than a `Date.now()` inside, because "last seen" is one of the
 * items being previewed and it has to read as a plausible recent moment rather than as
 * fifty-six years ago. The caller memoises one stamp for the life of the panel, so the
 * preview does not tick while the operator reads the checklist beside it.
 */
export function previewSession(now: number): Session {
  return {
    id: PREVIEW_SESSION_ID,
    agent: "claude",
    runtime: "terminal",
    foremanInvite: "dispatch",
    name: "Fix the parser",
    nameSource: "tmux",
    // Working, instrumented and with an `activity` string, which is what `liveActivity`
    // requires before the ticker draws at all.
    state: "working",
    cwd: PREVIEW_CWD,
    gitBranch: "mission/fix-the-parser",
    gitRoot: null,
    repoRoot: null,
    pid: 0,
    tty: null,
    permissionMode: "acceptEdits",
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: "editing Parser.ts",
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: now - 42_000,
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: {
      model: "Sonnet 4.5",
      modelId: "claude-sonnet-4-5",
      longContext: false,
      thinkingLevel: "high",
      thinkingEnabled: true,
      contextPct: 46,
      contextTokens: 92_000,
      contextWindow: 200_000,
      source: "statusline",
      updatedAt: 0,
    },
    // False, so the effort chip renders its read-only form rather than offering a picker
    // that would post a level to a session that does not exist.
    effortBaselineReady: false,
    pendingEffort: null,
    note: null,
    cost: {
      costUsd: 2.4,
      basis: "api-equivalent",
      pricingModels: ["claude-sonnet-4-5"],
      pricingVersions: [],
      input: 48_000,
      output: 6_200,
      cacheRead: 210_000,
      cacheWrite: 12_000,
      updatedAt: 0,
    },
    goal: {
      text: "Make the parser accept trailing commas",
      source: "model",
      updatedAt: 0,
    },
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    inspector: null,
    pipeline: null,
    paneDialog: null,
  };
}

/**
 * The run the preview's workflow panel is drawn from.
 *
 * A SUMMARY, and there is no run behind it - which is why the preview passes
 * `workflowStageDetail="summary"` and the panel draws its own settled placeholder from
 * these fields: the workflow's name, version, run state and round, over the disclosure
 * control. That is the shape the `Workflow` checkbox governs, drawn by the real component,
 * and it costs no request. Letting it fetch instead would GET an id the daemon can only
 * 404, every time an operator opens Settings, to arrive at the same placeholder.
 *
 * Preferred over the two alternatives. Drawing a mock ladder here would be the second
 * source of truth this feature exists to remove, and threading a fabricated
 * `WorkflowRunDetail` into the panel would mean inventing a whole run's stages, personas
 * and deliveries to decorate a preview.
 */
export const PREVIEW_WORKFLOW_RUN: WorkflowRunSummary = {
  id: "board-card-preview-run",
  bindingId: "board-card-preview-binding",
  workflowId: "board-card-preview-workflow",
  workflowName: "No-Mistakes Review",
  workflowVersion: 4,
  sessionId: PREVIEW_SESSION_ID,
  noteKey: "board-card-preview-note",
  status: "running",
  phase: "review",
  round: 1,
  maxRepairRounds: 5,
  activePersonaNames: ["Inspector"],
  failedPersonaCount: 0,
  bypassedPersonaReview: false,
  gate: "none",
  gatePrNumber: null,
  gateHeadShort: null,
  reviewPosture: null,
  uncertainDeliveryCount: 0,
  refusedDeliveryCount: 0,
  updatedAt: 0,
};
