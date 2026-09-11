import test from "node:test";
import assert from "node:assert/strict";

import {
  PIPELINE_ACTIONS,
  PIPELINE_ACTION_INFO,
  PIPELINE_CONSOLES,
  PIPELINE_CONSOLE_INFO,
  PIPELINE_DAEMON_ACTIONS,
  PIPELINE_HALT_ACTIONS,
  PIPELINE_HALT_CLASSES,
  PIPELINE_HALT_CONSOLES,
  PIPELINE_LAUNCH_RUNTIMES,
  PIPELINE_PHASES,
  PIPELINE_PROVIDER_IDS,
  PIPELINE_PROVIDER_INFO,
  PIPELINE_RUN_GROUPS,
  PIPELINE_SPEND_ROLES,
  PIPELINE_SPEND_WRITERS,
  PIPELINE_STEPS,
  PIPELINE_STEP_STATES,
  PIPELINE_UNGRANTABLE_STEPS,
  PipelineActionRequestSchema,
  PipelineConsoleRequestSchema,
  PipelinesConfigSchema,
  activePipelineRepos,
  isPipelineAction,
  isPipelineConsole,
  isPipelineGrantableStep,
  isPipelineHaltClass,
  isPipelineProviderId,
  isPipelineStepState,
  pipelineConsoleAllowed,
  pipelineGrantAllowed,
  pipelineGrantRefusal,
  pipelineGrantableSteps,
  pipelinePhaseOfStep,
  pipelineRunKey,
  pipelineStepInfo,
  pipelineStepOrder,
  sortPipelineSteps,
  supportsManagedPipelineHost,
  PIPELINE_ENGINEER_SKILL,
  type PipelinePhase,
} from "../src/shared/pipeline.ts";
import { LLM_SPEND_ROLES } from "../src/shared/llm-spend.ts";
import { AGENT_TYPES } from "../src/shared/types.ts";
import {
  capabilitiesFor,
  skillCommand,
  supportsSdkSkillInvocation,
} from "../src/shared/harness-capabilities.ts";
import { conductorIdeaSlug } from "../src/server/pipelines/conductor/index.ts";
import { PIPELINE_PROVIDERS } from "../src/server/pipelines/providers.ts";

// What is at stake: `src/shared/pipeline.ts` is a cross-phase contract - phases 2 to 6 are
// all consumers of it - and two of the things it promises are only true if somebody checks.
//
// The first is APPEND-ONLY. `PIPELINE_PROVIDER_IDS` is persisted in `app_config` and in
// `pipeline_runs.provider`, so a rename orphans every repository an operator consented to
// under the old spelling. The literal below is the tripwire: changing an id fails here,
// which is the moment to append instead.
//
// The second is TOLERANCE. Mission Control ships a frozen copy of conductor's step
// vocabulary, and conductor is a separate program on a release train nobody here controls.
// The copy must therefore degrade rather than refuse: an unknown step name renders and
// sorts, and `pipelineStepInfo` returning null is an ordinary answer.

test("the provider id tuple is append-only, and every id has a Record entry", () => {
  // Written out rather than derived. A test that read the tuple to check the tuple would
  // pass through a rename, which is the one edit this exists to catch.
  assert.deepEqual([...PIPELINE_PROVIDER_IDS], ["ai-conductor"]);
  for (const id of PIPELINE_PROVIDER_IDS) {
    const info = PIPELINE_PROVIDER_INFO[id];
    assert.equal(info.provider, id, `${id}'s info must name itself`);
    assert.ok(info.label, `${id} needs a display name`);
    assert.ok(info.blurb, `${id} needs a sentence saying what an operator is consenting to`);
    assert.ok(info.bin, `${id} needs a binary to probe for`);
    assert.ok(PIPELINE_STEPS[id].length > 0, `${id} needs a step table`);
  }
  assert.equal(isPipelineProviderId("ai-conductor"), true);
  assert.equal(isPipelineProviderId("ai-conductor-2"), false);
});

