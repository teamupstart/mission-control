import { createHash } from "node:crypto";
import { gitInfo } from "../util/git.ts";
import type { UpdateWorkflowCommand } from "@shared/protocol.ts";
import type {
  WorkflowBinding,
  WorkflowCommandView,
  WorkflowRun,
} from "@shared/workflow.ts";
import type { ReviewItem } from "@shared/types.ts";
import type { Registry } from "../registry.ts";
import { WorkflowStore } from "./store.ts";
import type { WorkflowCommandStoreWrite } from "./store.ts";
import { dropLegacyCheckCommands, legacyCheckCommandsToImport } from "./config.ts";
import type { LegacyCheckCommand } from "./config.ts";
import { workflowLog } from "./log.ts";

export type WorkflowCommandMutation = WorkflowCommandStoreWrite;

/** What a session asked to configure, after the route established it owns `run`. */
export interface ConfigureRepositoryCommandInput {
  /** The store that holds `run`: its attempts, budget reservations and event ledger. */
  runs: WorkflowStore;
  run: WorkflowRun;
  binding: WorkflowBinding;
  slot: string;
  command: readonly string[];
  sessionId: string;
  /** The calling session's reviews, answered ones included; see `operatorConfirmation`. */
  reviews: readonly ReviewItem[];
  /**
   * Raise the confirmation card on the calling session and return its review id. The DAEMON
   * creates it, so its id - recorded on the run - is the provenance a session cannot forge.
   */
  requestConfirmation?: (card: CommandConfirmationCard) => string;
  now?: number;
}

export type ConfigureRepositoryCommandResult =
  | {
      ok: true;
      view: WorkflowCommandView;
      repoRoot: string;
      forgiven: number;
      restored: number;
      /** The answer this write spent, or null when nothing was written. */
      confirmationReviewId: string | null;
    }
  | {
      ok: false;
      reason: "finished" | "no_repository" | "check_running" | "unconfirmed" | "not_found" | "conflict" | "refused";
      message: string;
      /** On `unconfirmed`: the card to show the operator, which `configure_workflow_command` does. */
      confirmation?: CommandConfirmationCard;
      /** On `unconfirmed`: the daemon-created review carrying that card, for the tool to wait on. */
      confirmationReviewId?: string;
    };

/** The option an operator picks on a confirmation card to authorize the write. */
export const CONFIGURE_COMMAND_OPTION_ID = "configure";

/** The `request_input` card that authorizes exactly one repository Command change. */
export interface CommandConfirmationCard {
  title: string;
  question: string;
  decision: {
    id: string;
    question: string;
    options: Array<{ id: string; label: string; detail?: string; recommended?: boolean }>;
  };
}

/**
 * The card an operator answers to authorize one repository Command change, composed by the
 * daemon and never by the session.
 *
 * It names the run, the slot, the repository and the argv as a JSON array. A space-joined
 * label is not an argv: `["./tools/run checks", "test"]` and `["./tools/run", "checks test"]`
 * read the same and start different programs. The decision id carries a digest of all four,
 * and verification recomputes the whole card, so an answer authorizes this change and nothing
 * else - not another run, slot, repository or argv, and not a card the session phrased itself.
 */
export function commandConfirmationCard(input: {
  runId: string;
  slot: string;
  repoRoot: string;
  command: readonly string[];
}): CommandConfirmationCard {
  const argv = JSON.stringify(input.command);
  const digest = createHash("sha256")
    .update(JSON.stringify([input.runId, input.slot, input.repoRoot, input.command]))
    .digest("hex")
    .slice(0, 32);
  const question = [
    `Set the ${input.slot} workflow Command for this repository?`,
    "",
    `Repository: ${input.repoRoot}`,
    `Slot: ${input.slot}`,
    `Workflow run: ${input.runId}`,
    `Command (exact argv, one JSON string per argument): ${argv}`,
    "",
    `Mission Control will run this argv for the ${input.slot} gate in this repository's workflow `
      + "checks. It replaces this repository's override in Library › Commands; the machine-wide "
      + "default is unchanged.",
  ].join("\n");
  return {
    title: `Confirm the ${input.slot} Command for this repository`,
    question,
    decision: {
      id: `configure-command:${digest}`,
      question,
      options: [
        { id: CONFIGURE_COMMAND_OPTION_ID, label: "Configure this Command", detail: argv, recommended: true },
        { id: "decline", label: "Don't configure it" },
      ],
    },
  };
}

