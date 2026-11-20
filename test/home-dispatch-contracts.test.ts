import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexReadinessSchema, HomeDispatchConfigSchema, HomeDispatchDraftConfirmSchema, HomeDispatchDraftCreateSchema,
  HomeDispatchDraftSummarySchema, HomeDispatchDraftUpdateSchema, HomeDispatchOptionsRequestSchema,
  HomeDispatchOptionsResponseSchema, HomeDispatchReceiptSchema, HomeDispatchResidentSchema,
  HomeDispatchResidentsSchema, HomeSessionRegistrationAnswerSchema, HomeDispatchTranscriptQuerySchema,
  HomeDispatchStreamQuerySchema, HomeDispatchReadinessQuerySchema, HomeDispatchConfirmResultSchema,
  HomeDispatchSendResultSchema, HOME_DISPATCH_SEND_MAX_CHARS, HomeDispatchAnswerRequestSchema,
  HomeDispatchInboxSchema, HomeDispatchSendRequestSchema, HomeDispatchTranscriptSchema,
  HomeSessionRegistrationSchema, INBOX_STATES, type CodexReadiness,
} from "../src/shared/home-dispatch.ts";

test("registration takes the spec 7.2 fields and refuses a harness other than claude", () => {
  const registration = {
    sessionId: "s1", harness: "claude", cwd: "/repo", clientVersion: "1.0.0", source: "startup",
    entrypoint: null, interactive: true, beforeFirstPrompt: true, launcherDisabled: false,
  };
  assert.equal(HomeSessionRegistrationSchema.safeParse(registration).success, true);
  assert.equal(HomeSessionRegistrationSchema.safeParse({ ...registration, harness: "codex" }).success, false);
  assert.equal(HomeSessionRegistrationSchema.safeParse({ ...registration, source: "other" }).success, false);
});

test("an inbox item carries both subagent counts and the reviewer rows", () => {
  const item = {
    taskId: "t1", title: "Fix it", kind: "bugfix", state: "running", origin: "home-session", changedAt: 1,
    subagents: { running: 1, finished: 2 }, canMessage: true, agent: "claude", runtime: "sdk",
    run: {
      workflowId: "w", slug: "ship", version: 1, status: "running", phase: null, step: 1, of: 3, checks: [],
      blockedReason: null,
      reviewers: [{ name: "Codex", runner: "codex", model: null, state: "retrying", attempt: 2, startedAt: 1, endedAt: null,
        failure: { class: "signed-out", fix: "Run codex login." } }],
    },
  };
  const counts = Object.fromEntries(INBOX_STATES.map((state) => [state, 0]));
  const inbox = { items: [item], needsYou: [], counts, slots: { used: 0, ceiling: 2 }, dashboardOnly: 0 };
  assert.equal(HomeDispatchInboxSchema.safeParse(inbox).success, true);
  assert.equal(HomeDispatchInboxSchema.safeParse({ ...inbox, counts: { waiting: 0 } }).success, false, "every state is counted");
  assert.equal(HomeDispatchInboxSchema.safeParse({ ...inbox, items: [{ ...item, subagents: { running: 1 } }] }).success, false);
});

test("answers name the action's own fields, and an approval cannot omit its revision", () => {
  const target = { taskId: "t1", reviewId: "r1", sessionId: "s1", fromForm: true };
  const ok = (body: object) => HomeDispatchAnswerRequestSchema.safeParse({ ...target, ...body }).success;
  assert.equal(ok({ action: "answer", option: "Yes" }), true);
  assert.equal(ok({ action: "approve_plan", revisionHash: "abc1234" }), true);
  assert.equal(ok({ action: "approve_plan" }), false);
  assert.equal(ok({ action: "approve_review", revisionHash: "abc1234", text: "ship it" }), true);
  assert.equal(ok({ action: "approve_review" }), false);
  assert.equal(ok({ action: "request_changes", text: "rework" }), true);
  assert.equal(ok({ action: "reject_review" }), true);
  assert.equal(ok({ action: "chat_first" }), true);
  assert.equal(ok({ action: "jump" }), false, "jump is withdrawn and never reused");
});

