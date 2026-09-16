import { WORKFLOW_EVENTS, WORKFLOW_METRICS } from "./workflows.ts";
import { ACTION_RESULT_EVENT, ACTION_METRICS } from "./actions.ts";
/** Phase 5 owns additional source catalog registration here. */
export const SOURCE_EVENTS = [...WORKFLOW_EVENTS, ACTION_RESULT_EVENT];
export const SOURCE_METRICS = [...WORKFLOW_METRICS, ...ACTION_METRICS];
