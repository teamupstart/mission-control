import { EXPERIENCE_EVENTS, EXPERIENCE_METRICS } from "./experience.ts";
import { WORKFLOW_EVENTS, WORKFLOW_METRICS } from "./workflows.ts";
import { ACTION_RESULT_EVENT, ACTION_METRICS } from "./actions.ts";
import { HEALTH_EVENT, HEALTH_METRICS } from "./health.ts";
/** Phase 5 owns additional source catalog registration here. */
export const SOURCE_EVENTS = [...WORKFLOW_EVENTS, ACTION_RESULT_EVENT, ...EXPERIENCE_EVENTS, HEALTH_EVENT];
export const SOURCE_METRICS = [...WORKFLOW_METRICS, ...ACTION_METRICS, ...EXPERIENCE_METRICS, ...HEALTH_METRICS];
