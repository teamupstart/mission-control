import { test } from "node:test";
import assert from "node:assert/strict";
import { skillCommand } from "../src/shared/harness-capabilities.ts";
import type { SkillsConfig } from "../src/shared/protocol.ts";
import type { AgentType } from "../src/shared/types.ts";
import {
  requiredSkillCommand,
  skillInvocationForAgent,
  type RequiredSkillCommandDeps,
} from "../src/server/skills/invoke.ts";
import { noteKeyFor } from "../src/server/registry.ts";
import { mkSession } from "./helpers/session-fixture.ts";

const config: SkillsConfig = {
  enabled: true,
  skills: { "pull-request": true },
  generation: 3,
  generationAt: 100,
};

function deps(over: Partial<RequiredSkillCommandDeps> = {}): RequiredSkillCommandDeps {
  return {
    config: () => config,
    catalog: () => ({
      readable: true,
      skills: [{
        id: "pull-request",
        name: "pull-request",
        description: "Prepare a PR",
        category: "shipping",
        enforcement: "triggered",
      }],
      present: new Set(["pull-request"]),
      problems: [],
    }),
    acks: () => new Map(),
    installProblem: () => null,
    command: skillCommand,
    ...over,
  };
}

test("a required workflow skill uses each harness's native invocation", () => {
  const expected: Record<AgentType, string> = {
    claude: "/pull-request",
    codex: "$pull-request - run this skill now.",
    pi: "/skill:pull-request",
  };
  for (const agent of Object.keys(expected) as AgentType[]) {
    const result = requiredSkillCommand(
      mkSession({ agent, startedAt: config.generationAt }),
      "pull-request",
      deps(),
    );
    assert.deepEqual(result, { ok: true, command: expected[agent] }, agent);
  }
});

test("a required workflow skill fails closed when disabled, drifted, or not loaded", () => {
  const session = mkSession({ agent: "claude", startedAt: 1 });

  const disabled = requiredSkillCommand(session, "pull-request", deps({
    config: () => ({ ...config, enabled: false }),
  }));
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.match(disabled.message, /Enable Skills/);

  const drifted = requiredSkillCommand(session, "pull-request", deps({
    installProblem: () => "pull-request is switched on but isn't installed",
  }));
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.match(drifted.message, /isn't installed/);

  const stale = requiredSkillCommand(session, "pull-request", deps());
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.match(stale.message, /reload its skills/);

  const current = requiredSkillCommand(session, "pull-request", deps({
    acks: () => new Map([[noteKeyFor(session), config.generation]]),
  }));
  assert.deepEqual(current, { ok: true, command: "/pull-request" });
});

/**
 * The launch-time half of the same gate, and the one rung it must NOT borrow.
 *
 * A caller deciding whether an agent it is about to LAUNCH could follow a skill has no session
 * to measure a reload watermark against, and the one it would start has not read anything yet -
 * so the watermark is not a conservative extra check there, it is a wrong answer. Everything
 * else is the same ladder, asked of the agent instead of the session, so the two cannot drift
 * into two different opinions about whether a skill is on.
 */
test("the agent-level check is the same ladder without the per-conversation watermark", () => {
  // The session behind the watermark that `requiredSkillCommand` correctly refuses above.
  const stale = requiredSkillCommand(mkSession({ agent: "claude", startedAt: 1 }), "pull-request", deps());
  assert.equal(stale.ok, false);

  // The same config, asked about the harness rather than that conversation.
  assert.deepEqual(
    skillInvocationForAgent("claude", "pull-request", deps()),
    { ok: true, command: "/pull-request" },
  );

  // Every other rung still refuses, so this is a narrower question and not a weaker one.
  const disabled = skillInvocationForAgent("claude", "pull-request", deps({
    config: () => ({ ...config, enabled: false }),
  }));
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.match(disabled.message, /Enable Skills/);

  const untoggled = skillInvocationForAgent("claude", "retro", deps());
  assert.equal(untoggled.ok, false, "a skill that is not switched on is refused by id");

  const drifted = skillInvocationForAgent("claude", "pull-request", deps({
    installProblem: () => "pull-request is switched on but isn't installed",
  }));
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.match(drifted.message, /isn't installed/);

  const missing = skillInvocationForAgent("claude", "pull-request", deps({
    catalog: () => ({ readable: true, skills: [], present: new Set<string>(), problems: [] }),
  }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /unavailable in this build/);

  // Per AGENT, so a drifted link under one harness's directory says nothing about another's.
  const perAgent = skillInvocationForAgent("codex", "pull-request", deps({
    installProblem: (agent) => (agent === "claude" ? "claude's link drifted" : null),
  }));
  assert.deepEqual(perAgent, { ok: true, command: "$pull-request - run this skill now." });
});