test("each provider's two persisted ledger identifiers are spelled out, once", () => {
  // Both are written into `usage_ledger` and read back by exact value - the role by the
  // spend strip's GROUP BY, the writer by the migration that must never claim these rows -
  // so both are append-only and neither may be derived from the provider id. Spelled out
  // here for `PIPELINE_PROVIDER_IDS`' reason: a test that derived them would pass through
  // the rename that orphans the history.
  assert.deepEqual(PIPELINE_SPEND_ROLES, { "ai-conductor": "pipeline:ai-conductor" });
  assert.deepEqual(PIPELINE_SPEND_WRITERS, { "ai-conductor": "conductor" });
  for (const id of PIPELINE_PROVIDER_IDS) {
    assert.ok(LLM_SPEND_ROLES.includes(PIPELINE_SPEND_ROLES[id]), `${id}'s role must be a known one`);
  }
});

test("the vocabularies read out of provider files are checked, not cast", () => {
  // Each of these decodes a string another program wrote. A cast would let a value from a
  // newer engine flow into a `Record` key and render as `undefined`.
  assert.deepEqual([...PIPELINE_STEP_STATES], [
    "pending",
    "in_progress",
    "done",
    "failed",
    "refused",
    "skipped",
    "stale",
  ]);
  assert.deepEqual([...PIPELINE_HALT_CLASSES], [
    "needs-human",
    "mechanical",
    "protected-artifact",
    "plan-gap",
    "legacy",
    "unclassified",
  ]);
  assert.deepEqual([...PIPELINE_RUN_GROUPS], [
    "building",
    "eligible",
    "waiting",
    "halted",
    "parked",
    "processed",
  ]);
  assert.equal(isPipelineStepState("in_progress"), true);
  assert.equal(isPipelineStepState("refused"), true);
  assert.equal(isPipelineStepState("quantum"), false);
  assert.equal(isPipelineHaltClass("needs-human"), true);
  assert.equal(isPipelineHaltClass("plan-gap"), true);
  assert.equal(isPipelineHaltClass("needs-a-human"), false);
});

test("the frozen step table is conductor's own 22-step sequence plus its four out-of-band steps", () => {
  // Copied from ai-conductor `b9c19307`'s `ALL_STEPS` and `OUT_OF_BAND_STEPS`. Written out
  // so that re-freezing the copy against a newer engine is a deliberate, reviewable edit
  // rather than a diff nobody can read.
  const steps = PIPELINE_STEPS["ai-conductor"];
  const sequential = steps.filter((s) => !s.outOfBand);
  assert.deepEqual(
    sequential.map((s) => s.name),
    [
      "worktree",
      "memory",
      "explore",
      "complexity",
      "prd",
      "architecture_diagram",
      "architecture_review",
      "stories",
      "conflict_check",
      "plan",
      "coherence_check",
      "acceptance_specs",
      "build",
      "wiring_check",
      "test_suite",
      "build_review",
      "manual_test",
      "prd_audit",
      "architecture_review_as_built",
      "retro",
      "rebase",
      "finish",
    ],
  );
  assert.deepEqual(
    steps.filter((s) => s.outOfBand).map((s) => s.name),
    ["bootstrap", "assess", "remediate", "attribution_verify"],
  );

  // The phase counts the plan states, checked as a fold rather than restated per step.
  const perPhase: Record<PipelinePhase, number> = {
    SETUP: 0,
    UNDERSTAND: 0,
    DECIDE: 0,
    BUILD: 0,
    SHIP: 0,
  };
  for (const step of sequential) perPhase[step.phase] += 1;
  assert.deepEqual(perPhase, { SETUP: 1, UNDERSTAND: 1, DECIDE: 9, BUILD: 5, SHIP: 6 });
  assert.equal(sequential.length, 22);

  // `wiring_check` is a retained compatibility no-op. It is drawn dashed rather than hidden
  // because it still occupies a slot in the engine's own state - and it is the only one.
  assert.deepEqual(
    steps.filter((s) => s.deprecated).map((s) => s.name),
    ["wiring_check"],
  );

  // Every step names a phase this build has a word for.
  for (const step of steps) {
    assert.ok(PIPELINE_PHASES.includes(step.phase), `${step.name} names an unknown phase`);
    assert.ok(step.label, `${step.name} needs a label`);
  }
});

test("an unknown step is tolerated: no info, no phase, and it sorts after every known one", () => {
  assert.equal(pipelineStepInfo("ai-conductor", "build")?.label, "Build");
  assert.equal(pipelinePhaseOfStep("ai-conductor", "build"), "BUILD");

  // The whole tolerance rule, as three answers about a step from a newer engine.
  assert.equal(pipelineStepInfo("ai-conductor", "quantum_check"), null);
  assert.equal(pipelinePhaseOfStep("ai-conductor", "quantum_check"), null);
  assert.ok(
    pipelineStepOrder("ai-conductor", "quantum_check") >
      pipelineStepOrder("ai-conductor", "finish"),
    "an unknown step must sort after the last known one",
  );
});

