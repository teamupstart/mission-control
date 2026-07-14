import { test } from "node:test";
import assert from "node:assert/strict";
import { hookToState, isIdleNudge, overlayKeyFromEnv, sessionKey } from "../src/server/registry.ts";
import { reportBucket } from "../src/shared/session.ts";
import type { HookIngest } from "../src/shared/protocol.ts";
import type { Session } from "../src/shared/types.ts";

function evt(p: Partial<HookIngest> & Pick<HookIngest, "event">): HookIngest {
  return { sessionId: null, cwd: null, transcriptPath: null, env: {}, ...p };
}

function sessionFixture(p: Partial<Session> = {}): Session {
  return {
    id: "x",
    agent: "claude",
    name: "n",
    nameSource: "tmux",
    state: "working",
    cwd: null,
    gitBranch: null,
    nomistakesGated: false,
    pid: 1,
    tty: "ttys1",
    permissionMode: null,
    wezterm: { paneId: 7, tabId: 1, windowId: 0, tabTitle: "t", isActive: false },
    tmux: { session: "s", window: "w", windowIndex: 0, paneId: "%3" },
    agentSessionId: null,
    transcriptPath: null,
    instrumented: false,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    task: null,
    nomistakesNarration: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    meta: null,
    note: null,
    ...p,
  };
}

test("hookToState maps lifecycle events to session states", () => {
  assert.equal(hookToState(evt({ event: "UserPromptSubmit", prompt: "do x" })).state, "working");
  assert.equal(hookToState(evt({ event: "PreToolUse", toolName: "Bash" })).state, "working");
  assert.equal(hookToState(evt({ event: "Notification", message: "need perms" })).state, "awaiting_input");
  assert.equal(hookToState(evt({ event: "Stop" })).state, "idle");
  assert.equal(hookToState(evt({ event: "SessionStart", source: "startup" })).state, "idle");
  assert.equal(hookToState(evt({ event: "SessionEnd", reason: "clear" })).state, "exited");
});

// Regression: Claude Code fires `Notification` for two unrelated things - a real
// permission ask, and a ~60s idle timer on the prompt. Both used to map to
// `awaiting_input`, so every session that simply went quiet claimed it needed you a
// minute later, and (worse) it could never leave that state on its own.
test("hookToState maps Claude's idle nudge to idle, never to awaiting_input", () => {
  const idle = hookToState(evt({ event: "Notification", message: "Claude is waiting for your input" }));
  assert.notEqual(idle.state, "awaiting_input");
  assert.equal(idle.state, "idle");
  assert.equal(idle.activity, "idle"); // reads exactly like Stop - it's the same situation

  // A genuine ask still needs you...
  assert.equal(
    hookToState(evt({ event: "Notification", message: "Claude needs your permission to use Bash" })).state,
    "awaiting_input",
  );
  // ...and so does anything we don't positively recognize as the nudge.
  assert.equal(hookToState(evt({ event: "Notification", message: "some future notice" })).state, "awaiting_input");
  assert.equal(hookToState(evt({ event: "Notification" })).state, "awaiting_input");
});

test("isIdleNudge recognizes only the idle notification", () => {
  assert.equal(isIdleNudge("Claude is waiting for your input"), true);
  assert.equal(isIdleNudge("CLAUDE IS WAITING FOR YOUR INPUT"), true);
  assert.equal(isIdleNudge("Claude needs your permission to use Bash"), false);
  assert.equal(isIdleNudge(undefined), false);
  assert.equal(isIdleNudge(null), false);
});

// The symptom this fix exists for: the idle nudge used to drag a settled session
// into the one bucket that's meant to be pure signal.
test("a session parked by the idle nudge reports idle, not needs-you", () => {
  const s = sessionFixture({
    state: hookToState(evt({ event: "Notification", message: "Claude is waiting for your input" })).state,
    instrumented: true,
  });
  assert.equal(reportBucket(s, [s]), "idle");

  const asking = sessionFixture({
    state: hookToState(evt({ event: "Notification", message: "Claude needs your permission to use Bash" })).state,
    instrumented: true,
  });
  assert.equal(reportBucket(asking, [asking]), "needs-you");
});

test("hookToState surfaces a readable activity line", () => {
  assert.equal(hookToState(evt({ event: "PreToolUse", toolName: "Edit" })).activity, "running Edit");
  assert.equal(hookToState(evt({ event: "UserPromptSubmit", prompt: "refactor  the   parser" })).activity, "refactor the parser");
  assert.equal(hookToState(evt({ event: "Notification", message: "grant access" })).activity, "grant access");
});

test("overlayKeyFromEnv prefers the tmux pane over the outer wezterm pane", () => {
  assert.equal(overlayKeyFromEnv({ tmuxPane: "%3", weztermPane: "7" }), "tmux:%3");
  assert.equal(overlayKeyFromEnv({ weztermPane: "7" }), "wez:7");
  assert.equal(overlayKeyFromEnv({}), null);
});

test("sessionKey matches a session's own pane, tmux preferred", () => {
  const base = sessionFixture();
  assert.equal(sessionKey(base), "tmux:%3");
  assert.equal(sessionKey({ ...base, tmux: null }), "wez:7");
  assert.equal(sessionKey({ ...base, tmux: null, wezterm: null }), null);
});

test("the hook overlay key and session key agree, so binding works", () => {
  // A hook fired inside tmux carries the tmux pane; the discovered session
  // carries the same tmux pane -> the keys must match.
  const hookKey = overlayKeyFromEnv({ tmuxPane: "%3", weztermPane: "7" });
  const sess = { tmux: { paneId: "%3" }, wezterm: { paneId: 7 } } as unknown as Session;
  assert.equal(hookKey, sessionKey(sess));
});
