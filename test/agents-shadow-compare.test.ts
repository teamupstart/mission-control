import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session, SessionState } from "../src/shared/types.ts";
import type { AgentsJsonRecord } from "../src/server/discovery/agents-json.ts";
import { compareAgents, formatShadowSummary } from "../src/server/discovery/agents-shadow.ts";

// This comparison exists to decide whether Claude's own session state can replace ours,
// so its arithmetic has to be trustworthy in the direction that would embarrass us: it
// must never manufacture agreement. The states Claude cannot know about (`awaiting_review`
// is a Foreman concept) and the records it reports without a status are the two ways a
// naive diff would either invent a disagreement or hide a real one, and both are pinned
// here. `agree + disagree` is deliberately NOT the whole population - `skipped` is
// counted so nobody reads a ratio off the wrong denominator.

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s",
    agent: "claude",
    name: "sess",
    nameSource: "process",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    nomistakesNarration: null,
    pid: 1,
    tty: null,
    permissionMode: null,
    wezterm: null,
    tmux: null,
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesFixes: [],
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    orphanedQueue: null,
    paneDialog: null,
    inspector: null,
    ...over,
  };
}

const rec = (over: Partial<AgentsJsonRecord> & { sessionId: string }): AgentsJsonRecord => ({
  id: over.sessionId.slice(0, 8),
  ...over,
});

test("joins on agentSessionId and counts agreement", () => {
  const sessions = [
    mkSession({ id: "a", agentSessionId: "aaaa1111-0000-0000-0000-000000000000", state: "working" }),
    mkSession({ id: "b", agentSessionId: "bbbb2222-0000-0000-0000-000000000000", state: "idle" }),
  ];
  const records = [
    rec({ sessionId: "aaaa1111-0000-0000-0000-000000000000", status: "busy" }),
    rec({ sessionId: "bbbb2222-0000-0000-0000-000000000000", status: "idle" }),
  ];
  const s = compareAgents(sessions, records);
  assert.equal(s.joined, 2);
  assert.equal(s.agree, 2);
  assert.equal(s.disagree, 0);
  assert.equal(s.unjoined, 0);
  assert.equal(s.claudeOnly, 0);
});

test("records a disagreement with both readings and the reason", () => {
  const sessions = [
    mkSession({ agentSessionId: "cccc3333-0000-0000-0000-000000000000", state: "idle", pid: 4242 }),
  ];
  const records = [
    rec({
      sessionId: "cccc3333-0000-0000-0000-000000000000",
      status: "waiting",
      waitingFor: "permission prompt",
    }),
  ];
  const s = compareAgents(sessions, records);
  assert.equal(s.disagree, 1);
  assert.deepEqual(s.disagreements[0], {
    sessionId: "cccc3333-0000-0000-0000-000000000000",
    pid: 4242,
    mission: "idle",
    claude: "awaiting_input",
    waitingFor: "permission prompt",
  });
});

test("our-only states are skipped, never counted as disagreements", () => {
  // awaiting_review is a Foreman concept; Claude has no way to report it, so scoring it
  // against Claude's "idle" would invent a permanent, meaningless deficit.
  for (const state of ["starting", "awaiting_review", "exited"] as SessionState[]) {
    const s = compareAgents(
      [mkSession({ agentSessionId: "dddd4444-0000-0000-0000-000000000000", state })],
      [rec({ sessionId: "dddd4444-0000-0000-0000-000000000000", status: "idle" })],
    );
    assert.equal(s.skipped, 1, `${state} should be skipped`);
    assert.equal(s.disagree, 0, `${state} must not count as a disagreement`);
    assert.equal(s.agree, 0);
  }
});

test("a joined record with no status is skipped, not scored", () => {
  const s = compareAgents(
    [mkSession({ agentSessionId: "eeee5555-0000-0000-0000-000000000000", state: "working" })],
    [rec({ sessionId: "eeee5555-0000-0000-0000-000000000000" })],
  );
  assert.equal(s.joined, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.agree + s.disagree, 0);
});

test("counts sessions each side can see and the other cannot", () => {
  const sessions = [
    mkSession({ id: "mine", agentSessionId: "ffff6666-0000-0000-0000-000000000000" }),
    mkSession({ id: "unbound", agentSessionId: null }),
  ];
  const records = [
    rec({ sessionId: "ffff6666-0000-0000-0000-000000000000", status: "busy" }),
    rec({ sessionId: "9999aaaa-0000-0000-0000-000000000000", status: "idle" }),
  ];
  const s = compareAgents(sessions, records);
  assert.equal(s.joined, 1);
  assert.equal(s.unjoined, 1, "a session with no agentSessionId cannot be joined");
  assert.equal(s.claudeOnly, 1, "the background agent we are blind to");
});

test("codex sessions are excluded rather than counted as a permanent miss", () => {
  // `claude agents --json` cannot see Codex at all, so counting Codex sessions as
  // unjoined would report a deficit that can never be closed and would drown the signal.
  const s = compareAgents(
    [
      mkSession({ agent: "codex", agentSessionId: null, state: "working" }),
      mkSession({ agent: "claude", agentSessionId: "1111bbbb-0000-0000-0000-000000000000" }),
    ],
    [rec({ sessionId: "1111bbbb-0000-0000-0000-000000000000", status: "busy" })],
  );
  assert.equal(s.missionCount, 1, "only the claude session is in scope");
  assert.equal(s.unjoined, 0);
  assert.equal(s.agree, 1);
});

test("the summary line reports every bucket, so no ratio is read off a wrong denominator", () => {
  const s = compareAgents(
    [
      mkSession({ agentSessionId: "2222cccc-0000-0000-0000-000000000000", state: "idle" }),
      mkSession({ agentSessionId: "3333dddd-0000-0000-0000-000000000000", state: "awaiting_review" }),
    ],
    [
      rec({ sessionId: "2222cccc-0000-0000-0000-000000000000", status: "busy" }),
      rec({ sessionId: "3333dddd-0000-0000-0000-000000000000", status: "idle" }),
    ],
  );
  const [head, ...rest] = formatShadowSummary(s);
  assert.ok(head);
  assert.match(head, /mission=2/);
  assert.match(head, /joined=2/);
  assert.match(head, /agree=0/);
  assert.match(head, /disagree=1/);
  assert.match(head, /skipped=1/);
  assert.equal(rest.length, 1, "one line per disagreement");
  assert.match(rest[0]!, /mission=idle claude=working/);
});