/**
 * The operator's answer authorizing `card`, or null when there is none.
 *
 * The daemon's own check, so the repair packet's "confirm it with the operator first" is not
 * text a misled or prompt-injected session could skip. A review counts only when it:
 *
 * - is a `request_input` card (`kind: "input"`) whose title, body and single decision - id,
 *   question and options - are exactly this card's, so it is about this run, slot, repository
 *   and argv and says nothing else to the operator;
 * - was answered by the human (`resolvedBy: "human"`), not Foreman, a standing approval or a
 *   controlling session, after this workflow run started;
 * - chose "Configure this Command".
 */
export function operatorConfirmation(
  reviews: readonly ReviewItem[],
  card: CommandConfirmationCard,
  since: number,
): ReviewItem | null {
  const expected = JSON.stringify(card.decision);
  for (const review of reviews) {
    if (review.kind !== "input" || review.status !== "answered" || review.resolvedBy !== "human") continue;
    if ((review.resolvedAt ?? 0) < since) continue;
    // The heading and paragraph the operator read must be the daemon's too, so a session that
    // copies the decision under a misleading title or body has authorized nothing.
    if (review.title !== card.title || review.body !== card.question) continue;
    const decision = review.decisions?.length === 1 ? review.decisions[0]! : null;
    if (!decision || decision.id !== card.decision.id) continue;
    const shown = JSON.stringify({
      id: decision.id,
      question: decision.question,
      options: decision.options.map((option) => ({
        id: option.id,
        label: option.label,
        ...(option.detail === undefined ? {} : { detail: option.detail }),
        ...(option.recommended === undefined ? {} : { recommended: option.recommended }),
      })),
    });
    if (shown !== expected) continue;
    const answer = review.selections?.find((selection) => selection.decisionId === decision.id);
    if (answer?.selected.length === 1 && answer.selected[0] === CONFIGURE_COMMAND_OPTION_ID) return review;
  }
  return null;
}

/**
 * Ownership of the Global Command catalog: what each portable workflow slot runs here.
 *
 * The `PersonaManager` / `SessionActionManager` shape, minus creation and archival, because
 * the slots are built in: nothing here mints an id or retires a row. What it keeps is
 * the part those two exist for - one place that turns a validated request into a committed
 * store write and exactly one Registry emit AFTER the commit, so no browser ever sees a slot
 * the database does not hold.
 *
 * The legacy import runs in the constructor, before the Registry is initialized, so the very
 * first snapshot a browser receives already reflects the migrated catalog rather than an
 * empty one that fills in later.
 */
export class WorkflowCommandManager {
  constructor(
    private readonly registry: Registry,
    readonly store = new WorkflowStore(),
    now = Date.now(),
  ) {
    this.migrateLegacyCommands(now);
    registry.initializeWorkflowCommands(this.store.workflowCommandCatalog());
  }

  /** All built-in slots, in registry order, configured or not. */
  list(): WorkflowCommandView[] {
    return this.store.workflowCommandCatalog();
  }

  get(slot: string): WorkflowCommandView | null {
    return this.store.getWorkflowCommand(slot);
  }

  /** Replace one slot's default and complete override list under its expected revision. */
  replace(
    slot: string,
    input: UpdateWorkflowCommand,
    now = Date.now(),
  ): WorkflowCommandMutation {
    if (slot === "coderabbit" && input.overrides.some((rule) => gitInfo(rule.repoRoot).root !== rule.repoRoot)) {
      return { ok: false, reason: "invalid_recipe", current: this.get(slot) };
    }
    return this.publish(this.store.replaceWorkflowCommandCas(
      slot,
      input.expectedRevision,
      {
        defaultCommand: input.defaultCommand,
        overrides: input.overrides,
        maxRuns: input.maxRuns,
        timeoutMs: input.timeoutMs,
        onUnavailable: input.onUnavailable,
        onBudgetExhausted: input.onBudgetExhausted,
      },
      now,
    ));
  }

