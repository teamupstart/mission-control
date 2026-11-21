// One table over every exported schema in src/shared/home-dispatch.ts: each has at least one
// payload it must accept and one it must refuse. A schema added without a row fails the
// completeness test, so no contract ships unparsed.
import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../src/shared/home-dispatch.ts";

const counts = { waiting: 0, blocked: 0, ready: 0, running: 1, queued: 0, shelved: 0, failed: 0 };
const registration = {
  sessionId: "s1", harness: "claude", cwd: "/repo", clientVersion: "1.0.0", source: "startup",
  entrypoint: null, interactive: true, beforeFirstPrompt: true, launcherDisabled: false,
};
const reviewer = { name: "Codex", runner: "codex", model: null, state: "running", attempt: 1, startedAt: 1, endedAt: null, failure: null };
const item = {
  taskId: "t1", title: "Fix it", kind: "bugfix", state: "running", origin: "mctl", changedAt: 1,
  canMessage: true, agent: "claude", runtime: null,
};
const target = { taskId: "t1", reviewId: "r1", sessionId: "s1" };
const resident = {
  runId: "run1", taskId: "t1", name: "Observer", builtIn: false, repos: 1, loopState: "waiting", needsYou: false, iteration: 0,
  nextWakeAt: null, pauseReason: null, wakeReason: null, runRequestedAt: null, contextPercent: null, costUsd: null,
};
const message = { id: "m1", role: "user", text: "hi", tools: [], ts: 0 };
const subagentLine = { type: "mission-explorer", state: "running", elapsedMs: 0, description: null };
const question = { id: "kind", header: "Kind", question: "What kind?", options: [{ value: "ship", label: "Ship" }] };
const pair = { model: null, transport: "exec" };
const readiness = {
  checkedAt: null, stale: true, accountChangeVisible: false, accountVerified: false,
  observed: { codexPath: null, binarySize: null, binaryMtime: null, authMtime: null, codexVersion: null, account: null },
  required: false, canStart: false, reviewPath: null, reviewsReady: false, workflows: [], reviewerSet: [pair],
  checks: [{ id: "codex-cli", level: "prerequisite", ok: null, required: true, detail: "x", fix: null }],
};
const draftSummary = {
  draftId: "d1", repoRoot: "/repo", kind: "ship", kindLabel: "Ship", afterWork: "None", afterWorkApplies: true,
  words: "w", context: null, needs: [], brief: "w", text: "t",
};