test("send is bounded at 8,000 characters and the transcript response lists per-subagent lines", () => {
  assert.equal(HomeDispatchSendRequestSchema.safeParse({ sessionId: "s", text: "x".repeat(HOME_DISPATCH_SEND_MAX_CHARS) }).success, true);
  assert.equal(HomeDispatchSendRequestSchema.safeParse({ sessionId: "s", text: "x".repeat(HOME_DISPATCH_SEND_MAX_CHARS + 1) }).success, false);
  assert.equal(HomeDispatchSendRequestSchema.safeParse({ sessionId: "s", text: "" }).success, false);
  const transcript = {
    sessionId: "s", messages: [], next: 0, canMessage: false, state: "running", elapsedMs: 5, costUsd: null,
    subagents: [{ type: "mission-explorer", state: "running", elapsedMs: 1, description: "Find callers", tokens: 10, toolUses: 2 }],
  };
  assert.equal(HomeDispatchTranscriptSchema.safeParse(transcript).success, true);
  assert.equal(HomeDispatchTranscriptSchema.safeParse({ ...transcript, subagents: { running: 1, finished: 0 } }).success, false);
});

test("CodexReadiness carries observed, accountVerified and the reviewer set", () => {
  const readiness: CodexReadiness = {
    checkedAt: null, stale: true, accountChangeVisible: false, accountVerified: false,
    observed: { codexPath: null, binarySize: null, binaryMtime: null, authMtime: null, codexVersion: null, account: null },
    required: false, canStart: false, reviewPath: null, reviewsReady: false, workflows: [], reviewerSet: [],
    checks: [{ id: "codex-cli", level: "prerequisite", ok: null, required: true, detail: "not checked", fix: null }],
  };
  assert.equal(CodexReadinessSchema.safeParse(readiness).success, true);
  const { accountVerified: _dropped, ...without } = readiness;
  assert.equal(CodexReadinessSchema.safeParse(without).success, false);
});

const ok = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

test("registration answers carry the launcher decision and banner counts", () => {
  const answer = { sessionId: "s1", repoRoot: "/repo", created: true, offerLauncher: false,
    counts: { running: 1, waiting: 0 }, daemonVersion: "2.2.0", minModApi: 1, dashboardUrl: "http://127.0.0.1:7317" };
  assert.ok(ok(HomeSessionRegistrationAnswerSchema, answer));
  assert.ok(ok(HomeSessionRegistrationAnswerSchema, { ...answer, repoRoot: null }), "no repository is a null, not absent");
  const { counts: _counts, ...noCounts } = answer;
  assert.ok(!ok(HomeSessionRegistrationAnswerSchema, noCounts));
  assert.ok(!ok(HomeSessionRegistrationAnswerSchema, { ...answer, counts: { running: -1, waiting: 0 } }));
});

test("receipts name the review, the task, what was sent and when", () => {
  const receipt = { reviewId: "r1", taskId: "t1", sent: "approve rev abc1234: ok", at: 1 };
  assert.ok(ok(HomeDispatchReceiptSchema, receipt));
  assert.ok(!ok(HomeDispatchReceiptSchema, { ...receipt, at: undefined }));
  assert.ok(!ok(HomeDispatchReceiptSchema, { ...receipt, reviewId: "" }));
});

test("dispatch options need a working directory and a known entry, and answer with questions", () => {
  const request = { sessionId: "s1", cwd: "/repo", entry: "command" };
  assert.ok(ok(HomeDispatchOptionsRequestSchema, request));
  assert.ok(ok(HomeDispatchOptionsRequestSchema, { ...request, kind: "bugfix", brief: "fix it" }));
  assert.ok(!ok(HomeDispatchOptionsRequestSchema, { ...request, entry: "somewhere" }));
  assert.ok(!ok(HomeDispatchOptionsRequestSchema, { ...request, kind: "nonsense" }));
  assert.ok(!ok(HomeDispatchOptionsRequestSchema, { sessionId: "s1", entry: "command" }), "cwd is required");
  const questions = { questions: [{ id: "kind", header: "Kind", question: "What kind of task?",
    options: [{ value: "ship", label: "Ship: build it" }, { value: "more", label: "More..." }] }] };
  assert.ok(ok(HomeDispatchOptionsResponseSchema, questions));
  assert.ok(!ok(HomeDispatchOptionsResponseSchema, { questions: [{ ...questions.questions[0], id: "harness" }] }), "no harness question exists");
});