  /**
   * The compatibility adapter for `PUT /api/workflows/config`: the WHOLE legacy save.
   *
   * Takes the policy write as a callback rather than doing the two halves in sequence, because
   * the old route's contract is that its body is one object. `checkCommands` now belongs to
   * this catalog and everything else to the `workflows` config blob - two owners, one database
   * file - and committing the catalog while the policy write failed would report a refusal
   * over a change that had already happened. The operator is told the save failed, reloads,
   * and sees half of it applied; the half they can see is the half that runs commands.
   *
   * So both go inside ONE transaction, and `persistPolicy` throwing rolls the commands back
   * with it. The callback is the honest shape for that: the store cannot know what a policy is,
   * and the route cannot own a transaction boundary without reaching past both managers.
   *
   * Events are emitted only after the commit returns, and only for slots that actually moved,
   * so a rolled-back save publishes nothing and a save that merely toggled a switch is silent.
   */
  saveLegacyConfig(
    legacy: readonly LegacyCheckCommand[],
    persistPolicy: () => void,
    now = Date.now(),
  ): void {
    const changed = this.store.transact(() => {
      const views = this.store.replaceLegacyCommandOverridesInTransaction(legacy, now);
      persistPolicy();
      return views;
    });
    for (const view of changed) this.registry.upsertWorkflowCommand(view);
  }

  /**
   * Set one slot's Command for the repository a workflow run reviews, on a session's behalf.
   *
   * The route has already established that the caller owns `run`; everything that decides
   * whether the write may happen, and what it does to the run, lives here:
   *
   * - refused for a finished run, a run with no repository, and while a check for this slot is
   *   still running in the run (its outcome decides whether its reservation is forgiven, and
   *   nothing awaits between this test and the write, so no check can start in between);
   * - refused unless the operator chose "Configure this Command" on the confirmation card the
   *   daemon itself raised for exactly this run, slot, repository and argv; the refusal raises
   *   that card through `requestConfirmation`, records its review id on the run as provenance,
   *   and returns the id for the tool to wait on;
   * - writes that repository's override, never the machine-wide default; when the override
   *   already equals the argv it writes nothing and needs no answer; each answer authorizes
   *   one write and is spent by it; one retry absorbs a concurrent save;
   * - then re-scopes the run budget through `forgiveCheckRuns` and records the change.
   */
  configureRepositoryCommand(input: ConfigureRepositoryCommandInput): ConfigureRepositoryCommandResult {
    const { runs, run, binding, slot, command } = input;
    const now = input.now ?? Date.now();
    if (["completed", "cancelled", "failed"].includes(run.status)) {
      return { ok: false, reason: "finished", message: "This workflow run has finished; configure the Command in Library › Commands" };
    }
    const repoRoot = binding.sessionRepoRoot;
    if (!repoRoot) {
      return { ok: false, reason: "no_repository", message: "This workflow run reported no repository to configure" };
    }
    const slotNodes = new Set((runs.getWorkflowVersionById(run.workflowVersionId)?.graph.nodes ?? [])
      .filter((node) => node.kind === "check" && node.slot === slot).map((node) => node.id));
    if (runs.listAttemptsForRun(run.id).some((attempt) => attempt.state === "running" && slotNodes.has(attempt.nodeId))) {
      return {
        ok: false,
        reason: "check_running",
        message: `A ${slot} check is still running in this workflow run; configure the Command after it finishes`,
      };
    }
    const isArgv = (candidate: readonly string[]) => candidate.length === command.length
      && candidate.every((arg, index) => arg === command[index]);
    const already = (view: WorkflowCommandView) =>
      view.overrides.some((entry) => entry.repoRoot === repoRoot && isArgv(entry.command));
    const current = this.get(slot);
    if (!current) return { ok: false, reason: "not_found", message: "no such command slot" };
    // Already this repository's Command: there is nothing to write, so nothing to authorize and
    // nothing to re-scope. Answering it costs no confirmation and spends none.
    if (already(current)) {
      return { ok: true, view: current, repoRoot, forgiven: 0, restored: 0, confirmationReviewId: null };
    }
    const card = commandConfirmationCard({ runId: run.id, slot, repoRoot, command });
    // Each answer authorizes ONE write. An answer an earlier write in this run already used is
    // spent, so if the operator later changes the override in Library, re-proposing the old argv
    // needs a fresh answer rather than silently undoing their edit.
    const spent = new Set(runs.listEvents(run.id)
      .filter((event) => event.kind === "workflow_command_configured")
      .map((event) => (event.payload as { confirmationReviewId?: unknown } | null)?.confirmationReviewId)
      .filter((id): id is string => typeof id === "string"));
    // Only a card the DAEMON raised for exactly this change counts: its review id is recorded on
    // the run when it is created, and a session has no way to append run events. A session that
    // copies the card into a `request_input` review of its own has authorized nothing.
    const events = runs.listEvents(run.id);
    const issued = new Set(events
      .filter((event) => event.kind === "workflow_command_confirmation_requested")
      .map((event) => event.payload as { reviewId?: unknown; decisionId?: unknown } | null)
      .filter((payload) => payload?.decisionId === card.decision.id && typeof payload.reviewId === "string")
      .map((payload) => payload!.reviewId as string));
    const confirmation = operatorConfirmation(
      input.reviews.filter((review) => issued.has(review.id) && !spent.has(review.id)),
      card,
      run.startedAt,
    );
    if (!confirmation) {
      const reviewId = input.requestConfirmation?.(card);
      if (reviewId && !issued.has(reviewId)) {
        runs.appendEvent(run.id, "workflow_command_confirmation_requested", {
          reviewId, decisionId: card.decision.id, slot, repoRoot, command: [...command], sessionId: input.sessionId,
        }, now);
      }
      return {
        ok: false,
        reason: "unconfirmed",
        message: `The operator has not confirmed ${JSON.stringify(command)} as the ${slot} Command for `
          + "this repository. configure_workflow_command shows them the confirmation card and waits.",
        confirmation: card,
        ...(reviewId ? { confirmationReviewId: reviewId } : {}),
      };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = this.get(slot);
      if (!view) return { ok: false, reason: "not_found", message: "no such command slot" };
      // A concurrent save already made it so: nothing written, so the answer is not spent.
      if (already(view)) {
        return { ok: true, view, repoRoot, forgiven: 0, restored: 0, confirmationReviewId: null };
      }
      const result = this.replace(slot, {
        expectedRevision: view.revision,
        defaultCommand: view.defaultCommand,
        overrides: [...view.overrides.filter((entry) => entry.repoRoot !== repoRoot), { repoRoot, command: [...command] }],
        maxRuns: view.maxRuns,
        timeoutMs: view.timeoutMs,
        onUnavailable: view.onUnavailable,
        onBudgetExhausted: view.onBudgetExhausted,
      }, now);
      if (!result.ok && result.reason === "revision_conflict") continue;
      if (!result.ok) return { ok: false, reason: "refused", message: result.reason.replaceAll("_", " ") };
      const { forgiven, restored } = runs.forgiveCheckRuns(run.id, slot, command);
      runs.appendEvent(run.id, "workflow_command_configured", {
        slot, repoRoot, command: [...command], forgivenRuns: forgiven, restoredRuns: restored,
        sessionId: input.sessionId, confirmationReviewId: confirmation.id,
      }, now);
      return { ok: true, view: result.view, repoRoot, forgiven, restored, confirmationReviewId: confirmation.id };
    }
    return { ok: false, reason: "conflict", message: "The Command changed concurrently; read it again and retry" };
  }