test("sorting is stable, so two unknown steps keep the order they arrived in", () => {
  // Not decoration. Two unknown steps compare equal, and a browser that reshuffled them
  // between two frames would draw a strip that moved for no reason a reader could see.
  const sorted = sortPipelineSteps("ai-conductor", [
    { name: "zeta_from_the_future" },
    { name: "build" },
    { name: "alpha_from_the_future" },
    { name: "worktree" },
  ]);
  assert.deepEqual(
    sorted.map((s) => s.name),
    ["worktree", "build", "zeta_from_the_future", "alpha_from_the_future"],
  );
});

test("the projection key is the engine's own identity, and separates its three parts", () => {
  assert.notEqual(
    pipelineRunKey("ai-conductor", "/repo/a", "b-c"),
    pipelineRunKey("ai-conductor", "/repo/a b", "c"),
  );
});

test("every provider derives a complete task identity through the provider contract", () => {
  for (const id of PIPELINE_PROVIDER_IDS) {
    assert.equal(typeof PIPELINE_PROVIDERS[id].taskIdentity, "function", id);
  }
  assert.deepEqual(
    PIPELINE_PROVIDERS["ai-conductor"].taskIdentity("Build the release train", "/repo/a"),
    {
      provider: "ai-conductor",
      repoRoot: "/repo/a",
      slug: "build-the-release-train",
    },
  );
});

test("managed Pipeline hosts are capability-derived and preserve native Engineer prompt bytes", () => {
  const intent = "Build this; keep $HOME and `pwd` literal\nThen ask me.";
  assert.deepEqual(
    AGENT_TYPES.map((agent) => {
      const eligible = supportsManagedPipelineHost(agent);
      const command = skillCommand(agent, PIPELINE_ENGINEER_SKILL);
      return {
        agent,
        eligible,
        prompt: eligible && command ? `${command} ${intent}` : null,
      };
    }),
    [
      { agent: "claude", eligible: true, prompt: `/engineer ${intent}` },
      {
        agent: "codex",
        eligible: true,
        prompt: `$engineer - run this skill now. ${intent}`,
      },
      // Pi has BOTH halves of `supportsSdkSkillInvocation` now - a managed runtime and a
      // typed `/skill:engineer` - and is still not a Pipeline host, because it has no MCP
      // client to publish `adopt_pipeline_run` and `report_pipeline_workspace` to. That is
      // the third capability `supportsManagedPipelineHost` adds, and this row is what
      // fails if a future change drops it back to the two-part predicate.
      { agent: "pi", eligible: false, prompt: null },
    ],
  );
  assert.equal(supportsSdkSkillInvocation("pi", PIPELINE_ENGINEER_SKILL), true);
  assert.equal(capabilitiesFor("pi").mcp, null);
});

test("conductor idea slugs match its lowercase ASCII, separator, trim, and cap contract", () => {
  assert.deepEqual(
    [
      "Hello, world!",
      "one___two / three",
      "--- edge ---",
      "MiXeD CaSe",
      "Crème brûlée 東京",
      "A".repeat(60),
      "🔥 /// 東京",
    ].map(conductorIdeaSlug),
    [
      "hello-world",
      "one-two-three",
      "edge",
      "mixed-case",
      "cr-me-br-l-e",
      "a".repeat(50),
      "",
    ],
  );
  assert.deepEqual(
    PIPELINE_PROVIDERS["ai-conductor"].taskIdentity("🔥 /// 東京", "/repo/a"),
    { refused: "conductor cannot derive a run slug from this task intent" },
  );
});

