import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Isolate the daemon's state dir (token + sqlite) BEFORE anything reads config.
// This is what proves the DRY refactor's single-source-of-truth runtime module:
// the token the daemon checks (config.ts -> shared/harness-runtime.mjs) must be
// the same one a client reads from the same FLEET_HOME. If those two drifted,
// every write below would 401.
process.env.FLEET_HOME = mkdtempSync(join(tmpdir(), "fleet-http-"));

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { normTty } = await import("../src/server/discovery/tty.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session, Task } from "../src/shared/types.ts";

openDb();
const TOKEN = ensureToken();

const registry = new Registry();
const reviews = new ReviewManager(registry);
const tasks = new TaskManager(registry);
const queues = new QueueManager(registry);
const app = buildApp(registry, reviews, tasks, queues);

// Loopback host + the shared token are what the real dashboard and hook present.
const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

/** A discovered claude session on tmux pane %3 - the join key the hook binds to. */
function seedSession(): void {
  const d: DiscoveredSession = {
    syntheticId: "sess-1",
    agent: "claude",
    name: "work",
    nameSource: "tmux",
    cwd: "/repo/app",
    gitBranch: "main",
    gitRoot: null,
    nomistakesGated: false,
    pid: 4242,
    tty: "ttys003",
    wezterm: null,
    tmux: { session: "work", window: "w", windowIndex: 0, paneId: "%3" },
    startedAt: 0,
  };
  registry.applyDiscovery([d]);
}

async function sessions(): Promise<Session[]> {
  const res = await app.request("/api/sessions", { headers: LOOPBACK });
  assert.equal(res.status, 200);
  return (await res.json()) as Session[];
}

const pkgVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

test("normTty normalizes every discovery source's no-tty sentinels + strips /dev/", () => {
  // The consolidated normalizer (discovery/tty.ts) replaces three hand-rolled
  // copies. It must return null for the union of sentinels ps/tmux/wezterm emit.
  for (const empty of ["", "?", "??", "-", "  ", null, undefined]) {
    assert.equal(normTty(empty), null, `${JSON.stringify(empty)} should be no-tty`);
  }
  assert.equal(normTty("/dev/ttys028"), "ttys028");
  assert.equal(normTty("ttys003"), "ttys003");
  assert.equal(normTty("  /dev/ttys9  "), "ttys9");
});

test("/api/health surfaces the shared runtime identity + package version", async () => {
  const res = await app.request("/api/health", { headers: LOOPBACK });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; service: string; version: string };
  assert.equal(body.ok, true);
  assert.equal(body.service, "fleet-control");
  assert.equal(body.version, pkgVersion);
});

test("a hook event (correct token) binds to the session and drives its state", async () => {
  seedSession();
  // Fresh discovery: working, not yet instrumented.
  const before = (await sessions()).find((s) => s.id === "sess-1")!;
  assert.equal(before.instrumented, false);

  // PreToolUse -> working + a readable activity line, and marks it instrumented.
  const pre = await app.request("/hooks/PreToolUse", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: "%3" }, toolName: "Bash", cwd: "/repo/app" }),
  });
  assert.equal(pre.status, 204);
  let s = (await sessions()).find((x) => x.id === "sess-1")!;
  assert.equal(s.state, "working");
  assert.equal(s.activity, "running Bash");
  assert.equal(s.instrumented, true);

  // Stop -> idle. Proves the same env join key keeps flipping the live session.
  const stop = await app.request("/hooks/Stop", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: "%3" } }),
  });
  assert.equal(stop.status, 204);
  s = (await sessions()).find((x) => x.id === "sess-1")!;
  assert.equal(s.state, "idle");

  // Notification -> awaiting_input with the message surfaced.
  const notif = await app.request("/hooks/Notification", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: "%3" }, message: "grant file access" }),
  });
  assert.equal(notif.status, 204);
  s = (await sessions()).find((x) => x.id === "sess-1")!;
  assert.equal(s.state, "awaiting_input");
  assert.equal(s.activity, "grant file access");
});

test("a hook event with a wrong token is rejected and leaves state untouched", async () => {
  const before = (await sessions()).find((s) => s.id === "sess-1")!;
  const res = await app.request("/hooks/Stop", {
    method: "POST",
    headers: { ...LOOPBACK, "content-type": "application/json", "x-harness-token": "not-the-token" },
    body: JSON.stringify({ env: { tmuxPane: "%3" } }),
  });
  assert.equal(res.status, 401);
  const after = (await sessions()).find((s) => s.id === "sess-1")!;
  assert.equal(after.state, before.state); // unchanged - the spoofed event never applied
});

