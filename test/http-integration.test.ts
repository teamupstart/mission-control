import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Isolate the daemon's state dir (token + sqlite) BEFORE anything reads config.
// This is what proves the DRY refactor's single-source-of-truth runtime module:
// the token the daemon checks (config.ts -> shared/harness-runtime.mjs) must be
// the same one a client reads from the same MISSION_HOME. If those two drifted,
// every write below would 401.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-http-"));

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
    repoRoot: null,
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
  assert.equal(body.service, "mission-control");
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

test("a real hook POST captures the human's ask onto the session's goal", async () => {
  // End-to-end over the wire the hook actually uses: the body is the exact shape
  // hooks/harness-hook.mjs builds, through the real route, into the real registry and db.
  seedSession();
  const prompt = "add a Goal line to every session card";
  const res = await app.request("/hooks/UserPromptSubmit", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: "%3" }, prompt, sessionId: "agent-goal-1" }),
  });
  assert.equal(res.status, 204);
  assert.equal(registry.getGoal("sess-1")?.prompt, prompt);

  // A background task reporting in arrives on this SAME route and must not displace it.
  const noise = await app.request("/hooks/UserPromptSubmit", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({
      env: { tmuxPane: "%3" },
      sessionId: "agent-goal-1",
      prompt: "<task-notification>\n<task-id>z9</task-id>\n<status>completed</status>\n</task-notification>",
    }),
  });
  assert.equal(noise.status, 204);
  assert.equal(registry.getGoal("sess-1")?.prompt, prompt, "a task notification overwrote the ask");
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
      repoRoot: null,
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
      repoRoot: null,
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
    priority: null,
    labels: [],
    model: null,
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

  // `proposed` with no drafted text is not an approvable item either: Approve means
  // "type THIS", so with nothing to read there is nothing to consent to. The window
  // is real - a fix round parks the item at `proposed` and the draft is written in
  // the same breath, but only a server that enforces this can't be raced by a card.
  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "proposed" }),
  });
  const draftless = await app.request(`/api/sessions/sess-1/queue/${item.id}/approve`, {
    method: "POST",
    headers: LOOPBACK,
  });
  assert.equal(draftless.status, 409, "a proposed item with no draft can't be approved");

  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "proposed", proposedPayload: "needs an OK" }),
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