test("the consent config ships off, and defaults over a blob an older build wrote", () => {
  // The zod-defaults-on-read pattern is what means this key needs no migration. An empty
  // object is what `getAppConfig` returns for a key nothing has written.
  const shipped = PipelinesConfigSchema.parse({});
  assert.equal(shipped.enabled, false);
  assert.equal(shipped.foremanMechanicalTriage, false);
  assert.deepEqual(shipped.repos, []);
  const parsedLaunchRuntime = (launchRuntime: string): string => {
    const parsed = PipelinesConfigSchema.safeParse({ launchRuntime });
    return parsed.success ? parsed.data.launchRuntime : "rejected";
  };
  assert.deepEqual(
    {
      canonical: parsedLaunchRuntime("agent-sdk"),
      default: shipped.launchRuntime,
      legacy: parsedLaunchRuntime("claude-sdk"),
      runtimes: [...PIPELINE_LAUNCH_RUNTIMES],
      terminal: parsedLaunchRuntime("terminal"),
    },
    {
      canonical: "agent-sdk",
      default: "agent-sdk",
      legacy: "agent-sdk",
      runtimes: ["agent-sdk", "terminal"],
      terminal: "terminal",
    },
  );

  // A repository arrives OFF even when the caller says nothing: adding is configuration,
  // enabling is consent.
  const added = PipelinesConfigSchema.parse({
    repos: [{ provider: "ai-conductor", repoRoot: "/repo/a" }],
  });
  assert.equal(added.repos[0]?.enabled, false);

  // Two entries naming one repository would each overwrite the other's consent.
  assert.throws(() =>
    PipelinesConfigSchema.parse({
      repos: [
        { provider: "ai-conductor", repoRoot: "/repo/a" },
        { provider: "ai-conductor", repoRoot: "/repo/a" },
      ],
    }),
  );
});

test("the master switch gates every repository, without forgetting which were chosen", () => {
  const config = PipelinesConfigSchema.parse({
    enabled: false,
    repos: [
      { provider: "ai-conductor", repoRoot: "/repo/a", enabled: true },
      { provider: "ai-conductor", repoRoot: "/repo/b", enabled: false },
    ],
  });
  // Off: nothing is read...
  assert.deepEqual(activePipelineRepos(config), []);
  // ...but the choice survives, which is the whole reason the master switch is not just
  // "turn every repository off".
  assert.equal(config.repos.length, 2);
  assert.deepEqual(
    activePipelineRepos({ ...config, enabled: true }).map((r) => r.repoRoot),
    ["/repo/a"],
  );
});

// ---- the control vocabulary ---------------------------------------------------------------
//
// The verbs are the surface phase 6's Foreman triage was promised, so the tuple is a contract
// in the same sense the provider ids are: a rename is a route that stops answering for a
// caller nobody here can see. Everything below either pins a spelling or pins the rule that
// keeps two surfaces from disagreeing about what a verb needs.

test("the action tuple is append-only, and every verb says what it acts on", () => {
  // Written out rather than derived, for `PIPELINE_PROVIDER_IDS`' reason: a test that read
  // the tuple to check the tuple passes through the rename it exists to catch.
  assert.deepEqual([...PIPELINE_ACTIONS], [
    "daemon-start",
    "daemon-stop",
    "daemon-pause",
    "daemon-resume",
    "park",
    "unpark",
    "grant",
  ]);
  for (const action of PIPELINE_ACTIONS) {
    const info = PIPELINE_ACTION_INFO[action];
    assert.ok(info.label, `${action} needs a label`);
    assert.ok(info.blurb, `${action} needs a sentence for its tooltip`);
    assert.ok(info.scope === "repo" || info.scope === "run", `${action} needs a scope`);
    // A daemon verb is a repository verb, always. One addressed at a run would read as
    // "pause this feature" and pause every feature in the checkout.
    if (action.startsWith("daemon-")) assert.equal(info.scope, "repo", action);
  }
  assert.equal(isPipelineAction("park"), true);
  assert.equal(isPipelineAction("parkk"), false);

  assert.deepEqual([...PIPELINE_CONSOLES], ["daemon", "reseal"]);
  for (const console_ of PIPELINE_CONSOLES) {
    const info = PIPELINE_CONSOLE_INFO[console_];
    assert.ok(info.label && info.blurb && info.verb, console_);
  }
  assert.equal(isPipelineConsole("reseal"), true);
  assert.equal(isPipelineConsole("re-seal"), false);
});

