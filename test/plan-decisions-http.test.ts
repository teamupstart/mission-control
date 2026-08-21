import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's state dir (token + sqlite) BEFORE anything reads config, exactly
// as http-integration.test.ts does: the token the daemon checks and the one the MCP
// client presents must be the same, or every /mcp write below 401s.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-plan-decisions-http-"));

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { reportBucket } = await import("../src/shared/session.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ReviewItem } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

openDb();
const TOKEN = ensureToken();

const registry = new Registry();
const reviews = new ReviewManager(registry);
const app = buildApp(registry, reviews, new TaskManager(registry), new QueueManager(registry));

const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

// A discovered claude session on tmux pane %3 - the join key the MCP bridge binds to.
const discovered: DiscoveredSession = {
  syntheticId: "sess-1",
  agent: "claude",
  name: "work",
  nameSource: "tmux",
  cwd: "/repo/app",
  gitBranch: "main",
  gitRoot: null,
  repoRoot: null,
  pid: 4242,
  tty: "ttys003",
  terminals: [mkMuxHandle({ session: "work", windowName: "w", windowIndex: 0, paneId: "%3" })],
  startedAt: 0,
};
registry.applyDiscovery([discovered]);

const decisions = [
  {
    id: "store",
    question: "Where should sessions live?",
    options: [
      { id: "redis", label: "Redis", recommended: true },
      { id: "pg", label: "Postgres" },
    ],
  },
];

/**
 * The whole agent-facing loop: an agent's `request_plan_decisions` creates the review
 * (bound to its pane via the terminal env), the human resolves it from the dashboard,
 * and the agent's blocked `wait` returns their selections verbatim.
 */
test("a plan-decisions review round-trips create -> resolve -> wait over HTTP", async () => {
  // 1. The MCP bridge creates the review, bound to the session by its tmux pane env.
  const created = await app.request("/mcp/reviews", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      env: { tmuxPane: "%3" },
      cwd: "/repo/app",
      kind: "plan-decisions",
      title: "Auth plan",
      body: "# Auth plan",
      decisions,
    }),
  });
  assert.equal(created.status, 200, "the review is created");
  const { id } = (await created.json()) as { id: string };

  // 2. It surfaces to the dashboard as a pending review, decisions intact.
  const list = (await (await app.request("/api/reviews", { headers: LOOPBACK })).json()) as ReviewItem[];
  const pending = list.find((r) => r.id === id);
  assert.ok(pending, "the review is in the snapshot");
  assert.equal(pending.kind, "plan-decisions");
  assert.deepEqual(pending.decisions, decisions, "the dashboard receives the decisions to render");

  // 3. The human submits their selections (what DecisionForm posts on Submit).
  const answer = "Plan decisions submitted:\n\n• Where should sessions live?\n  → Redis";
  const resolved = await app.request(`/api/reviews/${id}/resolve`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ action: "answer", response: answer }),
  });
  assert.equal(resolved.status, 200, "the resolve succeeds");

  // 4. The agent's blocked wait now returns the human's selections verbatim.
  const waited = (await (
    await app.request(`/mcp/reviews/${id}/wait`, { headers: authed })
  ).json()) as ReviewItem;
  assert.equal(waited.status, "answered");
  assert.equal(waited.response, answer, "the agent receives exactly what the human submitted");
});

test("an explicit SDK identity owns its review when two sessions share a cwd", async () => {
  const firstId = "sdk:http-same-cwd-first";
  const secondId = "sdk:http-same-cwd-second";
  const sharedCwd = "/repo/http-same-cwd";
  registry.registerSdkSession({ id: firstId, agent: "codex", name: "first", cwd: sharedCwd });
  registry.registerSdkSession({ id: secondId, agent: "codex", name: "second", cwd: sharedCwd });
  let reviewId: string | null = null;

  try {
    const created = await app.request("/mcp/reviews", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({
        env: {},
        sessionId: secondId,
        cwd: sharedCwd,
        kind: "input",
        title: "Which session owns this review?",
        body: "Which session owns this review?",
      }),
    });
    const response = (await created.json()) as { id: string; sessionId: string };
    reviewId = response.id;

    assert.deepEqual(
      {
        status: created.status,
        responseSessionId: response.sessionId,
        reviewSessionId: registry.getReview(response.id)?.sessionId,
        pendingReviews: {
          first: registry.getSession(firstId)?.pendingReviews,
          second: registry.getSession(secondId)?.pendingReviews,
        },
      },
      {
        status: 200,
        responseSessionId: secondId,
        reviewSessionId: secondId,
        pendingReviews: { first: 0, second: 1 },
      },
    );
  } finally {
    if (reviewId) {
      await app.request(`/api/reviews/${reviewId}/resolve`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ action: "answer", response: "second" }),
      });
    }
  }
});

