import type { WorkflowPolicyInput } from "@shared/protocol.ts";
import { StoredWorkflowPolicySchema, WorkflowPolicySchema } from "@shared/protocol.ts";
import type { WorkflowCheckSlot, WorkflowPolicy } from "@shared/workflow.ts";
import { WORKFLOW_CHECK_SLOTS } from "@shared/workflow.ts";
import { WorkflowCheckCommandSchema } from "@shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.workflows;

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
  return StoredWorkflowPolicySchema.parse(keepPreFieldCommandConsent(getAppConfig(CONFIG_ENTRY)));
}

/**
 * Hold `checksEnabled` at off for a config written before the field existed.
 *
 * The default now ships ON, and that is a decision about a FRESH install: it arrives with an
 * empty `repoAllowlist`, so it can run nothing until a human grants a repository through
 * Trust - and Trust's Workflows cell says in full that the grant covers Commands running
 * against branch code. The person who arms it is told what they are arming.
 *
 * An older stored blob is the case that reasoning does not cover. It can already carry
 * grants, made against a build where this switch was off and where the grant therefore could
 * not run anything on its own. Letting `.default()` fill the missing key would arm command
 * execution in those repositories on upgrade, with no interaction at all - which is the one
 * thing every gate around this feature exists to prevent. So the absence of the key is read
 * as what it actually is: a build that predates the switch, whose operator was never asked.
 *
 * Precise rather than heuristic. Every write goes through `setWorkflowPolicy`, which persists
 * the whole parsed policy, so any config saved since the field shipped OWNS the key - as
 * `false` if they left it off, which is preserved here by the same rule. A missing key means
 * pre-field, and nothing else. An operator who wants it on flips the switch, which is the
 * interaction this is protecting.
 *
 * Read-time and never written back. A migration that rewrites the row would have to do it
 * from a path called on every binding gate, delivery decision, check and retention sweep;
 * normalizing the value on the way past is idempotent and cannot damage a blob this build
 * only partly understands - the same restraint `dropLegacyCheckCommands` shows below.
 */
function keepPreFieldCommandConsent(blob: unknown): unknown {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return blob ?? {};
  if (Object.prototype.hasOwnProperty.call(blob, "checksEnabled")) return blob;
  return { ...(blob as Record<string, unknown>), checksEnabled: false };
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
  setAppConfig(CONFIG_ENTRY, next);
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
  blob: unknown = getAppConfig(CONFIG_ENTRY),
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
  const blob = getAppConfig(CONFIG_ENTRY);
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return;
  if (!("checkCommands" in blob)) return;
  const { checkCommands: _dropped, ...rest } = blob as Record<string, unknown>;
  // This compatibility rewrite intentionally preserves a partially unreadable older blob.
  // The descriptor still closes the key space; the value cast is local to this migration.
  setAppConfig(CONFIG_ENTRY, rest as never);
}
