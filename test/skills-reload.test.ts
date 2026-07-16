import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/shared/types.ts";
import type { SkillsConfig } from "../src/shared/protocol.ts";
import { pendingReloads, reloadTargets } from "../src/server/skills/reload.ts";

// The reload selector: who gets `/reload-skills` typed into their pane, unprompted, by
// a machine. It's pure with `now` injected for the reason decideQueueTick is - a
// selector is policy, and a session missing from it is a branch that can never run.
//
// The assertion that matters is the NEGATIVE one. Every false here is a keystroke not
// fired into a session that wasn't ready for it.

const NOW = 1_000_000;
const SETTLE = 10_000;

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    agent: "claude",
    name: "work",
    nameSource: "tmux",
    state: "idle",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys001",
    permissionMode: null,
    wezterm: null,
    tmux: { session: "work", window: "w", windowIndex: 0, paneId: "%1" },
    agentSessionId: "agent-1",
    transcriptPath: null,
    instrumented: true,
    hooksSeen: true,
    activity: "idle",
    // Started long before the generation moved, so a test opts INTO "booted after".
    startedAt: 0,
    firstSeen: 0,
    lastSeen: NOW,
    // Settled well past settleMs, so a test opts INTO un-settled.
    lastActivity: NOW - 60_000,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesFixes: [],
    task: null,
    nomistakesNarration: null,
    prUrl: null,
    prState: null,
    prChecks: null,
    prNumber: null,
    model: null,
    contextPercent: null,
    contextTokens: null,
    effort: null,
    thinkingEnabled: null,
    queue: null,
    ...over,
  } as Session;
}

/** A generation that moved at NOW - 100_000, i.e. before every default session. */
function mkCfg(over: Partial<SkillsConfig> = {}): SkillsConfig {
  return { enabled: true, skills: {}, generation: 3, generationAt: NOW - 100_000, ...over };
}

const acks = (m: Record<string, number> = {}): Map<string, number> => new Map(Object.entries(m));

function picked(sessions: Session[], a = acks(), cfg = mkCfg()): string[] {
  return reloadTargets(sessions, a, cfg, NOW, SETTLE).map((s) => s.id);
}

test("a settled, behind claude session is selected", () => {
  assert.deepEqual(picked([mkSession()]), ["s1"]);
});

test("a codex session is NEVER selected", () => {
  // Codex has no /reload-skills and no ~/.claude/skills. Typing it there leaves a
  // stray line in someone's prompt and changes nothing.
  assert.deepEqual(picked([mkSession({ agent: "codex" })]), []);
});

test("an exited session is never selected", () => {
  assert.deepEqual(picked([mkSession({ state: "exited" })]), []);
});

test("THE assertion: an awaiting_input session is never selected", () => {
  // This is the one the whole gate exists for. An agent waiting on a human is very
  // often sitting on a permission DIALOG - a select list, not a text prompt - where
  // the pasted text is swallowed and the Enter answers whichever option is
  // highlighted. Fired fleet-wide that's an unattended "yes" in every pane at once.
  assert.deepEqual(picked([mkSession({ state: "awaiting_input" })]), []);
});

test("a session that is still working is not selected", () => {
  assert.deepEqual(picked([mkSession({ state: "working" })]), []);
});

test("an idle session that hasn't settled yet is not selected", () => {
  // Hooks are independent HTTP posts, so a PostToolUse can land after a Stop and
  // briefly un-idle a session. The settle window absorbs that reordering.
  assert.deepEqual(picked([mkSession({ lastActivity: NOW - 1000 })]), []);
});

test("an UNINSTRUMENTED idle session is not selected", () => {
  // `settledIdle` and not `reportBucket(s) === "idle"`, and this is why: idle is that
  // function's catch-all fallthrough, so an uninstrumented session reads idle by
  // DEFAULT rather than by report. Nobody said this session was at a prompt.
  assert.deepEqual(picked([mkSession({ instrumented: false })]), []);
});

test("a session already at the current generation is not selected", () => {
  assert.deepEqual(picked([mkSession()], acks({ "agent-1": 3 })), []);
});

test("a session ahead of the generation is not selected", () => {
  // Can't happen from the config path (the generation only climbs), but an ack must
  // never be read as "behind" merely because it isn't equal.
  assert.deepEqual(picked([mkSession()], acks({ "agent-1": 9 })), []);
});

test("a session behind by any amount is selected exactly once - a watermark, not a queue", () => {
  // Five toggles in ten seconds land at generation 5. ONE reload re-reads the whole
  // directory and satisfies all five; a queue would have typed five commands.
  const cfg = mkCfg({ generation: 5 });
  assert.deepEqual(picked([mkSession()], acks({ "agent-1": 0 }), cfg), ["s1"]);
  assert.deepEqual(picked([mkSession()], acks({ "agent-1": 4 }), cfg), ["s1"]);
  assert.deepEqual(picked([mkSession()], acks({ "agent-1": 5 }), cfg), []);
});

