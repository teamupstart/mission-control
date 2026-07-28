// What is at stake: a run detail the operator can stay in while members work. The lane must
// project live session truth and both answer protocols without erasing the durable member record;
// a run with no live session must keep the old record-card markup unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  EnsembleAttempt,
  EnsembleMember,
} from "../src/shared/ensemble.ts";
import type { ReviewItem, Session } from "../src/shared/types.ts";
import {
  EnsembleMembers,
  type EnsembleMemberLiveLane,
} from "../src/web/ensembles/EnsembleMembers.tsx";
import type { EnsembleRunDetailResponse } from "../src/web/ensembles/types.ts";
import {
  mkSession,
  mkTaskSummary,
} from "./helpers/session-fixture.ts";

function member(over: Partial<EnsembleMember> = {}): EnsembleMember {
  return {
    id: "member-1",
    runId: "run-1",
    roleKey: "candidate-1",
    roleLabel: "Candidate 1",
    ordinal: 1,
    wave: 1,
    taskId: "task-1",
    status: "active",
    selectedAttemptId: null,
    resultLabel: null,
    error: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

function attempt(over: Partial<EnsembleAttempt> = {}): EnsembleAttempt {
  return {
    id: "attempt-1",
    runId: "run-1",
    memberId: "member-1",
    attempt: 1,
    taskId: "task-1",
    sessionId: "session-1",
    agent: "claude",
    requestedModel: "claude-opus",
    requestedEffort: "high",
    observedModel: null,
    baseSha: "a".repeat(40),
    worktreePath: "/repo/member-1",
    branch: "ensemble/member-1",
    status: "running",
    error: null,
    createdAt: 1000,
    updatedAt: 2000,
    startedAt: 1000,
    finishedAt: null,
    ...over,
  };
}

function detail(
  oneMember: EnsembleMember = member(),
  oneAttempt: EnsembleAttempt | null = attempt(),
): EnsembleRunDetailResponse {
  return {
    members: [oneMember],
    attempts: oneAttempt ? [oneAttempt] : [],
    artifacts: [],
    pagination: {
      attemptsReturned: oneAttempt ? 1 : 0,
      attemptsTotal: oneAttempt ? 1 : 0,
      eventsReturned: 0,
      eventsTotal: 0,
    },
  } as unknown as EnsembleRunDetailResponse;
}

function review(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "review-1",
    sessionId: "session-1",
    kind: "input",
    title: "Which compatibility target should I use?",
    body: "Which compatibility target should I use?",
    status: "pending",
    response: null,
    createdAt: 1000,
    resolvedAt: null,
    ...over,
  };
}

function liveSession(over: Partial<Session> = {}): Session {
  return mkSession({
    id: "session-1",
    task: mkTaskSummary({ id: "task-1" }),
    activity: "running the compatibility suite",
    startedAt: Date.now() - 8 * 60_000,
    firstSeen: Date.now() - 8 * 60_000,
    lastActivity: Date.now() - 2 * 60_000,
    pendingReviews: 1,
    goal: {
      text: "Keep the parser compatible with stored v1 plans",
      source: "model",
      updatedAt: Date.now(),
    },
    cost: {
      costUsd: 0.42,
      basis: "api-equivalent",
      pricingModels: ["claude-opus"],
      pricingVersions: ["2026-07"],
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      updatedAt: Date.now(),
    },
    paneDialog: {
      highlighted: 1,
      prompt: "Allow the compatibility test command?",
      options: [
        { number: 1, label: "Allow" },
        { number: 2, label: "Deny" },
      ],
    },
    ...over,
  });
}

function render(
  memberDetail: EnsembleRunDetailResponse,
  lane: Omit<EnsembleMemberLiveLane, "gateNeedsYou"> & { gateNeedsYou?: boolean } | null,
): string {
  return renderToStaticMarkup(
    createElement(EnsembleMembers, {
      detail: memberDetail,
      liveByMemberId: lane
        ? new Map([["member-1", { ...lane, gateNeedsYou: lane.gateNeedsYou ?? false }]])
        : undefined,
      pending: null,
      onAction: () => {},
    }),
  );
}

test("a joined member lane renders live tone, activity, goal, elapsed, last event, and cost", () => {
  const html = render(detail(), { session: liveSession(), reviews: [] });
  assert.match(html, /aria-label="Session to review"/);
  assert.match(html, /running the compatibility suite/);
  assert.match(html, /Keep the parser compatible with stored v1 plans/);
  assert.match(html, /elapsed 8m/);
  assert.match(html, /last event 2m ago/);
  assert.match(html, /≈\$0\.42/);
  assert.match(html, /<details class="ensemble-lane-history"><summary>/);
});

test("a joined member lane uses the parked-gate attention tone", () => {
  const html = render(detail(), {
    session: liveSession({
      state: "idle",
      pendingReviews: 0,
      paneDialog: null,
    }),
    reviews: [],
    gateNeedsYou: true,
  });
  assert.match(html, /aria-label="Session needs decision"/);
  assert.match(html, /ensemble-lane-tone-attention/);
});

test("a candidate's pending review and pane dialog are both answerable in its lane", () => {
  const html = render(detail(), {
    session: liveSession(),
    reviews: [review()],
  });
  assert.match(html, /Candidate 1 asks/);
  assert.match(html, /Which compatibility target should I use/);
  assert.match(html, /placeholder="Your answer…"/);
  assert.match(html, /Allow the compatibility test command/);
  assert.match(html, />Allow</);
});

test("a member with no joined session keeps the record-card snapshot byte-identical", () => {
  const html = render(
    detail(member({ status: "retained", taskId: null }), null),
    null,
  );
  assert.equal(
    html,
    '<div class="ensemble-members"><div class="ensemble-wave"><ul class="ensemble-member-list"><li class="ensemble-member ensemble-tone-done"><div class="ensemble-member-head"><span class="ensemble-member-ordinal">#1</span><span class="ensemble-member-role">Candidate 1</span><span class="ensemble-pill">Retained</span><span class="ensemble-artifact-spacer"></span></div><div class="ensemble-member-durable-state"><div><h6>Attempt state</h6><p class="ensemble-muted">No attempts yet.</p></div><div><h6>Artifact state</h6><p class="ensemble-muted">No artifact captures yet.</p></div></div></li></ul></div></div>',
  );
});

test("a failed live member expands its durable history by default", () => {
  const html = render(
    detail(member({ status: "failed", error: "agent exited" }), attempt({ status: "failed" })),
    { session: liveSession({ pendingReviews: 0, paneDialog: null }), reviews: [] },
  );
  assert.match(html, /<details class="ensemble-lane-history" open="">/);
  assert.match(html, /Attempt #1/);
  assert.match(html, /agent exited/);
});
