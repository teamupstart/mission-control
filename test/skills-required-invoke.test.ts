import { test } from "node:test";
import assert from "node:assert/strict";
import { skillCommand } from "../src/shared/harness-capabilities.ts";
import type { SkillsConfig } from "../src/shared/protocol.ts";
import type { AgentType } from "../src/shared/types.ts";
import {
  requiredSkillCommand,
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
