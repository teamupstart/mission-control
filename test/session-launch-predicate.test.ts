import { test } from "node:test";
import assert from "node:assert/strict";
import { mkSession } from "./helpers/session-fixture.ts";
import { AGENT_TYPES, type AgentType, type Session } from "../src/shared/types.ts";
import { HARNESS_CAPABILITIES } from "../src/shared/harness-capabilities.ts";
import {
  agentLaunchAction,
  agentLaunchBlockedReason,
  shellLaunchBlockedReason,
  type LaunchableSession,
} from "../src/shared/session-launch.ts";

/*
 * What is at stake: this predicate is read from BOTH ends of the same decision. The browser
 * asks it to shape the launcher - whether the agent button raises a pane, opens a chooser,
 * or greys out with a sentence - and the daemon asks it to refuse a request that disagrees.
 * So every session shape has to land on exactly one of focus / resume / blocked. A shape
 * belonging to none is a dead button nobody can explain; a shape belonging to two is the
 * race the whole file exists to rule out - a UI offering resume over a live pane, and a
 * route that takes it, which is two agents appending to one conversation file.
 *
 * The order is part of the contract, not an implementation detail. The pane check runs
 * first, so a session with a terminal stays focusable whatever its harness can do with a
 * conversation id. And a refusal is a SENTENCE: "this harness cannot reopen a conversation",
 * "it has not reported an id yet" and "it has no checkout" are three different things for a
 * human to do, and one greyed control covers all three equally badly.
 */

/**
 * Run `body` with one harness declaring it cannot resume.
 *
 * Every harness shipped today answers `resumes: true` - `harness-resume.test.ts` pins that
 * against three real installs - so the refusal branch is unreachable from a fixture alone.
 * It is not dead code: the flag exists precisely so a harness MAY answer false, and the two
 * claims that turn on it (the pane check winning anyway, and the refusal being its own
 * sentence) are only checkable by declaring one that does. Restored in a `finally` so the
 * rest of the file still sees the shipped record.
 */
function withoutResume<T>(agent: AgentType, body: () => T): T {
  const before = HARNESS_CAPABILITIES[agent].resumes;
  HARNESS_CAPABILITIES[agent].resumes = false;
  try {
    return body();
  } finally {
    HARNESS_CAPABILITIES[agent].resumes = before;
  }
}

/** The fixture is pane-backed as it stands, which is the "focus" shape. */
const paneBacked = (over: Partial<Session> = {}): LaunchableSession => mkSession(over);

/** Embedded: the driver holds the conversation and there is no pane anywhere. */
const embedded = (over: Partial<Session> = {}): LaunchableSession =>
  mkSession({ runtime: "sdk", terminals: [], tty: null, ...over });

/** The agent died and left its conversation behind. Still a terminal-runtime session. */
const survivingConversation = (over: Partial<Session> = {}): LaunchableSession =>
  mkSession({ state: "exited", terminals: [], tty: null, ...over });

test("a session with a pane is focused, never resumed", () => {
  assert.equal(agentLaunchAction(paneBacked()), "focus");
  assert.equal(agentLaunchBlockedReason(paneBacked()), null);
});

test("the pane check comes first, ahead of anything about the harness", () => {
  // Asking about resume first would grey out a button that only ever needed to raise a
  // window - the harness's command line is not consulted on this path at all.
  withoutResume("claude", () => {
    assert.equal(agentLaunchAction(paneBacked()), "focus");
    assert.equal(agentLaunchBlockedReason(paneBacked()), null);
  });
});

test("an embedded session with a conversation id and a checkout hands off", () => {
  const session = embedded();
  assert.equal(agentLaunchAction(session), "handoff");
  assert.equal(agentLaunchBlockedReason(session), null);
});

test("an exited session that left its conversation behind still resumes", () => {
  // The case that makes the feature worth having: the agent is gone, the pane is gone, and
  // the transcript on disk is the only thing left. Reading "no pane" as "nothing to do"
  // here would strand every conversation the moment its process died.
  const session = survivingConversation();
  assert.equal(agentLaunchAction(session), "resume");
  assert.equal(agentLaunchBlockedReason(session), null);
});