test("a statusLine reading (correct token) lands model / thinking / context on the card", async () => {
  seedSession();
  const res = await app.request("/statusline", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      env: { tmuxPane: "%3" },
      sessionId: "abc",
      model: { id: "claude-opus-4-8", displayName: "Opus" },
      contextWindow: { usedPercentage: 42, contextWindowSize: 200000, tokens: 84000 },
      effort: "xhigh",
      thinkingEnabled: true,
    }),
  });
  assert.equal(res.status, 204);
  const s = (await sessions()).find((x) => x.id === "sess-1")!;
  assert.equal(s.meta?.model, "Opus 4.8");
  assert.equal(s.meta?.thinkingLevel, "xhigh");
  assert.equal(s.meta?.contextPct, 42);
  assert.equal(s.meta?.source, "statusline");
});

test("a statusLine reading with a wrong token is rejected", async () => {
  const res = await app.request("/statusline", {
    method: "POST",
    headers: { ...LOOPBACK, "content-type": "application/json", "x-harness-token": "nope" },
    body: JSON.stringify({ env: { tmuxPane: "%3" }, model: { id: "claude-opus-4-8" } }),
  });
  assert.equal(res.status, 401);
});

test("parseBody rejects a malformed write body with 400 (and never mutates)", async () => {
  // /api/tasks runs through the shared parseBody helper before any dispatch.
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { ...LOOPBACK, "content-type": "application/json" },
    body: JSON.stringify({ intent: "" }), // missing repoRoot, empty intent
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /repoRoot|intent|Required|String must contain/i);

  const list = await app.request("/api/tasks", { headers: LOOPBACK });
  assert.deepEqual(await list.json(), []); // nothing was created
});

test("a hook carrying permission_mode surfaces it on the session", async () => {
  seedSession();
  const res = await app.request("/hooks/UserPromptSubmit", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: "%3" }, prompt: "go", permissionMode: "acceptEdits" }),
  });
  assert.equal(res.status, 204);
  const s = (await sessions()).find((x) => x.id === "sess-1")!;
  assert.equal(s.permissionMode, "acceptEdits");
});

test("cycling the permission mode is rejected for a non-Claude session", async () => {
  // Permission modes are a Claude concept; the route refuses Codex before shelling out.
  registry.applyDiscovery([
    {
      syntheticId: "cx-1",
      agent: "codex",
      name: "cx",
      nameSource: "tmux",
      cwd: "/repo/cx",
      gitBranch: "main",
      gitRoot: null,
      nomistakesGated: false,
      pid: 9191,
      tty: "ttys009",
      wezterm: null,
      tmux: { session: "cx", window: "w", windowIndex: 0, paneId: "%9" },
      startedAt: 0,
    },
  ]);
  const res = await app.request("/api/sessions/cx-1/mode/cycle", { method: "POST", headers: authed });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Claude/i);
});

test("cycling the permission mode of an unknown session is a 404", async () => {
  const res = await app.request("/api/sessions/nope/mode/cycle", { method: "POST", headers: authed });
  assert.equal(res.status, 404);
});