test("a queue is not orphaned while its session is still inside the exit linger", async () => {
  // `exited` is PROVISIONAL: applyDiscovery marks any session missing from a single
  // sweep as exited and only evicts it 8s later, cancelling that timer if it comes
  // back. Reading the state as "gone" ignores the very guard the linger provides.
  //
  // The cost of getting this wrong is unrecoverable: one hiccuping `ps` sweep marks
  // every session exited, and the worker's orphan sweep - which runs several times
  // a second - escalates every in-flight item across the sessions. The next poll un-marks
  // the sessions, but escalation is terminal and has no undo.
  //
  // This drives /api/queues?orphaned=1, which IS what the worker's sweep calls.
  seedSession();
  const item = await addItem("add the retry");
  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "in_progress" }),
  });

  const orphaned = async (): Promise<string[]> => {
    const r = await app.request("/api/queues?orphaned=1", { headers: LOOPBACK });
    return ((await r.json()) as Array<{ noteKey: string }>).map((q) => q.noteKey);
  };

  assert.deepEqual(await orphaned(), [], "a live session's queue is never orphaned");

  // One sweep misses the session: it's marked exited, and the 8s eviction is armed.
  registry.applyDiscovery([]);
  assert.deepEqual(
    await orphaned(),
    [],
    "a single missed poll must not hand an in-flight item to the orphan sweep",
  );

  // The session reappears on the next poll, which cancels the eviction - and also
  // stops that timer from firing into later tests.
  seedSession();
  assert.deepEqual(await orphaned(), []);

  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "cancelled" }),
  });
  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("a fix round keeps round 0's scope - the agent that COMMITS isn't punished for it", async () => {
  // The item's evidence is its CUMULATIVE work, because that's what the verifier is
  // asked: the prompt hands it the original intent and asks whether that intent was
  // satisfied. Re-anchoring on every send made that question unanswerable, and only
  // for agents that commit - which is to say, it punished the good citizen.
  //
  // Trace the real thing: round 0 is delivered at abc1234; the agent implements the
  // feature AND commits, so HEAD becomes def5678; verify raises one blocking gap and
  // round 1 is sent. Re-anchoring round 1 to def5678 would scope the diff to the fix
  // alone and move the transcript window past the work that satisfied the intent - so
  // the verifier, asked "was the intent satisfied?", would honestly answer no, mint
  // fresh gaps for work already done, and ride the round budget to escalation.
  //
  // A non-committing agent never moves HEAD, so the bug was invisible to it. This
  // drives the real route -> QueueManager -> registry -> db, because the re-anchor
  // lived in the write itself and a fake markSent could never have shown it.
  seedSession();
  const item = await addItem("add the retry");

  const send = async (baseSha: string, transcriptAnchor: number) => {
    await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ state: "sending" }),
    });
    const r = await app.request(`/api/sessions/sess-1/queue/${item.id}/sent`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ baseSha, transcriptAnchor }),
    });
    assert.equal(r.status, 200);
    return (await r.json()) as { baseSha: string | null; transcriptAnchor: number | null };
  };

  // Round 0: delivered at abc1234, with the transcript ending at byte 100.
  const round0 = await send("abc1234", 100);
  assert.equal(round0.baseSha, "abc1234");
  assert.equal(round0.transcriptAnchor, 100);

  // The agent works, COMMITS (HEAD moves to def5678), and the transcript grows.
  // Verify finds a gap, so round 1 goes out - captured at the NEW head.
  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "in_progress" }),
  });
  const round1 = await send("def5678", 9_000);

  assert.equal(round0.baseSha, "abc1234");
  assert.equal(
    round1.baseSha,
    "abc1234",
    "round 1 must still be judged against round 0's base, or the committed work vanishes from the diff",
  );
  assert.equal(
    round1.transcriptAnchor,
    100,
    "and against round 0's transcript anchor, or the work vanishes from the window too",
  );

  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "verified" }),
  });
  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("an item write moves the queue's updatedAt, so an open panel learns about a draft", async () => {
  // The card's summary is a compact projection - counts and the in-flight state -
  // and the panel refetches off it. `queued -> proposed` moves NONE of those:
  // `proposed` is neither in-flight nor terminal, so openCount and inFlightState
  // both sit still and the summary comes out byte-identical. In dry-run - the
  // DEFAULT mode - that meant a round-0 draft never appeared, and since Approve is
  // the only thing that advances a dry-run queue, the whole batch wedged until the
  // human happened to collapse and re-expand the card.
  //
  // Timestamping the queue row on any item write is what makes "an item changed"
  // observable without teaching the summary every state.
  seedSession();
  const item = await addItem("add the retry");

  const summary = async () => {
    const s = (await sessions()).find((x) => x.id === "sess-1");
    return s?.queue ?? null;
  };

  const before = await summary();
  assert.ok(before, "the card carries a queue summary");

  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "proposed", proposedPayload: "add the retry" }),
  });

  const after = await summary();
  assert.equal(after?.openCount, before?.openCount, "the counts genuinely don't move…");
  assert.equal(after?.inFlightState, before?.inFlightState, "…and neither does the in-flight state");
  assert.ok(
    (after?.updatedAt ?? 0) > (before?.updatedAt ?? 0),
    "so updatedAt must move, or the panel never refetches and the draft is invisible",
  );

  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("a drafted item stores the exact text Approve consents to, and drops it on send", async () => {
  // From round 1 the drafted payload is the rendered FIX PROMPT, not the item's
  // intent - so if it isn't stored and shown, Approve is consent to text the human
  // never read. It has to survive the round trip, and it has to disappear the
  // moment the item stops being a draft, or the card advertises a prompt Foreman
  // is no longer about to type.
  seedSession();
  const item = await addItem("add the retry");
  const draft = "Foreman reviewed the work you just finished and found it incomplete. …";

  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "proposed", round: 1, proposedPayload: draft }),
  });

  const read = async () => {
    const r = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
    const q = (await r.json()) as { items: Array<{ id: string; proposedPayload: string | null }> };
    return q.items.find((i) => i.id === item.id);
  };

  assert.equal((await read())?.proposedPayload, draft, "the draft survives the round trip");

  // Leaving `proposed` clears it - here, the send the human approved.
  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "sending" }),
  });
  assert.equal((await read())?.proposedPayload, null, "a draft belongs to `proposed` and nothing else");

  // Terminalize before removing: an in-flight item is deliberately un-removable
  // (it's already typed into a pane), so a bare DELETE here would be refused and
  // silently leave it holding the single-flight index for every later test.
  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "cancelled" }),
  });
  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("editing a drafted item drops the draft it invalidated, along with the approval", async () => {
  // The human approved the OLD text; the edit makes both the consent and the
  // drafted prompt stale, and a card still showing the old draft would be lying
  // about what Approve would send.
  seedSession();
  const item = await addItem("add the retry");
  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "proposed", proposedPayload: "add the retry" }),
  });
  await app.request(`/api/sessions/sess-1/queue/${item.id}/approve`, { method: "POST", headers: LOOPBACK });

  const r = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const before = ((await r.json()) as { items: Array<{ id: string; revision: number }> }).items.find(
    (i) => i.id === item.id,
  )!;

  const edited = await app.request(`/api/sessions/sess-1/queue/${item.id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ intent: "add the retry AND a test", revision: before.revision }),
  });
  assert.equal(edited.status, 200);

  const after = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const item2 = ((await after.json()) as {
    items: Array<{ id: string; approvedAt: number | null; proposedPayload: string | null }>;
  }).items.find((i) => i.id === item.id);
  assert.equal(item2?.approvedAt, null, "the edit spends the approval");
  assert.equal(item2?.proposedPayload, null, "and the draft it consented to");

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

test("the drain ask can be raised on a session that has NO queue items", async () => {
  // The `prompted` trigger's whole premise is a session with no work queue, and the
  // Ship it? card it raises renders off `wrapupAskedAt` on the queue ROW. This endpoint
  // used to 404 without a row, which would have made the trigger verify the work,
  // decide to ask, and then silently drop the question.
  seedSession();
  const asked = await app.request("/api/sessions/sess-1/queue/wrapup/asked", {
    method: "POST",
    headers: LOOPBACK,
  });
  assert.equal(asked.status, 200);
  const queue = (await asked.json()) as { wrapupAskedAt: number | null; items: unknown[] };
  assert.ok(queue.wrapupAskedAt, "the ask has somewhere to live");
  assert.deepEqual(queue.items, [], "and creating that row invented no work");
});

test("a prompted ask clears a PREVIOUS episode's answer; the drain ask never does", async () => {
  // The card renders only on `wrapupAskedAt !== null && wrapupAnswer === null`, and an
  // answer is cleared nowhere else but a new queue item. So a second prompted episode
  // landing on a row that already carries an answer - its own earlier auto-send, or a
  // human's drain answer - would be stamped and then invisibly swallowed, with
  // `promptedGoal` already retiring the episode so nothing ever asks again.
  seedSession();
  await app.request("/api/sessions/sess-1/queue/wrapup", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ answer: "/no-mistakes" }),
  });

  // The drain path sends no body, and must leave the answer it just collected alone.
  const drain = await app.request("/api/sessions/sess-1/queue/wrapup/asked", {
    method: "POST",
    headers: LOOPBACK,
  });
  assert.equal(
    ((await drain.json()) as { wrapupAnswer: string | null }).wrapupAnswer,
    "/no-mistakes",
    "the drain ask must not clobber the answer to the ask it is raising",
  );

  const prompted = await app.request("/api/sessions/sess-1/queue/wrapup/asked", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ clearAnswer: true }),
  });
  assert.equal(prompted.status, 200);
  const q = (await prompted.json()) as { wrapupAskedAt: number | null; wrapupAnswer: string | null };
  assert.ok(q.wrapupAskedAt, "the new question is stamped");
  assert.equal(q.wrapupAnswer, null, "and the stale answer went with it, so the card renders");
});

test("the prompted trigger's episode guard round-trips, and is separate from the drain ask", async () => {
  // One field for both guards would mean a prompted wrap-up consumed the drain ask (or
  // the reverse) on a checkout that later gets a work queue. They must not interfere.
  seedSession();
  // Read the drain ask's current value rather than assuming null: these tests share one
  // registry and one db, so an earlier case may have stamped it. UNCHANGED is the real
  // invariant here anyway - "never null" would pass for a stamp that was already there.
  const before = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const askedBefore = ((await before.json()) as { wrapupAskedAt: number | null }).wrapupAskedAt;

  const goal = "add retry handling to the uploader";
  const res = await app.request("/api/sessions/sess-1/queue/wrapup/prompted", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ goal }),
  });
  assert.equal(res.status, 200);
  const q = (await res.json()) as { promptedGoal: string | null; wrapupAskedAt: number | null };
  assert.equal(q.promptedGoal, goal);
  assert.equal(q.wrapupAskedAt, askedBefore, "retiring a prompted episode never touches the drain ask");

  // And it survives a re-read, since it is the thing that stops the trigger re-firing.
  const read = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  assert.equal(((await read.json()) as { promptedGoal: string | null }).promptedGoal, goal);
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

test("adding to a NON-claude session is refused, with a reason that isn't a lie", async () => {
  // The panel hides its add box for a Codex session, but presentation is not
  // enforcement and this route is reachable without it - the worker is itself a
  // client of this API. Every tick filters to claude, so the queue would never
  // advance, and because the session is live its key is live: neither the re-attach
  // hint nor the orphan sweep would ever offer the batch to anyone.
  const codex: DiscoveredSession = {
    syntheticId: "sess-codex",
    agent: "codex",
    name: "other",
    nameSource: "tmux",
    cwd: "/repo/app",
    gitBranch: "main",
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 4243,
    tty: "ttys004",
    wezterm: null,
    tmux: { session: "other", window: "w", windowIndex: 0, paneId: "%4" },
    startedAt: 0,
  };
  registry.applyDiscovery([codex]);

  const res = await app.request("/api/sessions/sess-codex/queue", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ intent: "never going to run" }),
  });
  assert.equal(res.status, 409, "the session exists, so this is a refusal - not a 404");
  assert.match(((await res.json()) as { error: string }).error, /Claude-only/);

  const read = await app.request("/api/sessions/sess-codex/queue", { headers: LOOPBACK });
  assert.equal(await read.json(), null, "and no empty queue row is left stranded on it");
});

test("an item-scoped route refuses a session that doesn't own the item", async () => {
  // `:id` was decoration: every item route addressed the item globally, so an
  // unknown session - or a DIFFERENT one - could drive any item across the sessions. Item
  // ids survive a re-attach, so a tab holding a pre-re-attach list (SSE dropped, or
  // backgrounded, so no refresh fired) would click Remove under session A and delete
  // the item out of session B's live queue.
  seedSession();
  const item = await addItem("belongs to sess-1");

  const routes: Array<[string, string, unknown]> = [
    [`/api/sessions/nope/queue/${item.id}`, "PATCH", { intent: "x", revision: item.revision }],
    [`/api/sessions/nope/queue/${item.id}`, "DELETE", null],
    [`/api/sessions/nope/queue/${item.id}/approve`, "POST", null],
    [`/api/sessions/nope/queue/${item.id}/state`, "PUT", { state: "cancelled" }],
    [`/api/sessions/nope/queue/${item.id}/sent`, "POST", { baseSha: "abc1234" }],
    [`/api/sessions/nope/queue/${item.id}/recover`, "POST", null],
  ];
  for (const [path, method, body] of routes) {
    const res = await app.request(path, {
      method,
      headers: body ? jsonHeaders : LOOPBACK,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(res.status, 404, `${method} ${path} must not address an item globally`);
  }

  // And the item is untouched by any of it.
  const read = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const q = (await read.json()) as { items: Array<{ intent: string; state: string }> };
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0]?.state, "queued");

  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("the orphan sweep's by-key route drives an item whose session is gone", async () => {
  // The session-scoped routes now insist the session resolves - and the sweep's whole
  // subject is a queue whose session does NOT. It used to borrow the session route by
  // passing the note key as the session id, which worked only because that route
  // ignored the segment: the sweep was relying on the bug above.
  seedSession();
  await app.request("/hooks/Stop", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ env: { tmuxPane: "%3" }, sessionId: "sweep-me", cwd: "/repo/app" }),
  });
  const item = await addItem("in flight when the session vanished");
  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "in_progress" }),
  });

  const wrongKey = await app.request(`/api/queues/not-this-queue/items/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "escalated" }),
  });
  assert.equal(wrongKey.status, 404, "ownership is checked against the key the caller named");

  const res = await app.request(`/api/queues/sweep-me/items/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "escalated", escalationReason: "the session vanished" }),
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { state: string }).state, "escalated");

  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
});

test("/sent and /reattach validate their bodies instead of hand-checking them", async () => {
  // A negative `transcriptAnchor` doesn't reach `readSync` - the transcript route
  // guards `since >= 0` - it falls through to the default head+tail window, so the
  // verify scope silently degrades from "this item's turns" to "the last 48 turns".
  // A verifier judging work it was never scoped to invents gaps, which is exactly the
  // quiet fail-open the evidence-first design exists to avoid.
  seedSession();
  const item = await addItem("check the anchor");

  const negative = await app.request(`/api/sessions/sess-1/queue/${item.id}/sent`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ baseSha: "abc1234", transcriptAnchor: -1 }),
  });
  assert.equal(negative.status, 400);

  const ok = await app.request(`/api/sessions/sess-1/queue/${item.id}/sent`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ baseSha: "abc1234", transcriptAnchor: 0 }),
  });
  assert.equal(ok.status, 200, "0 is a real anchor - an empty transcript at delivery");
  assert.equal(((await ok.json()) as { transcriptAnchor: number }).transcriptAnchor, 0);

  const noKey = await app.request("/api/sessions/sess-1/queue/reattach", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({}),
  });
  assert.equal(noKey.status, 400);

  const hugeKey = await app.request("/api/sessions/sess-1/queue/reattach", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ noteKey: "k".repeat(5000) }),
  });
  assert.equal(hugeKey.status, 400, "an unbounded key reaches a SQL lookup and a Set probe");

  await app.request(`/api/sessions/sess-1/queue/${item.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "cancelled" }),
  });
  await app.request(`/api/sessions/sess-1/queue/${item.id}`, { method: "DELETE", headers: LOOPBACK });
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