test("an exited session resumes even while stale pane handles linger", () => {
  const session = paneBacked({ state: "exited" });
  assert.equal(agentLaunchAction(session), "resume");
  assert.equal(agentLaunchBlockedReason(session), null);
});

test("no conversation id yet is refused, and the refusal says which id", () => {
  const session = embedded({ agentSessionId: null });
  assert.equal(agentLaunchAction(session), null);
  assert.match(agentLaunchBlockedReason(session) ?? "", /conversation id/);
});

test("no checkout is refused, and the refusal says so", () => {
  const session = embedded({ cwd: null });
  assert.equal(agentLaunchAction(session), null);
  assert.match(agentLaunchBlockedReason(session) ?? "", /checkout/);
});

test("a harness that cannot reopen a conversation is refused by name", () => {
  withoutResume("claude", () => {
    const session = embedded();
    assert.equal(agentLaunchAction(session), null);
    assert.match(agentLaunchBlockedReason(session) ?? "", /claude/);
  });
});

test("the shell launcher asks only for a checkout, and nothing about the harness", () => {
  // A shell is not the agent's. Every harness - including one that has just declared it
  // cannot reopen anything - gets the same answer, because the question is about a
  // directory and the harness is not in it.
  for (const agent of AGENT_TYPES) {
    assert.equal(shellLaunchBlockedReason(mkSession({ agent })), null);
    const reason = shellLaunchBlockedReason(mkSession({ agent, cwd: null }));
    assert.equal(typeof reason, "string");
    assert.match(reason ?? "", /checkout/);
    withoutResume(agent, () => {
      assert.equal(shellLaunchBlockedReason(mkSession({ agent })), null);
      assert.equal(shellLaunchBlockedReason(mkSession({ agent, cwd: null })), reason);
    });
  }
});

test("the action and the reason never disagree, for any shape or harness", () => {
  // The one invariant both readers depend on: the browser draws a live control exactly when
  // the daemon would honour it. Anything else is a button that 409s, or a refusal with no
  // sentence attached.
  const shapes: Array<[string, LaunchableSession]> = [
    ["pane-backed", paneBacked()],
    ["pane-backed, no id", paneBacked({ agentSessionId: null })],
    ["pane-backed, no checkout", paneBacked({ cwd: null })],
    ["embedded", embedded()],
    ["embedded, no id", embedded({ agentSessionId: null })],
    ["embedded, no checkout", embedded({ cwd: null })],
    ["embedded, neither", embedded({ agentSessionId: null, cwd: null })],
    ["exited, conversation survives", survivingConversation()],
    ["exited, stale pane handles linger", paneBacked({ state: "exited" })],
    ["exited, nothing survives", survivingConversation({ agentSessionId: null, cwd: null })],
  ];
  for (const agent of AGENT_TYPES) {
    for (const [what, base] of shapes) {
      for (const resumes of [true, false]) {
        const session = { ...base, agent };
        const check = (): void => {
          const action = agentLaunchAction(session);
          const reason = agentLaunchBlockedReason(session);
          assert.equal(
            reason === null,
            action !== null,
            `${agent} ${what} (resumes=${resumes}): action ${action} with reason ${reason}`,
          );
          if (action !== null) {
            assert.ok(action === "focus" || action === "handoff" || action === "resume");
          }
        };
        if (resumes) check();
        else withoutResume(agent, check);
      }
    }
  }
});

test("the three refusals are three different sentences", () => {
  // They are three different fixes: a permanent property of the build, something that
  // resolves itself in a second, and a discovery gap. Collapsed into one string - or into a
  // boolean - the control is greyed and the human is left guessing which.
  const reasons = [
    withoutResume("claude", () => agentLaunchBlockedReason(embedded())),
    agentLaunchBlockedReason(embedded({ agentSessionId: null })),
    agentLaunchBlockedReason(embedded({ cwd: null })),
  ];
  for (const reason of reasons) {
    assert.equal(typeof reason, "string");
    assert.ok((reason ?? "").trim().length > 0, "a refusal with no sentence explains nothing");
    assert.doesNotMatch(reason ?? "", /^(true|false)$/, "a refusal is a sentence, not a boolean");
  }
  assert.equal(new Set(reasons).size, 3, `three fixes, three sentences: ${reasons.join(" | ")}`);
});
