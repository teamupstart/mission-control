import type { WorkflowRunIntentInput } from "../../src/server/workflows/intent-fingerprint.ts";

/**
 * The frozen ask an ordinary fixture run was created under.
 *
 * Run creation requires a real snapshot, because creation is the one moment a run's ask can
 * honestly be captured and a run that cannot supply one must not exist. Most fixtures here are
 * not about intent at all - they need a run so they can test listing, delivery, gates, or
 * eviction - so they carry this rather than inventing one each time, and they are ordinary
 * modern runs as a result.
 *
 * A fixture that genuinely wants the PRE-MIGRATION shape does not use this and does not ask
 * creation for it. It demotes a row instead, by nulling `intent_json`, which is exactly what a
 * daemon upgrade leaves behind and the only way that shape is reachable.
 *
 * There is deliberately no `fingerprint` here. An earlier version carried an arbitrary 64
 * hex characters unrelated to its goal, which was a working demonstration that a caller could
 * mint an internally inconsistent snapshot. The store derives the identity now, so the fixture
 * has nothing to get wrong.
 */
export const FIXTURE_RUN_INTENT: WorkflowRunIntentInput = {
  rawGoal: "Fixture run: the ask this run was created under",
  refinedGoal: null,
  sourceNoteKey: "fixture-note",
  decisions: [],
  frozenAt: 1,
};
