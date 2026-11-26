import { LOCAL_INSPECTOR_FLAG_ID } from "@shared/feature-flag-registry.ts";
import { WORKFLOW_CHECK_SLOTS } from "@shared/workflow.ts";
import { useFeatureFlag } from "../useFeatureFlag.ts";

const ordinarySlots = WORKFLOW_CHECK_SLOTS.filter(slot => slot !== "inspector");

export function useWorkflowCommandSlots() {
  return useFeatureFlag(LOCAL_INSPECTOR_FLAG_ID) ? WORKFLOW_CHECK_SLOTS : ordinarySlots;
}
