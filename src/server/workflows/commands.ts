import type { UpdateWorkflowCommand } from "@shared/protocol.ts";
import type { WorkflowCommandView } from "@shared/workflow.ts";
import type { Registry } from "../registry.ts";
import { WorkflowStore } from "./store.ts";
import type { WorkflowCommandStoreWrite } from "./store.ts";
import { dropLegacyCheckCommands, legacyCheckCommandsToImport } from "./config.ts";
import type { LegacyCheckCommand } from "./config.ts";
import { workflowLog } from "./log.ts";

export type WorkflowCommandMutation = WorkflowCommandStoreWrite;

/**
 * Ownership of the Global Command catalog: what each portable workflow slot runs here.
 *
 * The `PersonaManager` / `SessionActionManager` shape, minus creation and archival, because
 * the four slots are built in: nothing here mints an id or retires a row. What it keeps is
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

  /** All four built-in slots, in registry order, configured or not. */
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
    return this.publish(this.store.replaceWorkflowCommandCas(
      slot,
      input.expectedRevision,
      { defaultCommand: input.defaultCommand, overrides: input.overrides },
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
