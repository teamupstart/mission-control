import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { HookIngest } from "@shared/protocol.ts";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-mode-"));
const { Registry, normalizePermissionMode, nextPermissionMode } = await import(
  "../src/server/registry.ts"
);

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

test("nextPermissionMode advances the steps that hold in every config", () => {
  assert.equal(nextPermissionMode("default"), "acceptEdits");
  assert.equal(nextPermissionMode("acceptEdits"), "plan");
});

test("nextPermissionMode declines to guess when it can't", () => {
  assert.equal(nextPermissionMode(null), null); // mode not yet known
  assert.equal(nextPermissionMode("dontAsk"), null); // never part of the cycle
  // After `plan` the landing mode depends on whether this session enabled the
  // optional modes, which we can't see. Guessing "default" would paint a session
  // that's skipping every permission check with the safe "manual" chip.
  assert.equal(nextPermissionMode("plan"), null);
  assert.equal(nextPermissionMode("bypassPermissions"), null);
  assert.equal(nextPermissionMode("auto"), null);
});

test("optimistic cycle advances the chip immediately, before any hook", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "default" }));
  let emitted = 0;
  r.subscribe((e) => {
    if (e.type === "session_upsert" && e.session.id === "s1") emitted++;
  });
  r.optimisticCyclePermissionMode("s1");
  assert.equal(modeOf(r), "acceptEdits");
  assert.equal(emitted, 1); // the card re-renders right away
});

test("an optimistic cycle survives a discovery sweep (overlay advanced too)", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "default" }));
  r.optimisticCyclePermissionMode("s1"); // -> acceptEdits
  r.applyDiscovery([disco()]); // same session re-observed; must not revert to default
  assert.equal(modeOf(r), "acceptEdits");
});

test("a real hook, not a guess, resolves the ambiguous step after plan", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "plan" }));
  r.optimisticCyclePermissionMode("s1");
  // This session has bypassPermissions enabled, so Shift+Tab actually landed
  // there - which we can't know. Rather than claim the safe "manual" chip, the
  // chip holds until a hook carries the truth.
  assert.equal(modeOf(r), "plan");
  r.applyHook(hook({ event: "PreToolUse", permissionMode: "bypassPermissions" }));
  assert.equal(modeOf(r), "bypassPermissions");
});

test("an optimistic cycle never revives an overlay that aged past its TTL", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const r = seeded();
  r.applyHook(hook({ event: "Notification", message: "waiting for you", permissionMode: "default" }));
  // The session goes quiet for longer than OVERLAY_TTL_MS (30 min). No hook has
  // arrived from any pane, so nothing pruned the now-dead overlay.
  t.mock.timers.tick(31 * 60 * 1000);
  r.optimisticCyclePermissionMode("s1"); // default -> acceptEdits
  r.applyDiscovery([disco()]);

  const s = r.snapshot().sessions.find((x) => x.id === "s1")!;
  assert.equal(s.permissionMode, "acceptEdits"); // the optimistic chip still carries (via prev)
  // ...but the half-hour-old overlay stays dead rather than being stamped fresh
  // and re-applied wholesale over the card.
  assert.equal(s.instrumented, false);
  assert.equal(s.state, "working"); // discovery's value, not the overlay's awaiting_input
});

test("optimistic cycle is a no-op when the mode is unknown", () => {
  const r = seeded();
  assert.equal(modeOf(r), null); // no hook yet
  r.optimisticCyclePermissionMode("s1");
  assert.equal(modeOf(r), null); // nothing to advance from - wait for a real hook
});