test("drafts: create needs a kind, update changes picks, confirm takes only start, backlog or cancel", () => {
  const create = { sessionId: "s1", kind: "ship", words: "add a button", intent: "now" };
  assert.ok(ok(HomeDispatchDraftCreateSchema, create));
  assert.ok(!ok(HomeDispatchDraftCreateSchema, { sessionId: "s1", words: "no kind" }));
  assert.ok(!ok(HomeDispatchDraftCreateSchema, { ...create, intent: "later" }));
  assert.ok(ok(HomeDispatchDraftUpdateSchema, { sessionId: "s1", words: "changed", workflowId: "none" }));
  assert.ok(!ok(HomeDispatchDraftUpdateSchema, { words: "no session" }));
  for (const choice of ["start", "backlog", "cancel"]) assert.ok(ok(HomeDispatchDraftConfirmSchema, { sessionId: "s1", choice }));
  assert.ok(!ok(HomeDispatchDraftConfirmSchema, { sessionId: "s1", choice: "maybe" }));
  assert.ok(!ok(HomeDispatchDraftConfirmSchema, { sessionId: "s1" }));
  const summary = { draftId: "d1", repoRoot: "/repo", kind: "ship", kindLabel: "Ship", afterWork: "None", afterWorkApplies: true,
    words: "add a button", context: null, needs: [], brief: "add a button", text: "Repo: /repo" };
  assert.ok(ok(HomeDispatchDraftSummarySchema, summary));
  assert.ok(!ok(HomeDispatchDraftSummarySchema, { ...summary, brief: undefined }));
});

test("residents carry loop state and every field the pane reads", () => {
  const resident = { runId: "run1", taskId: "t1", name: "Observer", builtIn: true, repos: 2, loopState: "working", needsYou: false,
    iteration: 3, nextWakeAt: null, pauseReason: null, wakeReason: null, runRequestedAt: null, contextPercent: 41, costUsd: null };
  assert.ok(ok(HomeDispatchResidentSchema, resident));
  assert.ok(ok(HomeDispatchResidentsSchema, { residents: [resident] }));
  assert.ok(!ok(HomeDispatchResidentSchema, { ...resident, loopState: "sleeping" }));
  assert.ok(!ok(HomeDispatchResidentSchema, { ...resident, nextWakeAt: undefined }), "null and absent differ");
  assert.ok(!ok(HomeDispatchResidentsSchema, { residents: [{ ...resident, iteration: -1 }] }));
});

test("config answers the launcher setting", () => {
  assert.ok(ok(HomeDispatchConfigSchema, { launcher: { prompt: true } }));
  assert.ok(!ok(HomeDispatchConfigSchema, { launcher: { prompt: "yes" } }));
  assert.ok(!ok(HomeDispatchConfigSchema, {}));
});

test("transcript and stream offsets are non-negative integers, read from the query string", () => {
  for (const [schema, key] of [[HomeDispatchTranscriptQuerySchema, "since"], [HomeDispatchStreamQuerySchema, "from"]] as const) {
    assert.ok(ok(schema, {}), `${key} is optional`);
    assert.ok(ok(schema, { [key]: "0" }), `${key}=0 is valid`);
    assert.ok(ok(schema, { [key]: "42" }));
    assert.ok(!ok(schema, { [key]: "-1" }), `${key} refuses a negative offset`);
    assert.ok(!ok(schema, { [key]: "1.5" }), `${key} refuses a fraction`);
    assert.ok(!ok(schema, { [key]: "abc" }), `${key} refuses a non-number`);
  }
  assert.equal(HomeDispatchTranscriptQuerySchema.parse({ since: "7" }).since, 7);
  assert.ok(ok(HomeDispatchTranscriptQuerySchema, { session: "s1", repo: "/repo" }));
});

test("readiness takes only live=1", () => {
  assert.ok(ok(HomeDispatchReadinessQuerySchema, {}));
  assert.ok(ok(HomeDispatchReadinessQuerySchema, { session: "s1", live: "1" }));
  for (const live of ["0", "true", "", "2"]) assert.ok(!ok(HomeDispatchReadinessQuerySchema, { live }), `live=${live}`);
});

test("confirm and send results need every field", () => {
  const confirmed = { choice: "start", taskId: "t1", started: true };
  assert.ok(ok(HomeDispatchConfirmResultSchema, confirmed));
  assert.ok(ok(HomeDispatchConfirmResultSchema, { choice: "cancel", taskId: null, started: false }), "cancel creates no task");
  assert.ok(!ok(HomeDispatchConfirmResultSchema, { choice: "start", started: true }), "taskId is required, null or a string");
  assert.ok(!ok(HomeDispatchConfirmResultSchema, { choice: "start", taskId: "t1" }));
  assert.ok(!ok(HomeDispatchConfirmResultSchema, { ...confirmed, choice: "maybe" }));
  assert.ok(ok(HomeDispatchSendResultSchema, { ok: true, at: 5 }));
  assert.ok(!ok(HomeDispatchSendResultSchema, { ok: true }));
  assert.ok(!ok(HomeDispatchSendResultSchema, { ok: false, at: 5 }));
  assert.ok(!ok(HomeDispatchSendResultSchema, { at: 5 }));
});