test("report_status routed by an SDK identity preserves its native conversation binding", async () => {
  const id = "sdk:http-status-routing";
  registry.registerSdkSession({ id, agent: "codex", name: "status", cwd: "/repo/status" });
  registry.applyDriverEvent(id, {
    kind: "bound",
    agentSessionId: "thread:native",
    transcriptPath: "/rollouts/native.jsonl",
    modelId: null,
    pid: null,
  });

  const response = await app.request("/mcp/status", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: {}, sessionId: id, activity: "awaiting review" }),
  });

  const session = registry.getSession(id);
  assert.deepEqual(
    {
      status: response.status,
      activity: session?.activity,
      agentSessionId: session?.agentSessionId,
      transcriptPath: session?.transcriptPath,
    },
    {
      status: 204,
      activity: "awaiting review",
      agentSessionId: "thread:native",
      transcriptPath: "/rollouts/native.jsonl",
    },
  );
});

test("the MCP detach route is authenticated and bound to the review's session", async () => {
  const created = await app.request("/mcp/reviews", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      env: { tmuxPane: "%3" },
      cwd: "/repo/app",
      kind: "input",
      title: "Will this arrive?",
      body: "Will this arrive?",
    }),
  });
  const { id } = (await created.json()) as { id: string };

  const wrongSession = await app.request(`/mcp/reviews/${id}/detach`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: "%999" }, cwd: "/repo/elsewhere" }),
  });
  assert.equal(wrongSession.status, 404);

  const detached = await app.request(`/mcp/reviews/${id}/detach`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: "%3" }, cwd: "/repo/app" }),
  });
  assert.equal(detached.status, 200);
  assert.deepEqual(await detached.json(), { id, detached: true });

  const row = openDb()
    .prepare(`SELECT mcp_wait_detached_at FROM reviews WHERE id = ?`)
    .get(id) as unknown as { mcp_wait_detached_at: number | null };
  assert.ok(row.mcp_wait_detached_at, "the transport handoff is durable");

  const cleanup = await app.request(`/api/reviews/${id}/resolve`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ action: "answer", response: "yes" }),
  });
  assert.equal(cleanup.status, 200);
});

test("submitted and dismissed decision sets both leave Needs you when none remain", async () => {
  async function create(title: string): Promise<string> {
    const response = await app.request("/mcp/reviews", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({
        env: { tmuxPane: "%3" },
        cwd: "/repo/app",
        kind: "plan-decisions",
        title,
        body: `# ${title}`,
        decisions,
      }),
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { id: string }).id;
  }

  const priorId = await create("Prior plan");
  const currentId = await create("Current plan");
  assert.equal(registry.getSession("sess-1")?.pendingReviews, 2);
  assert.equal(reportBucket(registry.getSession("sess-1")!), "needs-you");

  const submitted = await app.request(`/api/reviews/${currentId}/resolve`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ action: "answer", response: "Plan decisions submitted:\n\n• Current" }),
  });
  assert.equal(submitted.status, 200);
  assert.equal(registry.getSession("sess-1")?.pendingReviews, 1);
  assert.equal(reportBucket(registry.getSession("sess-1")!), "needs-you");

  const dismissed = await app.request(`/api/reviews/${priorId}/resolve`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ action: "dismiss" }),
  });
  assert.equal(dismissed.status, 200);
  const dismissedReview = (await dismissed.json()) as ReviewItem;
  assert.equal(dismissedReview.status, "dismissed");
  assert.equal(dismissedReview.response, null, "dismissal does not fabricate a submitted choice");

  const session = registry.getSession("sess-1");
  assert.ok(session);
  assert.equal(session.pendingReviews, 0);
  assert.equal(reportBucket(session), "idle", "the session leaves Needs you once every set is resolved");

  const waited = (await (
    await app.request(`/mcp/reviews/${priorId}/wait`, { headers: authed })
  ).json()) as ReviewItem;
  assert.equal(waited.status, "dismissed", "the blocked MCP call is released as dismissed");
});

test("dismissal is limited to option-bearing reviews and discards supplied responses", async () => {
  async function create(
    kind: "diff" | "input",
    title: string,
    reviewDecisions?: typeof decisions,
  ): Promise<string> {
    const response = await app.request("/mcp/reviews", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({
        env: { tmuxPane: "%3" },
        cwd: "/repo/app",
        kind,
        title,
        body: title,
        decisions: reviewDecisions,
      }),
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { id: string }).id;
  }

  for (const [kind, id] of [
    ["diff", await create("diff", "Diff review")],
    ["free-text input", await create("input", "Explain the failure")],
  ] as const) {
    const response = await app.request(`/api/reviews/${id}/resolve`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ action: "dismiss" }),
    });
    assert.equal(response.status, 400, `${kind} cannot be dismissed`);
    assert.equal(registry.getReview(id)?.status, "pending", `${kind} remains unresolved`);
  }

  const selectableInputId = await create("input", "Choose a database", decisions);
  const dismissed = await app.request(`/api/reviews/${selectableInputId}/resolve`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ action: "dismiss", response: "Postgres" }),
  });
  assert.equal(dismissed.status, 200);
  const review = (await dismissed.json()) as ReviewItem;
  assert.equal(review.status, "dismissed");
  assert.equal(review.response, null, "dismissal never persists a supplied selection");
});