test("reset endpoints are wired: 404 for unknown session, real errors otherwise", async () => {
  // Unknown session id -> 404 on both the preview and the execute route.
  const missPreview = await app.request("/api/sessions/nope/reset/preview", { headers: LOOPBACK });
  assert.equal(missPreview.status, 404);
  const missReset = await app.request("/api/sessions/nope/reset", {
    method: "POST",
    headers: { ...LOOPBACK, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(missReset.status, 404);

  // A real session whose cwd ("/repo/app") isn't a git repo: preview resolves
  // (200) with ok:false, and the execute route surfaces the failure as a 500.
  const preview = await app.request("/api/sessions/sess-1/reset/preview", { headers: LOOPBACK });
  assert.equal(preview.status, 200);
  const pbody = (await preview.json()) as { ok: boolean; error: string | null };
  assert.equal(pbody.ok, false);
  assert.equal(pbody.error, "not a git repository");

  const reset = await app.request("/api/sessions/sess-1/reset", {
    method: "POST",
    headers: { ...LOOPBACK, "content-type": "application/json" },
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(reset.status, 500);
  const rbody = (await reset.json()) as { ok: boolean; error: string | null };
  assert.equal(rbody.ok, false);
  assert.equal(rbody.error, "not a git repository");
});

test("rename: 404 unknown session, 400 invalid name, and it's wired to the action", async () => {
  // Unknown session id -> 404 (never reaches validation or a shell).
  const miss = await app.request("/api/sessions/nope/rename", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ name: "x" }),
  });
  assert.equal(miss.status, 404);

  // Seed a session backed by a tmux name no real tmux server has, so the wiring
  // test below can shell out to `tmux rename-session` without any risk of hitting
  // a session the user actually has open.
  registry.applyDiscovery([
    {
      syntheticId: "ren-1",
      agent: "claude",
      name: "harness-rename-src-xyzzy",
      nameSource: "tmux",
      cwd: "/repo/app",
      gitBranch: "main",
      gitRoot: null,
      nomistakesGated: false,
      pid: 5252,
      tty: "ttys055",
      wezterm: null,
      tmux: { session: "harness-rename-src-xyzzy", window: "w", windowIndex: 0, paneId: "%55" },
      startedAt: 0,
    },
  ]);

  // An empty body fails the zod schema (name min length) -> 400.
  const empty = await app.request("/api/sessions/ren-1/rename", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ name: "   " }),
  });
  // A blank name trims to empty: caught by validateSessionName as a 400.
  assert.equal(empty.status, 400);

  // A tmux-illegal name ('.') is refused before any shell runs -> 400, unchanged.
  const dotted = await app.request("/api/sessions/ren-1/rename", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ name: "a.b" }),
  });
  assert.equal(dotted.status, 400);
  const dbody = (await dotted.json()) as { ok: boolean; error: string };
  assert.match(dbody.error, /tmux session name/i);
  assert.equal((await sessions()).find((s) => s.id === "ren-1")!.name, "harness-rename-src-xyzzy");

  // A name a worktree-holding task still records is refused before any shell runs.
  // That task's Reclaim kills by name (`tmux kill-session -t tmuxSession`), so
  // taking the name would aim it at this live agent. The rule needs task state, so
  // only the route can enforce it - hence the wiring check here.
  registry.upsertTask({
    id: "stale-xyzzy",
    title: "T",
    intent: "done, awaiting reclaim",
    kind: "ship",
    agent: "claude",
    repoRoot: "/repo",
    worktreePath: "/wt/stale-xyzzy",
    branch: null,
    provider: null,
    tmuxSession: "harness-rename-taken-xyzzy",
    sessionId: null,
    status: "done",
    outcome: null,
    outcomeUrl: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
    dispatchedAt: null,
    completedAt: null,
  } satisfies Task);
  const taken = await app.request("/api/sessions/ren-1/rename", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ name: "harness-rename-taken-xyzzy" }),
  });
  assert.equal(taken.status, 400);
  const tbody = (await taken.json()) as { ok: boolean; error: string };
  assert.match(tbody.error, /another task still holds/i);
  assert.equal((await sessions()).find((s) => s.id === "ren-1")!.name, "harness-rename-src-xyzzy");

  // A valid name reaches the action, which shells `tmux rename-session -t
  // harness-rename-src-xyzzy ...`. No such session exists, so tmux errors and the
  // route surfaces it as a 500 - proving the route -> validate -> action path is
  // wired (the success path + optimistic echo are covered in rename.test.ts).
  const ok = await app.request("/api/sessions/ren-1/rename", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ name: "harness-rename-dst-xyzzy" }),
  });
  assert.equal(ok.status, 500);
  const okBody = (await ok.json()) as { ok: boolean; error: string };
  assert.equal(okBody.ok, false);
});

// ---- Foreman session work queues ----

const jsonHeaders = { ...LOOPBACK, "content-type": "application/json" };

async function addItem(intent: string): Promise<{ id: string; revision: number }> {
  const res = await app.request("/api/sessions/sess-1/queue", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ intent }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { id: string; revision: number };
}

test("queue CRUD round-trips: add, read back, and remove", async () => {
  seedSession();
  const item = await addItem("add the retry");

  const read = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const queue = (await read.json()) as { items: Array<{ id: string; intent: string }> };
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0]?.intent, "add the retry");

  const del = await app.request(`/api/sessions/sess-1/queue/${item.id}`, {
    method: "DELETE",
    headers: LOOPBACK,
  });
  assert.equal(del.status, 200);
  const after = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const empty = (await after.json()) as { items: unknown[] };
  assert.equal(empty.items.length, 0);
});

