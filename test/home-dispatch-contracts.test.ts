import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexReadinessSchema, HOME_DISPATCH_SEND_MAX_CHARS, HomeDispatchAnswerRequestSchema,
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