test("the standards route reads the repo's contract from the git TOPLEVEL, not the session's cwd", async () => {
  // The whole seam: route -> repoRootOf (a real `git rev-parse --show-toplevel`) ->
  // readStandards. The paths come from a diff, and git emits those relative to the
  // toplevel wherever it was invoked from - so a session sitting in a monorepo
  // package (the ordinary case) used to look for the root AGENTS.md one level down,
  // find nothing, and hand the verifier an empty bundle with `truncated: false`.
  // Nothing said so: it judged against the repo's main contract without it.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-standards-")));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("init", "-q");
  mkdirSync(join(repo, "packages", "app", "src"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "# the repo's contract");
  writeFileSync(join(repo, "packages", "app", "CLAUDE.md"), "# the package's own");

  // A session whose cwd is the PACKAGE, not the toplevel.
  registry.applyDiscovery([
    {
      syntheticId: "sess-nested",
      agent: "claude",
      name: "nested",
      nameSource: "tmux",
      cwd: join(repo, "packages", "app"),
      gitBranch: "main",
      gitRoot: repo,
      repoRoot: repo,
      nomistakesGated: false,
      pid: 4343,
      tty: "ttys009",
      wezterm: null,
      tmux: { session: "work", window: "w", windowIndex: 1, paneId: "%9" },
      startedAt: 0,
    },
  ]);

  const r = await app.request("/api/sessions/sess-nested/standards", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ paths: ["packages/app/src/a.ts"] }),
  });
  assert.equal(r.status, 200);
  const bundle = (await r.json()) as { docs: Array<{ path: string; text: string }> };
  const paths = bundle.docs.map((d) => d.path).sort();

  assert.ok(paths.includes("AGENTS.md"), "the repo's main contract must reach the verifier");
  assert.ok(paths.includes("packages/app/CLAUDE.md"), "and so must the package's own");
});

