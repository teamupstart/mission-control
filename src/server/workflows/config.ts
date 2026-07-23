import type { WorkflowConfigInput } from "@shared/protocol.ts";
import { WorkflowConfigSchema } from "@shared/protocol.ts";
import type { WorkflowConfig } from "@shared/workflow.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

const CONFIG_KEY = "workflows";

/** Machine-wide consent for workflow prompt delivery. Disabled and empty by default. */
export function getWorkflowConfig(): WorkflowConfig {
  return WorkflowConfigSchema.parse(getAppConfig<unknown>(CONFIG_KEY) ?? {});
}

/** Replace the complete small config object so allowlist removals cannot be lost in a merge. */
export function setWorkflowConfig(input: WorkflowConfigInput): WorkflowConfig {
  const next = WorkflowConfigSchema.parse(input);
  setAppConfig(CONFIG_KEY, next);
  return next;
}