test("a session that booted AFTER the change is not selected", () => {
  // It scanned ~/.claude/skills at startup and already has the current set. Without
  // this, every session discovered from here to the end of time gets an unsolicited
  // /reload-skills the first time it goes quiet: no ack row, and 0 < generation.
  const cfg = mkCfg({ generationAt: NOW - 100_000 });
  assert.deepEqual(picked([mkSession({ startedAt: NOW - 50_000 })], acks(), cfg), []);
  assert.deepEqual(picked([mkSession({ startedAt: NOW - 150_000 })], acks(), cfg), ["s1"]);
});

test("a session with no known start time is selected - unknown is not proof of freshness", () => {
  assert.deepEqual(picked([mkSession({ startedAt: null })]), ["s1"]);
});

test("generation 0 owes nobody anything", () => {
  // The symlink set has never changed, so nothing on the machine is out of date and
  // no pane gets typed into. This is the state a fresh install sits in forever unless
  // someone actually toggles something.
  assert.deepEqual(picked([mkSession()], acks(), mkCfg({ generation: 0 })), []);
});

test("the master switch being OFF does not stop reloads", () => {
  // Turning it off empties the desired set, which unlinks everything, which bumps the
  // generation - and those sessions need a reload to DROP the skills. A loop that went
  // quiet with the switch would leave the fleet using skills the panel says are off,
  // which is the worst state this feature has.
  assert.deepEqual(picked([mkSession()], acks(), mkCfg({ enabled: false })), ["s1"]);
});

test("the selector picks only the sessions that are ready, out of a mixed fleet", () => {
  const fleet = [
    mkSession({ id: "ready", agentSessionId: "a-ready" }),
    mkSession({ id: "codex", agentSessionId: "a-codex", agent: "codex" }),
    mkSession({ id: "busy", agentSessionId: "a-busy", state: "working" }),
    mkSession({ id: "asking", agentSessionId: "a-asking", state: "awaiting_input" }),
    mkSession({ id: "current", agentSessionId: "a-current" }),
    mkSession({ id: "gone", agentSessionId: "a-gone", state: "exited" }),
  ];
  assert.deepEqual(picked(fleet, acks({ "a-current": 3 })), ["ready"]);
});

// ---- the panel's count ----

test("pendingReloads counts who is BEHIND, not who is ready this instant", () => {
  // The count answers "who hasn't picked this up yet". A working session is behind and
  // the human should be told so - it just isn't a target until it settles.
  const fleet = [
    mkSession({ id: "ready", agentSessionId: "a-ready" }),
    mkSession({ id: "busy", agentSessionId: "a-busy", state: "working" }),
  ];
  assert.equal(pendingReloads(fleet, acks(), mkCfg()), 2);
  assert.deepEqual(picked(fleet), ["ready"]);
});

test("pendingReloads excludes a session with no pane - it can never be reloaded", () => {
  // `capturePaneText` answers null for a handleless session, so the gate refuses it every
  // tick until it exits. Counting it promises a pick-up that cannot happen, and the
  // counter never reaches zero.
  const fleet = [mkSession({ id: "nopane", agentSessionId: "a-np", tmux: null, wezterm: null })];
  assert.equal(pendingReloads(fleet, acks(), mkCfg()), 0);
  assert.deepEqual(picked(fleet), []);
});

test("pendingReloads excludes a session that has never had hooks", () => {
  // Nothing will ever report it idle, so `settledIdle` can never be true and no reload
  // can ever fire. `hooksSeen` is the permanent fact; counting on it keeps the number
  // honest without making a merely-quiet session vanish from the count.
  const fleet = [mkSession({ id: "raw", agentSessionId: "a-raw", hooksSeen: false })];
  assert.equal(pendingReloads(fleet, acks(), mkCfg()), 0);
  assert.deepEqual(picked(fleet), []);
});

test("a session that has simply GONE QUIET is still counted, though it can't be typed into yet", () => {
  // `instrumented` is a 30-minute freshness window, so a healthy idle session flips it to
  // false just by being left alone - the single most common state in this fleet. It is
  // still owed the skill, so the count must keep saying so; it just isn't safe to type
  // into until a hook proves it's really there.
  const quiet = mkSession({ id: "quiet", agentSessionId: "a-quiet", instrumented: false });
  assert.equal(pendingReloads([quiet], acks(), mkCfg()), 1, "still owed");
  assert.deepEqual(picked([quiet]), [], "but not typed into on a stale signal");
});

test("pendingReloads excludes codex, or the number can never reach zero", () => {
  const fleet = [
    mkSession({ id: "c1", agentSessionId: "a-c1" }),
    mkSession({ id: "x1", agentSessionId: "a-x1", agent: "codex" }),
  ];
  assert.equal(pendingReloads(fleet, acks(), mkCfg()), 1);
});

test("pendingReloads reaches zero once everyone has acked", () => {
  const fleet = [mkSession({ id: "c1", agentSessionId: "a-c1" })];
  assert.equal(pendingReloads(fleet, acks({ "a-c1": 3 }), mkCfg()), 0);
});
