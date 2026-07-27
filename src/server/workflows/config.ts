import type { WorkflowConfigInput } from "@shared/protocol.ts";
import { StoredWorkflowConfigSchema, WorkflowConfigSchema } from "@shared/protocol.ts";
import type { WorkflowConfig } from "@shared/workflow.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

const CONFIG_KEY = "workflows";

/**
 * Machine-wide consent for workflow prompt delivery and for running check commands.
 * Disabled and empty by default.
 *
 * Reads through the TOLERANT schema, which the write below deliberately does not: this
 * function is called on every binding gate, every delivery decision, every check and the
 * retention sweep, so a stored value this build cannot parse must degrade to the shipped
 * defaults rather than take all of them down. `setWorkflowConfig` still refuses a bad
 * write, so the only way to reach the fallback is a blob some other build wrote.
 */
export function getWorkflowConfig(): WorkflowConfig {
  return StoredWorkflowConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/** Replace the complete small config object so allowlist removals cannot be lost in a merge. */
export function setWorkflowConfig(input: WorkflowConfigInput): WorkflowConfig {
  const next = WorkflowConfigSchema.parse(input);
  setAppConfig(CONFIG_KEY, next);
  return next;
}
