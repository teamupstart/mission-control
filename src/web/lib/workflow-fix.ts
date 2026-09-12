import type { WorkflowLaunchFix } from "@shared/workflow.ts";
import type { SettingsCategoryId } from "./settings-registry.ts";

/**
 * The door a refused launch offers: what to call it, and where it opens.
 *
 * One record rather than a label beside the refusal and a destination beside the navigator,
 * because those are two halves of the same promise - a control that says "Trust" and lands
 * anywhere else is worse than no control. The daemon names the `fix`; this says what that
 * name means to a reader and to the router.
 */
export interface WorkflowLaunchFixDoor {
  label: string;
  tooltip: string;
  category: SettingsCategoryId;
  anchor: string;
}

export const WORKFLOW_LAUNCH_FIX_DOORS: Record<WorkflowLaunchFix, WorkflowLaunchFixDoor> = {
  // The per-repository half. This is the one an operator meets on a fresh install, where the
  // machine-wide switch already ships on and the allowlist ships empty, so the grant they are
  // missing is always this one and the sentence alone never said where it is made.
  "workflow-repo-trust": {
    label: "Grant it in Trust",
    tooltip: "Open the Trust matrix and grant this repository the Workflows cell",
    category: "trust",
    anchor: "trust/matrix",
  },
  // The machine-wide half, which is a switch and not a grant, so it is a different screen.
  "workflow-live-delivery": {
    label: "Turn on Live delivery",
    tooltip: "Open Settings, Workflows, where Live delivery is switched on",
    category: "workflows",
    anchor: "workflows/live-delivery",
  },
};