/** [schema name, a payload it accepts, a payload it refuses]. */
const TABLE: Array<[string, unknown, unknown]> = [
  ["HomeDispatchCallerSchema", { sessionId: "s1" }, {}],
  ["HomeSessionRegistrationSchema", registration, { ...registration, harness: "codex" }],
  ["HomeSessionRegistrationAnswerSchema",
    { sessionId: "s1", repoRoot: null, created: true, offerLauncher: false, counts: { running: 0, waiting: 0 }, daemonVersion: "1", minModApi: 1, dashboardUrl: "" },
    { sessionId: "s1" }],
  ["InboxStateSchema", "waiting", "asleep"],
  ["ReviewerFailureClassSchema", "signed-out", "broken"],
  ["HomeDispatchReviewerSchema", reviewer, { ...reviewer, state: "done" }],
  ["HomeDispatchSubagentCountsSchema", { running: 0, finished: 0 }, { running: 1 }],
  ["HomeDispatchInboxItemSchema", item, { ...item, state: "asleep" }],
  ["HomeDispatchInboxSchema", { items: [item], needsYou: [], counts, slots: { used: 0, ceiling: 2 }, dashboardOnly: 0 }, { items: [] }],
  ["HomeDispatchInboxQuerySchema", { repo: "*", session: "s1" }, { repo: 1 }],
  ["HomeDispatchAnswerRequestSchema", { ...target, action: "chat_first" }, { ...target, action: "approve_plan" }],
  ["HomeDispatchReceiptSchema", { reviewId: "r1", taskId: "t1", sent: "x", at: 1 }, { reviewId: "r1" }],
  ["HomeDispatchOptionsRequestSchema", { sessionId: "s1", cwd: "/repo", entry: "command" }, { sessionId: "s1", cwd: "/repo", entry: "other" }],
  ["HomeDispatchQuestionSchema", question, { ...question, id: "harness" }],
  ["HomeDispatchOptionsResponseSchema", { questions: [question] }, { questions: [{}] }],
  ["HomeDispatchDraftCreateSchema", { sessionId: "s1", kind: "ship" }, { sessionId: "s1" }],
  ["HomeDispatchDraftUpdateSchema", { sessionId: "s1", words: "x" }, { words: "x" }],
  ["HomeDispatchDraftConfirmSchema", { sessionId: "s1", choice: "start" }, { sessionId: "s1", choice: "go" }],
  ["HomeDispatchDraftSummarySchema", draftSummary, { ...draftSummary, brief: undefined }],
  ["HomeDispatchConfirmResultSchema", { choice: "cancel", taskId: null, started: false }, { choice: "cancel", started: false }],
  ["HomeDispatchResidentSchema", resident, { ...resident, loopState: "asleep" }],
  ["HomeDispatchResidentsSchema", { residents: [resident] }, { residents: [{}] }],
  ["HomeDispatchResidentActionRequestSchema", { sessionId: "s1" }, {}],
  ["HomeDispatchResidentActionResultSchema", { ok: true }, "ok"],
  ["HomeDispatchSubagentLineSchema", subagentLine, { ...subagentLine, state: "paused" }],
  ["HomeDispatchTranscriptQuerySchema", { session: "s1", since: "0" }, { since: "-1" }],
  ["HomeDispatchStreamQuerySchema", { repo: "/repo", from: "0" }, { from: "1.5" }],
  ["HomeDispatchTranscriptMessageSchema", message, {}],
  ["HomeDispatchTranscriptSchema",
    { sessionId: "s1", messages: [message], next: 1, canMessage: true, state: "running", elapsedMs: 1, costUsd: null, subagents: [subagentLine] },
    { sessionId: "s1", messages: [{}], next: 1, canMessage: true, state: "running", elapsedMs: 1, costUsd: null, subagents: [] }],
  ["HomeDispatchSendRequestSchema", { sessionId: "s1", text: "hello" }, { sessionId: "s1", text: "" }],
  ["HomeDispatchSendResultSchema", { ok: true, at: 1 }, { ok: true }],
  ["CodexReadinessSchema", readiness, { ...readiness, accountVerified: undefined }],
  ["HomeDispatchReadinessQuerySchema", { live: "1" }, { live: "0" }],
  ["HomeDispatchConfigSchema", { launcher: { prompt: true } }, { launcher: {} }],
];

type Parser = { safeParse: (value: unknown) => { success: boolean } };
const exported = (name: string) => (contracts as unknown as Record<string, Parser | undefined>)[name];

test("every exported schema has a row in the table", () => {
  const schemas = Object.keys(contracts).filter((name) => name.endsWith("Schema")).sort();
  assert.deepEqual(TABLE.map(([name]) => name).sort(), schemas);
});

for (const [name, valid, invalid] of TABLE) {
  test(`${name} accepts its valid payload and refuses its invalid one`, () => {
    const schema = exported(name);
    assert.ok(schema, `${name} is exported`);
    const accepted = schema.safeParse(valid);
    assert.equal(accepted.success, true, `${name} should accept the valid case`);
    assert.equal(schema.safeParse(invalid).success, false, `${name} should refuse the invalid case`);
  });
}

test("offsets accept zero and refuse negative and fractional values; live accepts only 1", () => {
  const since = contracts.HomeDispatchTranscriptQuerySchema;
  const from = contracts.HomeDispatchStreamQuerySchema;
  for (const [schema, key] of [[since, "since"], [from, "from"]] as const) {
    assert.equal(schema.safeParse({ [key]: "0" }).success, true);
    assert.equal(schema.safeParse({ [key]: "-1" }).success, false);
    assert.equal(schema.safeParse({ [key]: "1.5" }).success, false);
  }
  assert.equal(contracts.HomeDispatchReadinessQuerySchema.safeParse({ live: "1" }).success, true);
  for (const live of ["0", "true", ""]) assert.equal(contracts.HomeDispatchReadinessQuerySchema.safeParse({ live }).success, false);
});
