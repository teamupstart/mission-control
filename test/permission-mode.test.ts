import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { HookIngest } from "@shared/protocol.ts";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-mode-"));
const { Registry, normalizePermissionMode } = await import("../src/server/registry.ts");

const PANE = { session: "w", window: "w", windowIndex: 0, paneId: "%3" };

function disco(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "s1",
    agent: "claude",
    name: "n",
    nameSource: "tmux",
    cwd: "/repo/app",
    gitBranch: "main",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    wezterm: null,
    tmux: PANE,
    startedAt: 0,
    ...over,
  };
}

function seeded(): InstanceType<typeof Registry> {
  const r = new Registry();
  r.applyDiscovery([disco()]);
  return r;
}

const hook = (over: Partial<HookIngest> & Pick<HookIngest, "event">): HookIngest => ({
  sessionId: null,
  cwd: null,
  transcriptPath: null,
  env: { tmuxPane: "%3" },
  ...over,
});

function modeOf(r: InstanceType<typeof Registry>, id = "s1"): string | null {
  return r.snapshot().sessions.find((s) => s.id === id)?.permissionMode ?? null;
}

test("normalizePermissionMode keeps known modes and rejects everything else", () => {
  for (const m of ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]) {
    assert.equal(normalizePermissionMode(m), m);
  }
  assert.equal(normalizePermissionMode("yolo"), null); // a mode we don't know
  assert.equal(normalizePermissionMode(""), null);
  assert.equal(normalizePermissionMode(undefined), null);
  assert.equal(normalizePermissionMode(null), null);
});

test("a hook carrying permission_mode lands it on the bound session", () => {
  const r = seeded();
  assert.equal(modeOf(r), null); // discovery alone knows no mode
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "acceptEdits" }));
  assert.equal(modeOf(r), "acceptEdits");
  r.applyHook(hook({ event: "PreToolUse", permissionMode: "plan" }));
  assert.equal(modeOf(r), "plan");
});

test("a mode change emits a session update (so the card re-renders)", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "default" }));
  let emitted = false;
  r.subscribe((e) => {
    if (e.type === "session_upsert" && e.session.id === "s1") emitted = true;
  });
  r.applyHook(hook({ event: "PreToolUse", permissionMode: "acceptEdits" }));
  assert.equal(emitted, true);
});

test("an event that omits the mode keeps the last-known one, not null", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "plan" }));
  r.applyHook(hook({ event: "PostToolUse", toolName: "Read" })); // no permission_mode
  assert.equal(modeOf(r), "plan");
});

test("an unrecognized mode string doesn't clobber a known mode", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "acceptEdits" }));
  r.applyHook(hook({ event: "PreToolUse", permissionMode: "some-new-mode" }));
  assert.equal(modeOf(r), "acceptEdits");
});

test("the mode survives a later discovery sweep (overlay carries it)", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "bypassPermissions" }));
  r.applyDiscovery([disco()]); // same session re-observed
  assert.equal(modeOf(r), "bypassPermissions");
});
