import type { WorkflowPolicyInput } from "@shared/protocol.ts";
import { StoredWorkflowPolicySchema, WorkflowPolicySchema } from "@shared/protocol.ts";
import type { WorkflowCheckSlot, WorkflowPolicy } from "@shared/workflow.ts";
import { WORKFLOW_CHECK_SLOTS } from "@shared/workflow.ts";
import { WorkflowCheckCommandSchema } from "@shared/protocol.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

const CONFIG_KEY = "workflows";

/**
 * Machine-wide consent for workflow prompt delivery and for running Commands, plus the
 * dispatch default and retention. POLICY only: the commands themselves moved to their own
 * catalog, and this blob is no longer a place one can be stored.
 *
 * Reads through the TOLERANT schema, which the write below deliberately does not: this
 * function is called on every binding gate, every delivery decision, every check and the
 * retention sweep, so a stored value this build cannot parse must degrade to the shipped
 * defaults rather than take all of them down. `setWorkflowPolicy` still refuses a bad
 * write, so the only way to reach the fallback is a blob some other build wrote.
 */
export function getWorkflowPolicy(): WorkflowPolicy {
  return StoredWorkflowPolicySchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

export function resolveTaskWorkflowId(workflowId: string | null | undefined): string | null {
  return workflowId === undefined ? getWorkflowPolicy().defaultWorkflowId : workflowId;
}

/**
 * Replace the complete small policy object so allowlist removals cannot be lost in a merge.
 *
 * Any legacy `checkCommands` on the input is validated by the caller's schema and then
 * dropped here rather than persisted: the catalog is the only durable command authority, and
 * writing a second copy under this key is exactly the drift this split exists to prevent.
 */
export function setWorkflowPolicy(input: WorkflowPolicyInput): WorkflowPolicy {
  const next = WorkflowPolicySchema.parse(input);
  setAppConfig(CONFIG_KEY, next);
  return next;
}

/** One legacy `checkCommands` row that survived validation, ready to become an override. */
export interface LegacyCheckCommand {
  slot: WorkflowCheckSlot;
  repoRoot: string;
  command: string[];
}

/**
 * The valid legacy command rows in the stored config blob, for the one-time import.
 *
 * Deliberately NOT `getWorkflowPolicy`, and not the tolerant config schema either. Both
 * answer a whole-blob question - "is this readable?" - and both would report an otherwise
 * fine config with one bad row as having no commands at all, silently dropping every good
 * row beside it. This walks the array and keeps each entry that parses, which is the only
 * reading under which a partially invalid blob loses exactly the rows that were invalid.
 *
 * A blob that is not an object, or whose `checkCommands` is not an array, yields none. That
 * is a migration that fails closed: no commands are imported, nothing is destroyed, and the
 * operator's next save through Settings writes what they can see.
 */
export function legacyCheckCommandsToImport(
  blob: unknown = getAppConfig<unknown>(CONFIG_KEY),
): LegacyCheckCommand[] {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return [];
  const raw = (blob as { checkCommands?: unknown }).checkCommands;
  if (!Array.isArray(raw)) return [];
  const out: LegacyCheckCommand[] = [];
  for (const entry of raw) {
    const parsed = WorkflowCheckCommandSchema.safeParse(entry);
    if (!parsed.success) continue;
    out.push({
      slot: parsed.data.slot,
      repoRoot: parsed.data.repoRoot,
      command: parsed.data.command,
    });
  }
  // Registry slot order, so an import is reproducible rather than dependent on how the old
  // array happened to be appended to.
  return out.sort((a, b) =>
    WORKFLOW_CHECK_SLOTS.indexOf(a.slot) - WORKFLOW_CHECK_SLOTS.indexOf(b.slot));
}

/**
 * Drop the legacy command list out of the stored blob once it has been imported.
 *
 * Not strictly required - the policy schema already ignores the field on read, and the next
 * policy write would drop it - but leaving it on disk keeps a second copy of executable
 * configuration lying around that a future reader could mistake for live. Skipped entirely
 * when the blob is not a plain object, because rewriting something this build cannot read is
 * how an operator's settings get destroyed by a migration.
 */
export function dropLegacyCheckCommands(): void {
  const blob = getAppConfig<unknown>(CONFIG_KEY);
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return;
  if (!("checkCommands" in blob)) return;
  const { checkCommands: _dropped, ...rest } = blob as Record<string, unknown>;
  setAppConfig(CONFIG_KEY, rest);
}