test("the standards request carries its paths in a BODY, so a big refactor still arrives", async () => {
  // The list comes from a patch capped at 1.2MB. As `path=` query params, a few
  // hundred URL-encoded source paths overrun Node's 16KB default maxHeaderSize: the
  // daemon rejects the request line, the worker's `.catch` turns that into an empty
  // bundle, and `truncated: false` means the prompt doesn't even print its "some
  // standards docs were omitted" line - so the verifier judges the item against the
  // repo's contract having read NONE of it, and nothing says so.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-standards-big-")));
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "pipe" });
  writeFileSync(join(repo, "AGENTS.md"), "# the repo's contract");

  registry.applyDiscovery([
    {
      syntheticId: "sess-big",
      agent: "claude",
      name: "big",
      nameSource: "tmux",
      cwd: repo,
      gitBranch: "main",
      gitRoot: repo,
      repoRoot: repo,
      nomistakesGated: false,
      pid: 4444,
      tty: "ttys010",
      wezterm: null,
      tmux: { session: "work", window: "w", windowIndex: 2, paneId: "%10" },
      startedAt: 0,
    },
  ]);

  // 400 deep paths - comfortably past 16KB once every `/` becomes `%2F`.
  const many = Array.from(
    { length: 400 },
    (_, i) => `src/server/foreman/deeply/nested/module-${i}/implementation-file-${i}.ts`,
  );
  assert.ok(
    many.map((p) => `path=${encodeURIComponent(p)}`).join("&").length > 16_384,
    "the fixture must actually be past the header limit, or this test proves nothing",
  );

  const r = await app.request("/api/sessions/sess-big/standards", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ paths: many }),
  });
  assert.equal(r.status, 200);
  const bundle = (await r.json()) as { docs: Array<{ path: string }>; truncated: boolean };
  assert.ok(
    bundle.docs.some((d) => d.path === "AGENTS.md"),
    "the repo's contract reaches the verifier however many files the item touched",
  );
  assert.equal(bundle.truncated, false, "nothing was dropped, so nothing may claim it was");

  rmSync(repo, { recursive: true, force: true });
});

