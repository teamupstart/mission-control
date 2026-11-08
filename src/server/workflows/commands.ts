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
  now?: number;
}

export type ConfigureRepositoryCommandResult =
  | {
      ok: true;
      view: WorkflowCommandView;
      repoRoot: string;
      forgiven: number;
      restored: number;
      confirmationReviewId: string;
    }
  | {
      ok: false;
      reason: "finished" | "no_repository" | "check_running" | "unconfirmed" | "not_found" | "conflict" | "refused";
      message: string;
    };

/** The argv as an operator reads it on a card: arguments joined by single spaces. */
export function commandText(command: readonly string[]): string {
  return command.join(" ");
}

function normalizedAnswer(value: string): string {
  return value.trim().replace(/^[`'"]+|[`'"]+$/g, "").replace(/\s+/g, " ");
}

/**
 * The operator's answer that confirms exactly `command`, or null when there is none.
 *
 * The daemon's own check, so the repair packet's "confirm it with the operator first" is not
 * only text a misled or prompt-injected session could skip. It looks for a `request_input`
 * card on THIS session that:
 *
 * - was answered by the human (`resolvedBy: "human"`), not Foreman, a standing approval or
 *   a controlling session;
 * - was answered after this workflow run started, so an old answer cannot authorize a new run;
 * - chose exactly this argv: a selected option label, the "Other" text, or a free-text answer
 *   equal to the arguments joined by single spaces (surrounding backticks or quotes allowed).
 *
 * Text that merely mentions the argv, such as the question itself, confirms nothing, and
 * neither does picking a different option on a card that offered it.
 */
export function operatorConfirmation(
  reviews: readonly ReviewItem[],
  command: readonly string[],
  since: number,
): ReviewItem | null {
  const wanted = commandText(command);
  for (const review of reviews) {
    if (review.kind !== "input" || review.status !== "answered" || review.resolvedBy !== "human") continue;
    if ((review.resolvedAt ?? 0) < since) continue;
    const answers: string[] = [];
    if (review.decisions?.length) {
      for (const selection of review.selections ?? []) {
        const decision = review.decisions.find((item) => item.id === selection.decisionId);
        for (const option of decision?.options ?? []) {
          if (selection.selected.includes(option.id)) answers.push(option.label);
        }
        if (selection.other) answers.push(selection.other);
      }
    } else if (review.response) {
      answers.push(review.response);
    }
    if (answers.some((answer) => normalizedAnswer(answer) === wanted)) return review;
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
   * - refused unless the operator picked exactly this argv on one of the session's
   *   `request_input` cards (`operatorConfirmation`);
   * - writes that repository's override, never the machine-wide default, and writes nothing
   *   when the override already equals the argv; one retry absorbs a concurrent save;
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
    const confirmation = operatorConfirmation(input.reviews, command, run.startedAt);
    if (!confirmation) {
      return {
        ok: false,
        reason: "unconfirmed",
        message: `The operator has not confirmed \`${commandText(command)}\`. Ask with request_input, `
          + `offering exactly "${commandText(command)}" as an option, and configure it only after they pick it.`,
      };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = this.get(slot);
      if (!view) return { ok: false, reason: "not_found", message: "no such command slot" };
      const existing = view.overrides.find((entry) => entry.repoRoot === repoRoot);
      const unchanged = existing !== undefined && existing.command.length === command.length
        && existing.command.every((arg, index) => arg === command[index]);
      const result: WorkflowCommandMutation = unchanged ? { ok: true, view } : this.replace(slot, {
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
