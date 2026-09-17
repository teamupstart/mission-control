import { EXPERIENCE_EVENTS, EXPERIENCE_METRICS } from "./experience.ts";
import { WORKFLOW_EVENTS, WORKFLOW_METRICS } from "./workflows.ts";
import { ACTION_RESULT_EVENT, ACTION_METRICS } from "./actions.ts";
/** Phase 5 owns additional source catalog registration here. */
export const SOURCE_EVENTS = [...WORKFLOW_EVENTS, ACTION_RESULT_EVENT, ...EXPERIENCE_EVENTS];
export const SOURCE_METRICS = [...WORKFLOW_METRICS, ...ACTION_METRICS, ...EXPERIENCE_METRICS];