test("a grant may name any DECIDE step except the ones the engine refuses", () => {
  const grantable = pipelineGrantableSteps("ai-conductor").map((step) => step.name);
  // Derived from the frozen table the same way the engine derives it - `phase === "DECIDE"`,
  // out-of-band excluded - so a conductor release that adds a DECIDE step appears here as
  // soon as the table learns it.
  assert.ok(grantable.length > 0);
  for (const name of grantable) {
    assert.equal(pipelineStepInfo("ai-conductor", name)?.phase, "DECIDE", name);
    assert.equal(pipelineStepInfo("ai-conductor", name)?.outOfBand ?? false, false, name);
    assert.equal(isPipelineGrantableStep("ai-conductor", name), true, name);
    assert.equal(pipelineGrantRefusal("ai-conductor", name), null, name);
  }
  // `plan` is the one conductor refuses in four places of its own. Mission Control refuses it
  // BEFORE spawning, and the refusal is an explanation rather than a relayed error, because
  // nothing ran to produce one.
  assert.deepEqual([...PIPELINE_UNGRANTABLE_STEPS["ai-conductor"]], ["plan"]);
  assert.equal(grantable.includes("plan"), false);
  assert.equal(isPipelineGrantableStep("ai-conductor", "plan"), false);
  assert.match(pipelineGrantRefusal("ai-conductor", "plan") ?? "", /never grants re-entry to 'plan'/);
  // A step that is not a DECIDE step at all is refused too, with its own sentence.
  assert.match(pipelineGrantRefusal("ai-conductor", "build") ?? "", /not a DECIDE step/);
  assert.match(pipelineGrantRefusal("ai-conductor", "nonsense") ?? "", /not a DECIDE step/);
});

test("what a halt offers, and what a daemon state offers, is decided once", () => {
  // Both records are exhaustive over their tuple, which is the compile-time half. The runtime
  // half is that what they offer is coherent: a halt row never carries a repository verb, and
  // a class with no verb at all has a console instead, except plan-gap: its recovery starts
  // outside Mission Control by revising and approving the plan.
  for (const haltClass of PIPELINE_HALT_CLASSES) {
    for (const action of PIPELINE_HALT_ACTIONS[haltClass]) {
      assert.equal(PIPELINE_ACTION_INFO[action].scope, "run", `${haltClass}/${action}`);
    }
    const ways = PIPELINE_HALT_ACTIONS[haltClass].length + PIPELINE_HALT_CONSOLES[haltClass].length;
    if (haltClass === "plan-gap") {
      assert.equal(ways, 0, "plan-gap is guidance-only until its approved plan is revised");
    } else {
      assert.ok(ways > 0, `${haltClass} needs at least one way out`);
    }
  }
  assert.deepEqual([...PIPELINE_HALT_CONSOLES["protected-artifact"]], ["reseal"]);
  assert.deepEqual(
    PIPELINE_HALT_CLASSES.filter((haltClass) =>
      pipelineConsoleAllowed("reseal", { class: haltClass }),
    ),
    ["protected-artifact"],
    "a reseal is licensed only by the halt it answers",
  );
  assert.equal(pipelineConsoleAllowed("reseal", null), false);
  assert.equal(pipelineConsoleAllowed("daemon", null), true, "a repository console answers no halt");

  for (const state of ["running", "paused", "stopped", "unknown"] as const) {
    const offered = PIPELINE_DAEMON_ACTIONS[state];
    assert.ok(offered.length > 0, state);
    for (const action of offered) {
      assert.equal(PIPELINE_ACTION_INFO[action].scope, "repo", `${state}/${action}`);
    }
  }
  // The one that would be a lie: offering to start a daemon that is running, or to pause one
  // that is already paused.
  assert.equal(PIPELINE_DAEMON_ACTIONS.running.includes("daemon-start"), false);
  assert.equal(PIPELINE_DAEMON_ACTIONS.paused.includes("daemon-pause"), false);
  assert.equal(PIPELINE_DAEMON_ACTIONS.stopped.includes("daemon-stop"), false);
});

test("a grant is licensed by the halt it answers, wherever the question is asked", () => {
  // Two surfaces offer this verb and one route accepts it, and all three read the SAME table.
  // The bug this pins is a run header that decided for itself which verbs an unfinished run
  // deserves: it offered a grant on a run that had not stopped at all, which is a standing
  // authorization for the engine to walk through the next DECIDE gate unattended.
  assert.equal(pipelineGrantAllowed({ class: "needs-human" }), true);
  // Never without a halt. This is the case the header got wrong.
  assert.equal(pipelineGrantAllowed(null), false);
  // And never for a class whose way out is something else: the engine re-kicks `mechanical`
  // itself, and `protected-artifact` is cleared by a ceremony rather than by a decision.
  for (const haltClass of PIPELINE_HALT_CLASSES) {
    assert.equal(
      pipelineGrantAllowed({ class: haltClass }),
      PIPELINE_HALT_ACTIONS[haltClass].includes("grant"),
      haltClass,
    );
  }
  // Exactly one class licenses it today. Stated as a literal so that widening the rule is a
  // decision somebody makes here, rather than a side effect of editing the table above.
  assert.deepEqual(
    PIPELINE_HALT_CLASSES.filter((haltClass) => pipelineGrantAllowed({ class: haltClass })),
    ["needs-human"],
  );
  assert.deepEqual([...PIPELINE_HALT_ACTIONS["plan-gap"]], []);
  assert.deepEqual([...PIPELINE_HALT_CONSOLES["plan-gap"]], []);
});

