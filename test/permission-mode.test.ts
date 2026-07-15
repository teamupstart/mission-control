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
const { parsePaneModeLine } = await import("../src/server/discovery/pane-mode.ts");

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

// ---- reading the mode off the pane ----

test("parsePaneModeLine reads every mode Claude renders", () => {
  const cases: Array<[string, string]> = [
    ["⏸ manual mode on", "default"],
    ["⏵⏵ accept edits on", "acceptEdits"],
    ["⏸ plan mode on", "plan"],
    ["⏵⏵ auto mode on", "auto"],
    ["⏵⏵ bypass permissions on", "bypassPermissions"],
    ["⏵⏵ don't ask on", "dontAsk"],
  ];
  for (const [line, mode] of cases) {
    assert.equal(parsePaneModeLine(line)?.mode, mode, line);
  }
});

test("parsePaneModeLine reads a real pane, statusLine and all", () => {
  // Captured from a live session: three lines of the user's ccstatusline, then
  // Claude's own mode line last. The mode line is Claude's, not the statusLine's -
  // which is why this works regardless of what a user configures.
  const pane = [
    "❯ ",
    "──────────────────────────────────────────",
    "  Session: 2m | Ctx Used: 34.0% | Total...        /rc",
    "  Model: Opus 4.8 | Thinking: xhigh",
    "  cwd: /Users/jordanmance/.treehouse/ai...",
    "  ⏵⏵ auto mode on · 1 shell · ← 3 agents",
    "",
  ].join("\n");
  assert.deepEqual(parsePaneModeLine(pane), { text: "auto mode on", mode: "auto" });
});

test("parsePaneModeLine tolerates the typographic apostrophe in don't ask", () => {
  assert.equal(parsePaneModeLine("⏵⏵ don’t ask on · 2 agents")?.mode, "dontAsk");
});

test("parsePaneModeLine ignores the trailing `·` segments", () => {
  const line = parsePaneModeLine("⏸ manual mode on · ← 3 agents");
  // The text is the cycle position's identity, so it must not drift with the
  // agent/shell counts that trail it - those change on their own.
  assert.deepEqual(line, { text: "manual mode on", mode: "default" });
});

test("parsePaneModeLine finds nothing when a dialog covers the mode line", () => {
  // A real `/model` picker: Claude replaces the footer entirely, so there is no
  // mode to read - and Shift+Tab would be swallowed by the dialog.
  const pane = [
    "    4. Sonnet                   Sonnet 5 · Efficient for routine tasks",
    "    5. Haiku                    Haiku 4.5 · Fastest for quick answers",
    "  ◉ xHigh effort ←/→ to adjust",
    "  Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n");
  assert.equal(parsePaneModeLine(pane), null);
});

test("parsePaneModeLine doesn't mistake transcript prose for the mode line", () => {
  // An agent discussing modes must not be read as being in one. The wording has
  // to *start* a line near the bottom, which prose about it doesn't.
  const pane = [
    "⏺ I checked and the session already has auto mode on, so no change is needed.",
    "  Toggling plan mode on would just slow it down.",
    "",
  ].join("\n");
  assert.equal(parsePaneModeLine(pane), null);
});

test("parsePaneModeLine keeps a mode line it doesn't recognize as a cycle position", () => {
  // A newer Claude's wording, or a mode gated behind a flag we can't observe. We
  // can't label it, but the walk still has to be able to step through it.
  assert.deepEqual(parsePaneModeLine("⏵⏵ yolo mode on · 1 shell"), {
    text: "yolo mode on",
    mode: null,
  });
});

test("parsePaneModeLine needs a glyph before trusting unfamiliar wording", () => {
  assert.equal(parsePaneModeLine("the build is on"), null);
});

test("parsePaneModeLine handles an empty or missing capture", () => {
  assert.equal(parsePaneModeLine(""), null);
  assert.equal(parsePaneModeLine(null), null);
});

// ---- the chip's sources, in priority order ----

test("a mode read off the pane outranks the hook's", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "plan" }));
  // The user pressed Shift+Tab in the terminal. No hook fires for that, so the
  // overlay still says `plan` - but the pane says otherwise, and the pane wins.
  r.applyDiscovery([disco({ permissionMode: "auto" })]);
  assert.equal(modeOf(r), "auto");
});

test("an unreadable pane keeps the hook's mode rather than blanking the chip", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "acceptEdits" }));
  r.applyDiscovery([disco()]); // no permissionMode: a dialog covered the mode line
  assert.equal(modeOf(r), "acceptEdits");
});

test("a hook carrying permission_mode lands it on the bound session", () => {
  const r = seeded();
  assert.equal(modeOf(r), null); // discovery alone knew no mode
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

// ---- recording a mode we just observed ----

test("an observed mode updates the chip immediately, before the next sweep", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "default" }));
  let emitted = 0;
  r.subscribe((e) => {
    if (e.type === "session_upsert" && e.session.id === "s1") emitted++;
  });
  r.recordObservedPermissionMode("s1", "plan");
  assert.equal(modeOf(r), "plan");
  assert.equal(emitted, 1); // the card re-renders right away
});

test("an observed mode survives a discovery sweep that couldn't read the pane", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "default" }));
  r.recordObservedPermissionMode("s1", "acceptEdits");
  r.applyDiscovery([disco()]); // pane unreadable; must not revert to the hook's default
  assert.equal(modeOf(r), "acceptEdits");
});

test("an unknown observation is ignored rather than blanking the chip", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "plan" }));
  r.recordObservedPermissionMode("s1", null); // the walk couldn't read the pane
  assert.equal(modeOf(r), "plan");
});

test("re-observing the same mode emits nothing (no pointless re-render)", () => {
  const r = seeded();
  r.applyHook(hook({ event: "UserPromptSubmit", permissionMode: "plan" }));
  let emitted = 0;
  r.subscribe((e) => {
    if (e.type === "session_upsert" && e.session.id === "s1") emitted++;
  });
  r.recordObservedPermissionMode("s1", "plan");
  assert.equal(emitted, 0);
});

test("an observed mode never revives an overlay that aged past its TTL", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const r = seeded();
  r.applyHook(hook({ event: "Notification", message: "waiting for you", permissionMode: "default" }));
  // The session goes quiet for longer than OVERLAY_TTL_MS (30 min). No hook has
  // arrived from any pane, so nothing pruned the now-dead overlay.
  t.mock.timers.tick(31 * 60 * 1000);
  r.recordObservedPermissionMode("s1", "acceptEdits");
  r.applyDiscovery([disco()]);

  const s = r.snapshot().sessions.find((x) => x.id === "s1")!;
  assert.equal(s.permissionMode, "acceptEdits"); // the observation still carries (via prev)
  // ...but the half-hour-old overlay stays dead rather than being stamped fresh
  // and re-applied wholesale over the card.
  assert.equal(s.instrumented, false);
  assert.equal(s.state, "working"); // discovery's value, not the overlay's awaiting_input
});
