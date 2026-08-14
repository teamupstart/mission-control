import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PLAN_PAGE_FILENAME, PLAN_SOURCE_PATH_SHAPE } from "../src/shared/plans.ts";
import { skillCommand } from "../src/shared/harness-capabilities.ts";
import type { SkillsConfig } from "../src/shared/protocol.ts";
import type { AgentType, Task } from "../src/shared/types.ts";
import { MISSION_MCP_TOOLS, kindMissionMcpRequirement } from "../src/server/mission-mcp.ts";
import {
  PLAN_APPENDIX_MARKER,
  PLAN_HTML_SKILL_ID,
  PLAN_PHASED_SKILL_ID,
  PLAN_SKILL_IDS,
  isPlanTask,
  planContractAppendix,
} from "../src/server/plans/prompt.ts";
import {
  planDispatchBlock,
  planSkillsForAgent,
  planSkillsForSession,
} from "../src/server/plans/skills.ts";
import { PLAN_DECISIONS_TOOL, PLAN_SCHEDULING_TOOL } from "../src/server/plans/tools.ts";
import {
  requiredSkillCommand,
  skillInvocationForAgent,
  type RequiredSkillCommandDeps,
} from "../src/server/skills/invoke.ts";
import { noteKeyFor } from "../src/server/registry.ts";
import { withTaskKindContract } from "../src/server/task-contract.ts";
import { mkSession } from "./helpers/session-fixture.ts";

/**
 * What a plan task is told, and the three ways it can be told it wrongly.
 *
 * The contract POINTS AT `skills/html-plans/SKILL.md` rather than restating it, which is the
 * approved decision for this kind and the deliberate opposite of the scout appendix. That
 * makes two things load-bearing that are invisible on the default harness:
 *
 * 1. The invocation is rendered PER HARNESS. A hardcoded `/html-plans` is correct on Claude
 *    and inert on Codex and Pi, so a test per harness is the only place that failure shows.
 * 2. The two delivery seams need DIFFERENT resolvers - a fresh dispatch has no conversation
 *    to measure a reload watermark against, a live session does - and picking either one at
 *    both seams is wrong at one of them.
 *
 * The third is the ordinary drift this file shares with `scout-prompt.test.ts`: a prompt that
 * names a tool the launch did not pre-approve produces an agent that stops on a permission
 * prompt, which reads as an agent that simply sat there.
 */

const src = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Plan the archives reading UI",
    intent: "Plan how the archives library should be read from the dashboard.",
    kind: "plan",
    agent: "claude",
    priority: null,
    labels: [],
    dependencies: [],
    enabled: true,
    model: null,
    effort: null,
    workflowId: null,
    source: null,
    repoRoot: "/repos/demo",
    worktreePath: "/work/demo",
    branch: null,
    provider: null,
    baseSha: null,
    extraRepos: [],
    homeName: null,
    terminalResourceId: null,
    sessionId: null,
    status: "running",
    outcome: null,
    outcomeUrl: null,
    error: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    createdAt: 1,
    updatedAt: 1,
    dispatchedAt: null,
    completedAt: null,
    ...overrides,
  } as Task;
}

/** Both planning skills on, one generation old, catalog healthy. */
const config: SkillsConfig = {
  enabled: true,
  skills: Object.fromEntries(PLAN_SKILL_IDS.map((id) => [id, true])),
  generation: 3,
  generationAt: 100,
};

function deps(over: Partial<RequiredSkillCommandDeps> = {}): RequiredSkillCommandDeps {
  return {
    config: () => config,
    catalog: () => ({
      readable: true,
      skills: PLAN_SKILL_IDS.map((id) => ({
        id,
        name: id,
        description: `The ${id} procedure`,
        category: "planning" as const,
        enforcement: "triggered" as const,
      })),
      present: new Set<string>(PLAN_SKILL_IDS),
      problems: [],
    }),
    acks: () => new Map(),
    installProblem: () => null,
    command: skillCommand,
    ...over,
  };
}

/** The real launch-time ladder, over a fixture config rather than this machine's. */
const forAgent = (over: Partial<RequiredSkillCommandDeps> = {}): typeof skillInvocationForAgent =>
  (agent, id) => skillInvocationForAgent(agent, id, deps(over));

/** The real live-session ladder, watermark rung and all, over the same fixture config. */
const forSession = (over: Partial<RequiredSkillCommandDeps> = {}): typeof requiredSkillCommand =>
  (session, id) => requiredSkillCommand(session, id, deps(over));

/** The invocations a healthy Claude launch resolves, for the composition cases below. */
const CLAUDE_SKILLS = {
  htmlPlans: `/${PLAN_HTML_SKILL_ID}`,
  phasedPlan: `/${PLAN_PHASED_SKILL_ID}`,
};