test("a reorder moves the queue's change token, so a second tab learns about it", async () => {
  // `SessionQueueSummary` projects counts and the in-flight item but never `seq`, so
  // a reorder is byte-identical to it and `syncSessionsForQueue`'s equality check
  // short-circuits. Without touching the row, the tab that dragged looks right (it
  // refetches itself) while every other reader keeps rendering the old order - and
  // on an idle queue nothing ever heals it.
  seedSession();
  const a = await addItem("first");
  const b = await addItem("second");
  const token = async (): Promise<number> =>
    (await sessions()).find((s) => s.id === "sess-1")!.queue!.updatedAt;

  const before = await token();
  const r = await app.request("/api/sessions/sess-1/queue/order", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ ids: [b.id, a.id] }),
  });
  assert.equal(r.status, 200);

  assert.ok((await token()) > before, "a reorder has to be observable to other tabs");
  const q = (await (await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK })).json()) as {
    items: Array<{ id: string }>;
  };
  assert.deepEqual(q.items.map((i) => i.id), [b.id, a.id], "and it actually reordered");

  for (const i of [a, b]) {
    await app.request(`/api/sessions/sess-1/queue/${i.id}`, { method: "DELETE", headers: LOOPBACK });
  }
});

test("a /clear orphans the queue, and re-attaching it is offered where it can succeed", async () => {
  // The whole point of leaving waiting items intact when a session goes: resuming a
  // batch. `noteKeyFor` is `agentSessionId ?? id`, so a /clear mints a new key and
  // the old queue belongs to nobody - the card offers a re-attach hint keyed on cwd.
  //
  // Terminal items on the TARGET must not block it. They can't collide on the
  // single-flight index (it only covers in-flight states) and nobody is waiting on
  // them, so refusing over them would 409 exactly the case that is safe - and the
  // card would be showing a button that always fails.
  seedSession();
  const hook = (sessionId: string) =>
    app.request("/hooks/Stop", {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ env: { tmuxPane: "%3" }, sessionId, cwd: "/repo/app" }),
    });

  // The session identifies itself as agent session "before-clear" and gets a queue.
  await hook("before-clear");
  const item = await addItem("resume me");
  const stranded = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  assert.equal(((await stranded.json()) as { noteKey: string }).noteKey, "before-clear");

  // /clear: same pane, brand-new agent session id. The queue is now orphaned.
  await hook("after-clear");
  const s = (await sessions()).find((x) => x.id === "sess-1")!;
  assert.equal(s.orphanedQueue?.noteKey, "before-clear", "the card must be told it's there");
  assert.equal(s.orphanedQueue?.itemCount, 1);

  // A finished batch already sitting on the new key must not block the re-attach.
  const done = await addItem("already finished");
  await app.request(`/api/sessions/sess-1/queue/${done.id}/state`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ state: "verified" }),
  });

  const r = await app.request("/api/sessions/sess-1/queue/reattach", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ noteKey: "before-clear" }),
  });
  assert.equal(r.status, 200, "terminal items can't collide, so this has to be allowed");

  const after = await app.request("/api/sessions/sess-1/queue", { headers: LOOPBACK });
  const q = (await after.json()) as {
    noteKey: string;
    items: Array<{ id: string; intent: string; seq: number }>;
  };
  assert.equal(q.noteKey, "after-clear");
  assert.ok(
    q.items.some((i) => i.intent === "resume me"),
    "the stranded work resumes on the live session",
  );
  // Re-attached items are renumbered onto the END of the finished batch. Both runs
  // start their seq at 0, so preserving the source numbering collides - and
  // `listQueueItems` orders by seq with an arbitrary tiebreak, which would leave the
  // resumed work interleaved among items that are already done.
  assert.deepEqual(
    q.items.map((i) => i.intent),
    ["already finished", "resume me"],
    "the resumed work lands after the batch that's already done, not among it",
  );
  assert.equal(new Set(q.items.map((i) => i.seq)).size, q.items.length, "and every seq is distinct");

  for (const i of q.items) {
    await app.request(`/api/sessions/sess-1/queue/${i.id}/state`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ state: "cancelled" }),
    });
    await app.request(`/api/sessions/sess-1/queue/${i.id}`, { method: "DELETE", headers: LOOPBACK });
  }
});

test("/api/sessions/:id/pane serves the child's screen, and 404s an unknown session", async () => {
  // The route Foreman's reviewer reads the pending ask from (see `ReviewInput.pane`): an ask
  // that is BLOCKING on the user is not in the transcript until it returns, so this is the only
  // place it exists.
  seedSession();

  const miss = await app.request("/api/sessions/nope/pane", { headers: LOOPBACK });
  assert.equal(miss.status, 404, "an unknown session is not a null pane - say so");

  // The seeded session names a tmux pane that isn't there, which is exactly how a real capture
  // fails (the pane died, tmux is gone). It must read back as "no screen" rather than a 500:
  // every caller's fallback is the transcript alone, which is the pre-existing behaviour and a
  // safe one - failing the request would turn a lost improvement into a lost review.
  const res = await app.request("/api/sessions/sess-1/pane", { headers: LOOPBACK });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: null });
});