test("the queue is denormalized onto the session card", async () => {
  seedSession();
  const item = await addItem("something to do");
  const s = (await sessions()).find((x) => x.id === "sess-1")!;
  assert.equal(s.queue?.openCount, 1);
  assert.equal(s.queue?.totalCount, 1);
  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("editing an item requires a matching revision (CAS), and bumps it", async () => {
  seedSession();
  const item = await addItem("first draft");

  const ok = await app.request(`/api/sessions/sess-1/queue/${item.id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ intent: "second draft", revision: item.revision }),
  });
  assert.equal(ok.status, 200);
  const updated = (await ok.json()) as { intent: string; revision: number };
  assert.equal(updated.intent, "second draft");
  assert.equal(updated.revision, item.revision + 1);

  // The same (now stale) revision must not apply twice.
  const stale = await app.request(`/api/sessions/sess-1/queue/${item.id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ intent: "third draft", revision: item.revision }),
  });
  assert.equal(stale.status, 409);

  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("editing an item Foreman already sent is a 409, not a silent no-op", async () => {
  // Without this the UI would happily let someone edit an item that is already
  // typed into a pane, and report success.
  seedSession();
  const item = await addItem("in flight already");
  const sent = await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "in_progress" }),
  });
  assert.equal(sent.status, 200);

  const res = await app.request(`/api/sessions/sess-1/queue/${item.id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ intent: "too late", revision: item.revision }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /in_progress/);

  // ...and removing it is refused too - the agent is working on it right now.
  const del = await app.request(`/api/sessions/sess-1/queue/${item.id}`, {
    method: "DELETE",
    headers: LOOPBACK,
  });
  assert.equal(del.status, 409);

  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "cancelled" }),
  });
  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("reorder persists the authored order", async () => {
  seedSession();
  const a = await addItem("alpha");
  const b = await addItem("bravo");
  const c = await addItem("charlie");

  const res = await app.request("/api/sessions/sess-1/queue/order", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ ids: [c.id, a.id, b.id] }),
  });
  assert.equal(res.status, 200);

  const read = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const queue = (await read.json()) as { items: Array<{ intent: string }> };
  assert.deepEqual(
    queue.items.map((i) => i.intent),
    ["charlie", "alpha", "bravo"],
  );

  for (const i of [a, b, c]) {
    await app.request(`/api/sessions/sess-1/queue/${i.id}`, { method: "DELETE", headers: LOOPBACK });
  }
});

test("approve clears a proposed item, and is refused for anything else", async () => {
  seedSession();
  const item = await addItem("needs an OK");

  // A `queued` item was never drafted, so there is nothing to approve.
  const early = await app.request(`/api/sessions/sess-1/queue/${item.id}/approve`, {
    method: "POST",
    headers: LOOPBACK,
  });
  assert.equal(early.status, 409);

  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "proposed" }),
  });
  const ok = await app.request(`/api/sessions/sess-1/queue/${item.id}/approve`, {
    method: "POST",
    headers: LOOPBACK,
  });
  assert.equal(ok.status, 200);

  const read = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const queue = (await read.json()) as { items: Array<{ approvedAt: number | null }> };
  assert.ok(queue.items[0]?.approvedAt, "approve records consent");

  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("adding to a drained queue re-arms the wrap-up ask", async () => {
  // Without this the SECOND drain is silent and the human waits forever for a
  // question that already fired once.
  seedSession();
  const first = await addItem("do a thing");
  await app.request(`/api/sessions/sess-1/queue/${first.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "verified" }),
  });
  const asked = await app.request("/api/sessions/sess-1/queue/wrapup/asked", {
    method: "POST",
    headers: LOOPBACK,
  });
  assert.equal(asked.status, 200);
  assert.ok(((await asked.json()) as { wrapupAskedAt: number | null }).wrapupAskedAt);

  const second = await addItem("and another");
  const read = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const queue = (await read.json()) as { wrapupAskedAt: number | null };
  assert.equal(queue.wrapupAskedAt, null, "new work re-arms the ask");

  for (const i of [first, second]) {
    await app.request(`/api/sessions/sess-1/queue/${i.id}`, { method: "DELETE", headers: LOOPBACK });
  }
});