  private publish(result: WorkflowCommandStoreWrite): WorkflowCommandMutation {
    // Only after a committed mutation. A refusal has changed nothing, and emitting on one
    // would make every open window redraw a slot that did not move.
    if (result.ok) this.registry.upsertWorkflowCommand(result.view);
    return result;
  }

  /**
   * Copy the old `WorkflowConfig.checkCommands` list into the catalog exactly once.
   *
   * Gated inside the store on the catalog being empty, so a restart is a no-op and a catalog
   * an operator has since edited - including one they emptied - is never overwritten from a
   * stale blob. Overrides only: no global default is inferred from a repository's command.
   *
   * A throw here would take daemon startup down over a settings blob, so it is caught and
   * logged. The consequence of a failed import is a catalog with no commands and a Settings
   * form that still shows and saves them, which is recoverable; a daemon that will not start
   * is not.
   */
  private migrateLegacyCommands(now: number): void {
    try {
      const legacy = legacyCheckCommandsToImport();
      const imported = this.store.importLegacyCommandOverrides(legacy, now);
      if (!imported) return;
      dropLegacyCheckCommands();
      if (legacy.length > 0) {
        workflowLog("info", { event: "workflow_commands_migrated", state: legacy.length });
      }
    } catch (error) {
      workflowLog("error", {
        event: "workflow_commands_migration_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
