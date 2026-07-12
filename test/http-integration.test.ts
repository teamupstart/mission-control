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
const { buildApp } = await import("../src/server/routes.ts");
const { normTty } = await import("../src/server/discovery/tty.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session } from "../src/shared/types.ts";

openDb();
const TOKEN = ensureToken();

const registry = new Registry();
const reviews = new ReviewManager(registry);
const tasks = new TaskManager(registry);
const app = buildApp(registry, reviews, tasks);

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