// ---------------------------------------------------------------------------
// What a plan is told
// ---------------------------------------------------------------------------

test("a plan's intent arrives intact, with the contract appended after it", () => {
  const task = mkTask();
  const delivered = withTaskKindContract(task, task.intent, { planSkills: CLAUDE_SKILLS });
  assert.ok(delivered.startsWith(task.intent), "the operator's request is read first, unmodified");
  const marker = delivered.indexOf(PLAN_APPENDIX_MARKER);
  assert.ok(marker > task.intent.length - 1, "and the contract follows it");
  assert.equal(isPlanTask(task), true);
});

test("a ship or scout task never sees the plan contract, whatever is passed alongside it", () => {
  const ship = mkTask({ kind: "ship" });
  // The same inputs a plan delivery carries, on a task that is not one: byte-identical out.
  assert.equal(withTaskKindContract(ship, ship.intent, { planSkills: CLAUDE_SKILLS }), ship.intent);
  assert.equal(isPlanTask(ship), false);

  const scout = mkTask({ kind: "scout" });
  const delivered = withTaskKindContract(scout, scout.intent, { planSkills: CLAUDE_SKILLS });
  assert.ok(!delivered.includes(PLAN_APPENDIX_MARKER), "a scout gets its own contract, not this one");
});

test("the contract names the path, the tools, the dismissal rule and the pull request", () => {
  const appendix = planContractAppendix(CLAUDE_SKILLS);
  assert.match(appendix, new RegExp(escape(PLAN_SOURCE_PATH_SHAPE)));
  assert.match(appendix, new RegExp(escape(PLAN_PAGE_FILENAME)));
  assert.match(appendix, new RegExp(escape(PLAN_DECISIONS_TOOL)));
  assert.match(appendix, new RegExp(escape(PLAN_SCHEDULING_TOOL)));
  assert.match(appendix, /never read back as a selection/, "a dismissal is not an answer");
  assert.match(appendix, /not a change/, "a plan is not asked to implement itself");
  assert.match(appendix, /pull request/, "unlike a scout, a plan is meant to land");
});

test("the contract points at the skills instead of restating their procedure", () => {
  // The approved decision, asserted as an ABSENCE because that is the only way it can be. The
  // scout appendix restates its skill because a scout's output is server-enforced and had to
  // hold with skills switched off; this one hands the procedure over, and every rule copied in
  // here is a second statement that nothing tests against a real plan.
  const appendix = planContractAppendix(CLAUDE_SKILLS);
  const skill = src("skills/html-plans/SKILL.md");

  // Rendering rules: the skill's, not ours.
  assert.match(skill, /prefers-color-scheme/);
  assert.ok(!appendix.includes("prefers-color-scheme"), "no rendering rules");
  assert.ok(!appendix.includes("inline the CSS"), "no rendering rules");

  // The decision schema: the skill's, not ours.
  assert.match(skill, /"implementation-follow-up"/);
  assert.ok(!appendix.includes("implementation-follow-up"), "no decision schema");
  assert.ok(!appendix.includes("multiSelect"), "no decision schema");

  // Diagram guidance: the skill's, not ours.
  assert.match(skill, /Inline SVG, never a diagram library/);
  assert.ok(!appendix.includes("SVG"), "no diagram guidance");

  // And it stays SHORT, for the reason the scout appendix records: it competes with the
  // operator's own request, and a page of rules is read like a page of none.
  assert.ok(
    appendix.split("\n").length < 30,
    `the appendix is ${appendix.split("\n").length} lines - it is meant to hand work over, not describe it`,
  );
});

test("the appendix carries THIS harness's invocation syntax, not a hardcoded slash command", () => {
  // The regression a literal `/html-plans` would cause, and the reason it is invisible: it is
  // exactly right on Claude and reaches nothing on the other two.
  const expected: Record<AgentType, { html: string; phased: string }> = {
    claude: { html: "/html-plans", phased: "/phased-plan" },
    codex: {
      html: "$html-plans - run this skill now.",
      phased: "$phased-plan - run this skill now.",
    },
    pi: { html: "/skill:html-plans", phased: "/skill:phased-plan" },
  };

  for (const agent of Object.keys(expected) as AgentType[]) {
    const resolved = planSkillsForAgent(agent, forAgent());
    assert.equal(resolved.ok, true, `${agent} can invoke both planning skills`);
    if (!resolved.ok) continue;

    const appendix = planContractAppendix(resolved.commands);
    assert.ok(
      appendix.includes(expected[agent].html),
      `${agent}'s appendix must carry ${expected[agent].html} verbatim`,
    );
    assert.ok(
      appendix.includes(expected[agent].phased),
      `${agent}'s appendix must carry ${expected[agent].phased} verbatim`,
    );
    // And no other harness's spelling rides along, which is what a hardcoded literal does.
    for (const other of Object.keys(expected) as AgentType[]) {
      if (other === agent || expected[other].html.includes(expected[agent].html)) continue;
      assert.ok(
        !appendix.includes(expected[other].html),
        `${other}'s spelling must not reach a ${agent} plan`,
      );
    }
  }
});