test("a second in-flight item is refused with a clean 409, not a raw 500", async () => {
  // The single-flight index is the enforcement and must stay that way - but the
  // raw ERR_SQLITE_ERROR escaping the route meant the daemon logged a stack trace
  // and answered an opaque 500, so a caller couldn't tell "you broke the
  // invariant" from "the daemon fell over".
  seedSession();
  const a = await addItem("first");
  const b = await addItem("second");
  const first = await app.request(`/api/sessions/sess-1/queue/${a.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "in_progress" }),
  });
  assert.equal(first.status, 200);

  const second = await app.request(`/api/sessions/sess-1/queue/${b.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "sending" }),
  });
  assert.equal(second.status, 409);
  assert.match(((await second.json()) as { error: string }).error, /already in flight/);

  // And the invariant actually held - the refusal wasn't cosmetic.
  const read = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const queue = (await read.json()) as { items: Array<{ state: string }> };
  const inFlight = queue.items.filter((i) =>
    ["sending", "awaiting_pickup", "in_progress", "verifying"].includes(i.state),
  );
  assert.equal(inFlight.length, 1);

  for (const i of [a, b]) {
    await app.request(`/api/sessions/sess-1/queue/${i.id}/state`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ state: "cancelled" }),
    });
    await app.request(`/api/sessions/sess-1/queue/${i.id}`, { method: "DELETE", headers: LOOPBACK });
  }
});

test("the leased heartbeat makes exactly one worker the leader", async () => {
  const first = await app.request("/api/foreman/heartbeat", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ workerId: "worker-a" }),
  });
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { leader: boolean }).leader, true);

  // A second worker must NOT get the lease - this is the whole point: two workers
  // would double-send a work instruction into a live agent.
  const second = await app.request("/api/foreman/heartbeat", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ workerId: "worker-b" }),
  });
  const b = (await second.json()) as { leader: boolean; holder: string };
  assert.equal(b.leader, false);
  assert.equal(b.holder, "worker-a");

  // The leader renewing is still the leader.
  const renew = await app.request("/api/foreman/heartbeat", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ workerId: "worker-a" }),
  });
  assert.equal(((await renew.json()) as { leader: boolean }).leader, true);
});

test("releasing the lease lets the standby take over at once", async () => {
  await app.request("/api/foreman/heartbeat", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ workerId: "worker-a" }),
  });
  const rel = await app.request("/api/foreman/heartbeat/release", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ workerId: "worker-a" }),
  });
  assert.equal(rel.status, 204);

  const taken = await app.request("/api/foreman/heartbeat", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ workerId: "worker-b" }),
  });
  assert.equal(((await taken.json()) as { leader: boolean }).leader, true);
});

test("foremanStatus reports running only while a leader's lease is live", async () => {
  await app.request("/api/foreman/heartbeat/release", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ workerId: "worker-b" }),
  });
  const off = await app.request("/api/foreman/status", { headers: LOOPBACK });
  assert.equal(((await off.json()) as { running: boolean }).running, false);

  await app.request("/api/foreman/heartbeat", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ workerId: "worker-c" }),
  });
  const on = await app.request("/api/foreman/status", { headers: LOOPBACK });
  assert.equal(((await on.json()) as { running: boolean }).running, true);
});

test("the queue endpoints 404 for an unknown session", async () => {
  const read = await app.request("/api/sessions/nope/queue", { headers: LOOPBACK });
  assert.equal(read.status, 404);
  const add = await app.request("/api/sessions/nope/queue", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ intent: "x" }),
  });
  assert.equal(add.status, 404);
});

test("/api/sessions/:id/inject validates its body and 404s an unknown session", async () => {
  seedSession();
  const empty = await app.request("/api/sessions/sess-1/inject", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ text: "" }),
  });
  assert.equal(empty.status, 400);

  const missing = await app.request("/api/sessions/nope/inject", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(missing.status, 404);
});

test("/mcp/status validates the shared EnvSchema and updates activity on success", async () => {
  // Happy path: valid EnvSchema body -> 204, activity line updates on the session.
  const ok = await app.request("/mcp/status", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: "%3" }, activity: "reviewing the diff" }),
  });
  assert.equal(ok.status, 204);
  const s = (await sessions()).find((x) => x.id === "sess-1")!;
  assert.equal(s.activity, "reviewing the diff");

  // Invalid env (tmuxPane must be a string) -> parseBody 400 from the hoisted schema.
  const bad = await app.request("/mcp/status", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: 123 }, activity: "x" }),
  });
  assert.equal(bad.status, 400);
});
