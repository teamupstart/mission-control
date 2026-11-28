import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionLead, formatResponse } from "../src/shared/review-item.ts";

process.env.MISSION_HOME = tempDir("mission-review-snooze-http-");

const { insertReview, openDb, snoozeReviewRow } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { ReviewItem } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import { tempDir } from "./temp-root.mjs";

openDb();
const TOKEN = ensureToken();

const registry = new Registry();
function reviewApp(registry: InstanceType<typeof Registry>) {
  return buildApp({
    registry,
    reviews: new ReviewManager(registry),
    tasks: new TaskManager(registry),
    queues: new QueueManager(registry),
  });
}
const app = reviewApp(registry);

const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };
const json = { ...LOOPBACK, "content-type": "application/json" };
const dashboard = { ...json, "x-mission-operation-actor": "human", origin: "http://127.0.0.1:7317" };

const discovered: DiscoveredSession = {
  syntheticId: "sess-snooze",
  agent: "claude",
  name: "work",
  nameSource: "tmux",
  cwd: "/repo/app",
  gitBranch: "main",
  gitRoot: null,
  repoRoot: null,
  pid: 4243,
  tty: "ttys004",
  terminals: [mkMuxHandle({ session: "work", windowName: "w", windowIndex: 0, paneId: "%4" })],
  startedAt: 0,
};
registry.applyDiscovery([discovered]);

let asked = 0;
async function ask(extra: Record<string, unknown>): Promise<string> {
  const question = `Which linter should this repo use? (${++asked})`;
  const res = await app.request("/mcp/reviews", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      env: { tmuxPane: "%4" },
      cwd: "/repo/app",
      kind: "input",
      title: question,
      body: question,
      decisions: [{ id: "q", question, options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint" }] }],
      ...extra,
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
}

const snooze = (id: string, body: unknown) =>
  app.request(`/api/reviews/${id}/snooze`, { method: "POST", headers: json, body: JSON.stringify(body) });

test("request_input's question snoozes over HTTP and the agent's wait returns it", async () => {
  const id = await ask({ snoozable: true });
  const res = await snooze(id, { delay: "2h", meanwhile: { mode: "option", optionId: "o1" } });
  assert.equal(res.status, 200, await res.clone().text());
  const parked = (await res.json()) as ReviewItem;
  assert.equal(parked.status, "snoozed");
  assert.equal(parked.snooze!.until - parked.snooze!.at, 2 * 60 * 60_000, "the daemon adds the delay to its own clock");

  const waited = await app.request(`/mcp/reviews/${id}/wait`, { headers: authed });
  assert.equal(((await waited.json()) as ReviewItem).status, "snoozed");
});

test("the dashboard can reopen a restored snoozed request and submit a typed answer", async () => {
  const id = "legacy-snoozed-question";
  const sessionId = discovered.syntheticId;
  const question = "Which linter?";
  const decisions = [{ id: "q", question, options: [{ id: "o0", label: "biome" }, { id: "o1", label: "eslint" }] }];
  // Seed the persisted shape from before text entry became unconditional.
  const now = Date.now();
  insertReview({
    id, sessionId, kind: "input", title: question, body: question, status: "pending",
    response: null, decisions, snoozable: true, createdAt: now, resolvedAt: null,
  });
  assert.ok(snoozeReviewRow(id, { at: now, until: now + 60_000, mode: "judgment", optionId: null, listening: true }));
  const restoredRegistry = new Registry();
  restoredRegistry.applyDiscovery([discovered]);
  const restoredApp = reviewApp(restoredRegistry);

  const waiting = await restoredApp.request(`/mcp/reviews/${id}/wait`, { headers: authed });
  assert.equal(waiting.status, 200, await waiting.clone().text());
  const parked = (await waiting.json()) as ReviewItem;
  assert.equal(parked.status, "snoozed");
  assert.equal(parked.decisions?.[0]?.allowOther, true);

  const woke = await restoredApp.request(`/api/reviews/${id}/wake`, { method: "POST", headers: dashboard });
  assert.equal(woke.status, 200, await woke.clone().text());
  const pending = (await woke.json()) as ReviewItem;
  assert.equal(pending.status, "pending");
  assert.ok(pending.decisions);
  assert.equal(pending.decisions[0]?.allowOther, true);

  const selections = [{ decisionId: "q", selected: [], other: "Use oxlint instead" }];
  const response = formatResponse(pending.decisions, selections, decisionLead(pending.kind));
  const resolved = await restoredApp.request(`/api/reviews/${id}/resolve`, {
    method: "POST",
    headers: dashboard,
    body: JSON.stringify({ action: "answer", response, selections, by: "human" }),
  });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  assert.equal(((await resolved.json()) as ReviewItem).status, "answered");

  const history = await restoredApp.request(`/api/sessions/${sessionId}/resolved-reviews`, { headers: LOOPBACK });
  assert.equal(history.status, 200, await history.clone().text());
  const saved = ((await history.json()) as ReviewItem[]).find((review) => review.id === id);
  assert.ok(saved);
  assert.equal(saved.resolvedBy, "human");
  assert.equal(saved.response, `Answered:\n\n• ${question}\n  Other: Use oxlint instead`);
  assert.deepEqual(saved.selections, selections);
  assert.deepEqual(saved.decisions, decisions);
});

test("Answer now brings a snoozed question back, and only a snoozed one", async () => {
  const id = await ask({ snoozable: true });
  assert.equal((await snooze(id, { delay: "15m" })).status, 200);
  const woke = await app.request(`/api/reviews/${id}/wake`, { method: "POST", headers: json });
  assert.equal(woke.status, 200);
  const back = (await woke.json()) as ReviewItem;
  assert.equal(back.status, "pending");
  assert.equal(typeof back.snooze?.remindedAt, "number");

  const again = await app.request(`/api/reviews/${id}/wake`, { method: "POST", headers: json });
  assert.equal(again.status, 409);
  const missing = await app.request(`/api/reviews/no-such/wake`, { method: "POST", headers: json });
  assert.equal(missing.status, 404);
});

test("a question that does not offer Remind me later is refused, and so is a malformed snooze", async () => {
  const plain = await ask({});
  assert.equal((await snooze(plain, { delay: "1h" })).status, 409);

  const id = await ask({ snoozable: true });
  assert.equal((await snooze(id, { delay: "3h" })).status, 400, "only the offered delays");
  assert.equal((await snooze(id, { delay: "1h", meanwhile: { mode: "option", optionId: "o9" } })).status, 409);
  assert.equal((await snooze("no-such", { delay: "1h" })).status, 404);
});

test("only an input question may ask to offer Remind me later", async () => {
  const res = await app.request("/mcp/reviews", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      env: { tmuxPane: "%4" },
      cwd: "/repo/app",
      kind: "diff",
      title: "Patch",
      body: "diff --git a/x b/x",
      snoozable: true,
    }),
  });
  assert.equal(res.status, 400);
});

