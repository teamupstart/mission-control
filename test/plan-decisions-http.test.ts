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
  nomistakesGated: false,
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