test("a plan delivered without resolved invocations fails loudly rather than pointing at nothing", () => {
  // Unreachable through either seam - both refuse first - and deliberately not made harmless.
  // An appendix that silently dropped the invocation would tell an agent to follow a procedure
  // it was never given a way to load, which is the one outcome "point at the skills" cannot
  // survive, and it would look like it worked.
  assert.throws(
    () => withTaskKindContract(mkTask(), "plan it"),
    /without resolved planning-skill invocations/,
  );
});

// ---------------------------------------------------------------------------
// Drift against the skills the contract hands the work to
// ---------------------------------------------------------------------------

test("the html-plans skill and the daemon contract agree about where a plan lives", () => {
  const skill = src("skills/html-plans/SKILL.md");
  const appendix = planContractAppendix(CLAUDE_SKILLS);

  // The path, spelled the same way in both. `<name>` is the skill's own placeholder.
  assert.match(skill, new RegExp(escape(PLAN_SOURCE_PATH_SHAPE)));
  assert.match(appendix, new RegExp(escape(PLAN_SOURCE_PATH_SHAPE)));
  assert.match(skill, new RegExp(escape(`docs/plans/<name>/${PLAN_PAGE_FILENAME}`)));

  // The tool the review is asked through, in both.
  assert.match(skill, new RegExp(escape(PLAN_DECISIONS_TOOL)));
  assert.match(appendix, new RegExp(escape(PLAN_DECISIONS_TOOL)));

  // And the follow-up the contract promises the human is a thing the skill actually offers.
  assert.match(skill, /phased implementation follow-up/i);
  assert.match(appendix, /phased implementation follow-up/i);

  // The skill is what invokes `phased-plan` on the chosen follow-up; the contract only has to
  // agree that this is where the second skill comes in.
  assert.match(skill, new RegExp(`Invoke the \`${PLAN_PHASED_SKILL_ID}\` skill`));
});

test("the skills the contract names are the skills the dispatch requires", () => {
  // The two halves of "point at the skills": the appendix says to run them, and the gate says
  // a dispatch that could not run them does not happen. A drift here is a plan task told to
  // invoke something nothing checked was installed.
  const appendix = planContractAppendix(CLAUDE_SKILLS);
  assert.ok(appendix.includes(PLAN_HTML_SKILL_ID));
  assert.ok(appendix.includes(PLAN_PHASED_SKILL_ID));

  const off = planDispatchBlock(mkTask(), () => ({ ok: false, message: "Enable Skills and the html-plans skill." }));
  assert.match(off ?? "", /Enable Skills/);
});

// ---------------------------------------------------------------------------
// Drift between the prompt and the launch
// ---------------------------------------------------------------------------

test("every plan launch requires the tools its prompt names", () => {
  const appendix = planContractAppendix(CLAUDE_SKILLS);
  for (const tool of [PLAN_DECISIONS_TOOL, PLAN_SCHEDULING_TOOL]) {
    assert.ok(appendix.includes(tool), `the prompt names ${tool}`);
    assert.ok(([...MISSION_MCP_TOOLS] as string[]).includes(tool), `a caller can require ${tool}`);
  }
  const required = kindMissionMcpRequirement(mkTask(), null);
  assert.deepEqual(
    [...(required?.tools ?? [])].sort(),
    [PLAN_DECISIONS_TOOL, PLAN_SCHEDULING_TOOL].sort(),
  );
});

test("a plan's requirement is unioned with the caller's, and stays a set", () => {
  const required = kindMissionMcpRequirement(mkTask(), { tools: ["report_status"] });
  assert.deepEqual(
    [...(required?.tools ?? [])].sort(),
    ["report_status", PLAN_DECISIONS_TOOL, PLAN_SCHEDULING_TOOL].sort(),
  );
  const again = kindMissionMcpRequirement(mkTask(), required);
  assert.equal(again?.tools.length, 3, "a repeat adds nothing");
});

test("a scout's launch is untouched by the plan requirement landing beside it", () => {
  // The kind table gained a row; the row above it must not have moved. Ship's identity case
  // lives in `scout-prompt.test.ts`, which is where the byte-identical claim is pinned.
  const scout = kindMissionMcpRequirement(mkTask({ kind: "scout" }), null);
  assert.deepEqual(scout, { tools: ["submit_scout_artifacts"] });
});

// ---------------------------------------------------------------------------
// The gate, and the two resolvers behind it
// ---------------------------------------------------------------------------