test("only the operator's dashboard may snooze or wake: agent-marked and foreign requests are refused", async () => {
  const id = await ask({ snoozable: true });
  const pending = async () => ((await (await app.request("/api/reviews", { headers: LOOPBACK })).json()) as ReviewItem[])
    .find((r) => r.id === id)?.status;

  for (const headers of [
    authed, // the machine token every MCP child and agent tool carries
    { ...json, "x-mission-operation-actor": "agent" },
    { ...json, origin: "http://evil.example" },
  ]) {
    const res = await app.request(`/api/reviews/${id}/snooze`, { method: "POST", headers, body: JSON.stringify({ delay: "1h" }) });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.match(((await res.json()) as { error: string }).error, /Only the operator/);
    assert.equal(await pending(), "pending", "nothing was parked");
  }

  // The dashboard's own request names a human actor and carries no token.
  const parked = await app.request(`/api/reviews/${id}/snooze`, { method: "POST", headers: dashboard, body: JSON.stringify({ delay: "1h" }) });
  assert.equal(parked.status, 200);

  const agentWake = await app.request(`/api/reviews/${id}/wake`, { method: "POST", headers: authed });
  assert.equal(agentWake.status, 403);
  assert.equal(await pending(), "snoozed");
  assert.equal((await app.request(`/api/reviews/${id}/wake`, { method: "POST", headers: dashboard })).status, 200);
});
