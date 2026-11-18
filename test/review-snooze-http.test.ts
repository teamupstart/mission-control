import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-review-snooze-http-"));

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
const app = buildApp({
  registry,
  reviews,
  tasks: new TaskManager(registry),
  queues: new QueueManager(registry),
});

const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };
const json = { ...LOOPBACK, "content-type": "application/json" };

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
  const dashboard = { ...json, "x-mission-operation-actor": "human", origin: "http://127.0.0.1:7317" };
  const parked = await app.request(`/api/reviews/${id}/snooze`, { method: "POST", headers: dashboard, body: JSON.stringify({ delay: "1h" }) });
  assert.equal(parked.status, 200);

  const agentWake = await app.request(`/api/reviews/${id}/wake`, { method: "POST", headers: authed });
  assert.equal(agentWake.status, 403);
  assert.equal(await pending(), "snoozed");
  assert.equal((await app.request(`/api/reviews/${id}/wake`, { method: "POST", headers: dashboard })).status, 200);
});