test("a dispatch is refused when the planning skills cannot be invoked, naming the toggle", () => {
  const block = planDispatchBlock(mkTask(), (_agent, id) =>
    id === PLAN_HTML_SKILL_ID
      ? { ok: false, message: `Enable Skills and the ${id} skill before sending this instruction.` }
      : { ok: true, command: `/${id}` });

  assert.ok(block, "a plan dispatch that cannot honour its contract is refused");
  assert.match(block, /Enable Skills and the html-plans skill/, "name the toggle");
  assert.match(block, /Settings → Skills/, "and where to find it");
  assert.match(block, /invokes the planning skills/, "and why a dispatch failed over a setting");
});

test("phased-plan is required at dispatch too, not only when the human chooses to phase", () => {
  // The deferred decision in this phase's plan, resolved as required UP FRONT: the alternative
  // refuses after the human has already chosen to phase the work, which is the worse moment.
  const block = planDispatchBlock(mkTask(), (_agent, id) =>
    id === PLAN_PHASED_SKILL_ID
      ? { ok: false, message: `Enable Skills and the ${id} skill before sending this instruction.` }
      : { ok: true, command: `/${id}` });

  assert.match(block ?? "", /phased-plan/);
});

test("ship and scout dispatches never consult the gate", () => {
  const refuseEverything = () => ({ ok: false as const, message: "no skills here" });
  assert.equal(planDispatchBlock(mkTask({ kind: "ship" }), refuseEverything), null);
  assert.equal(planDispatchBlock(mkTask({ kind: "scout" }), refuseEverything), null);
});

test("the assignment resolver refuses a session still holding the previous skill set", () => {
  // The rung that only exists on the live-session resolver, and the reason the two seams
  // cannot share one. This session started before the current generation and has acked
  // nothing, so it is running with the skills as they were - typing `/html-plans` into it
  // names a procedure it cannot load.
  const stale = mkSession({ agent: "claude", startedAt: 1 });
  const refused = planSkillsForSession(stale, forSession());
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.message, /reload its skills/);

  // The same session, once it has acknowledged that generation.
  const current = planSkillsForSession(stale, forSession({
    acks: () => new Map([[noteKeyFor(stale), config.generation]]),
  }));
  assert.deepEqual(current, { ok: true, commands: CLAUDE_SKILLS });
});

test("the launch resolver is the same ladder without that rung", () => {
  // Asked of the harness rather than of a conversation, because the conversation a dispatch
  // is resolving for does not exist yet and starts after the current generation by
  // construction. Borrowing the stricter answer would refuse a launch over some unrelated
  // dead session's missing ack.
  assert.deepEqual(planSkillsForAgent("claude", forAgent()), {
    ok: true,
    commands: CLAUDE_SKILLS,
  });

  // Every other rung still refuses, so this is a narrower question and not a weaker one.
  const off = planSkillsForAgent("claude", forAgent({
    config: () => ({ ...config, enabled: false }),
  }));
  assert.equal(off.ok, false);
  if (!off.ok) assert.match(off.message, /Enable Skills/);

  const drifted = planSkillsForAgent("claude", forAgent({
    installProblem: () => "html-plans is switched on but isn't installed",
  }));
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.match(drifted.message, /isn't installed/);
});

test("each delivery seam reaches for its own resolver, and only its own", () => {
  // The single most likely thing to get wrong in this change, and it is silent both ways: the
  // launch resolver on a live session types a stale invocation, and the watermark resolver at
  // launch refuses a dispatch over a conversation that does not exist. Neither shows up in a
  // green suite, so the call sites are pinned here.
  const dispatcher = src("src/server/dispatcher.ts");
  assert.match(dispatcher, /planSkillsForAgent/, "a fresh dispatch uses the launch-time ladder");
  assert.ok(
    !dispatcher.includes("planSkillsForSession"),
    "a dispatch has no session to measure a reload watermark against",
  );

  const tasks = src("src/server/tasks.ts");
  assert.match(tasks, /planSkillsForSession/, "an assignment uses the watermark-aware ladder");
  assert.ok(
    !/planSkillsForAgent/.test(tasks.replaceAll("planDispatchBlock", "")),
    "an assignment must not resolve as though the session were about to be launched",
  );
});

test("both delivery seams gate the plan contract, not just the dispatcher", () => {
  // The sibling of the same assertion in `scout-prompt.test.ts`, for the gate rather than the
  // appendix: a dispatcher-only refusal would let a backlog plan be assigned to a live agent
  // whose skills are switched off, which is the seam that types into a checkout it just reset.
  assert.match(src("src/server/dispatcher.ts"), /planSkills/);
  assert.match(src("src/server/tasks.ts"), /requirePlanSkills \?\? planSkillsForSession/);
  assert.match(src("src/server/routes.ts"), /planDispatchBlock\(/);
});

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