test("a request is checked against what the verb says it needs, in both directions", () => {
  const base = { provider: "ai-conductor", repoRoot: "/repo/a" };
  // A run verb needs a feature; a repository verb must not carry one.
  assert.equal(PipelineActionRequestSchema.safeParse({ ...base, action: "park" }).success, false);
  assert.equal(
    PipelineActionRequestSchema.safeParse({ ...base, action: "park", slug: "feat" }).success,
    true,
  );
  assert.equal(
    PipelineActionRequestSchema.safeParse({
      ...base,
      action: "unpark",
      slug: "feat",
      requestedBy: "foreman",
    }).success,
    true,
  );
  assert.equal(
    PipelineActionRequestSchema.safeParse({
      ...base,
      action: "unpark",
      slug: "feat",
      requestedBy: "future-automation",
    }).success,
    false,
  );
  assert.equal(
    PipelineActionRequestSchema.safeParse({ ...base, action: "daemon-pause", slug: "feat" }).success,
    false,
  );
  assert.equal(
    PipelineActionRequestSchema.safeParse({ ...base, action: "daemon-pause" }).success,
    true,
  );
  // A grant carries the step AND the operator's own words. Neither is invented downstream.
  assert.equal(
    PipelineActionRequestSchema.safeParse({ ...base, action: "grant", slug: "feat", step: "prd" })
      .success,
    false,
  );
  assert.equal(
    PipelineActionRequestSchema.safeParse({
      ...base,
      action: "grant",
      slug: "feat",
      step: "prd",
      reason: "   ",
    }).success,
    false,
    "whitespace is not a rationale",
  );
  assert.equal(
    PipelineActionRequestSchema.safeParse({
      ...base,
      action: "grant",
      slug: "feat",
      step: "prd",
      reason: "the spec's assumption changed",
    }).success,
    true,
  );
  // A step on a verb that names none is refused rather than ignored: it means the caller
  // thinks it is asking for something this verb does not do.
  assert.equal(
    PipelineActionRequestSchema.safeParse({ ...base, action: "park", slug: "feat", step: "prd" })
      .success,
    false,
  );
});

test("a reseal request names its artifacts and why, and a console names its feature", () => {
  const base = { provider: "ai-conductor", repoRoot: "/repo/a", backend: "tmux" };
  assert.equal(PipelineConsoleRequestSchema.safeParse({ ...base, console: "daemon" }).success, true);
  // Run-scoped: a reseal with no feature names nothing.
  assert.equal(PipelineConsoleRequestSchema.safeParse({ ...base, console: "reseal" }).success, false);
  assert.equal(
    PipelineConsoleRequestSchema.safeParse({ ...base, console: "reseal", slug: "feat" }).success,
    false,
    "and it names at least one sealed artifact",
  );
  assert.equal(
    PipelineConsoleRequestSchema.safeParse({
      ...base,
      console: "reseal",
      slug: "feat",
      paths: [".docs/decisions/feat.md"],
    }).success,
    false,
    "and why the seal broke",
  );
  const good = PipelineConsoleRequestSchema.safeParse({
    ...base,
    console: "reseal",
    slug: "feat",
    paths: [".docs/decisions/feat.md"],
    reason: "the decision moved after review",
  });
  assert.equal(good.success, true);
  assert.equal(good.success && good.data.clearHalt, false, "clearing the halt is asked for");
  // Bounded, because every path reaches an argv this daemon composes.
  assert.equal(
    PipelineConsoleRequestSchema.safeParse({
      ...base,
      console: "reseal",
      slug: "feat",
      paths: Array.from({ length: 21 }, (_, i) => `p${i}`),
      reason: "why",
    }).success,
    false,
  );
});
