import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CreatePersonaSchema,
  CreateScheduleSchema,
  CreateWorkflowSchema,
  DispatchSchema,
  InjectPromptSchema,
  SpendReportSchema,
} from "../src/shared/protocol.ts";
import { LLM_SPEND_ROLES } from "../src/shared/llm-spend.ts";
import { holdSignals } from "../scripts/demo/launch.mjs";
import {
  CONTINUATION_MARKER,
  DEMO_FAIL_VERDICT_MARKER,
  continuationFor,
  firstUserPrompt,
  headlessAnswer,
  loadScenarios,
  selectContinuation,
  selectScenario,
  turnUsage,
} from "../scripts/demo/fake-claude.mjs";
import {
  SEED_BACKLOG_TASKS,
  SEED_PERSONA,
  SEED_SCHEDULES,
  SEED_SESSION_TASKS,
  SEED_WORKFLOW_NAME,
  SEED_WORKFLOW_REVIEWERS,
  automationReports,
  costExports,
  reviewOutcome,
  scheduleBody,
  seedPlan,
  taskBody,
  workflowDraft,
} from "../scripts/demo/seed.mjs";
import { claudeTurnUsage } from "../src/server/harness/claude/sdk.ts";
import { BUILTIN_PERSONAS } from "../src/server/workflows/builtin-personas.ts";
import { BUILTIN_WORKFLOWS } from "../src/server/workflows/builtin-workflows.ts";
import { buildPersonaPrompt } from "../src/server/workflows/prompt.ts";
import { parsePersonaVerdict } from "../src/server/workflows/verdict.ts";
import { projectStages, stageBlockers } from "../src/shared/workflow-stages.ts";
import type { PersonaSnapshot, WorkflowContextSnapshot } from "../src/shared/workflow.ts";

/**
 * The demo seeder's pure half.
 *
 * Everything here runs without a daemon, a build, or a network, which is what lets it live in
 * `test/` and cost milliseconds - the seeder's OTHER half is covered by
 * `npm run demo -- --check`, which boots a real daemon and asserts the residue.
 *
 * Two things are worth the cases, and both are silent failures otherwise:
 *
 * 1. **Scenario routing.** Every seeded intent must reach its OWN scenario. A `match` list
 *    that shadows another produces a demo whose conversation is plausibly about the wrong
 *    task - nothing errors, nothing is empty, it is just wrong, and a reader has to know every
 *    scenario file to notice.
 * 2. **Payloads against the daemon's own schemas.** The seeder posts to real routes, so a
 *    tightened Zod schema turns `--fresh` into a wall of 400s that nobody sees until they
 *    next demo. Parsing the bodies with the SAME schema the route uses moves that to here.
 */

const SCENARIO_DIR = fileURLToPath(new URL("../scripts/demo/scenarios/", import.meta.url));
const REPO = "/tmp/demo-workspace/demo-api";

/** The prompt `SdkSupervisor.resume` sends a session that was mid-turn when the daemon went down. */
const RESTART_CONTINUATION_PROMPT =
  "Mission Control restarted while your previous turn was still in progress. " +
  "Continue that work from the current checkout and conversation. Inspect the current " +
  "state before acting, do not repeat completed work, and ask again for any approval or " +
  "input you still need.";

test("every shipped scenario file parses and exactly one is the default", () => {
  const scenarios = loadScenarios(SCENARIO_DIR);
  // A count rather than "some": a file that fails to parse is skipped silently by design (one
  // bad scenario must not take the demo down), so only a count notices a broken one.
  assert.equal(scenarios.length, 10, "all ten scenario files should load");
  const defaults = scenarios.filter((s) => s.default === true);
  assert.equal(defaults.length, 1, "exactly one scenario may be the fallback");
  for (const scenario of scenarios) {
    assert.ok(scenario.title, "every scenario needs a title - the `-p` titler returns it");
    assert.ok(Array.isArray(scenario.steps) && scenario.steps.length > 0);
  }
});

test("each seeded session task routes to its own scenario, not another's", () => {
  const scenarios = loadScenarios(SCENARIO_DIR);
  const routed = SEED_SESSION_TASKS.map((task) => selectScenario(scenarios, task.intent).title);
  assert.deepEqual(routed, [
    "Cache the workspace repo scan",
    "Stop the token refresh double-fetch",
    "Move the ledger to cursor pagination",
    "Add a health probe to the OTLP exporter",
    "UI Polish",
  ]);
  // And no two of them share a scenario, which the list above would still allow if two
  // titles happened to match.
  assert.equal(new Set(routed).size, routed.length, "no two seeded tasks may share a scenario");
});

test("a seeded intent never falls through to the default scenario", () => {
  const scenarios = loadScenarios(SCENARIO_DIR);
  const fallback = scenarios.find((s) => s.default === true);
  for (const task of SEED_SESSION_TASKS) {
    assert.notEqual(
      selectScenario(scenarios, task.intent).title,
      fallback?.title,
      `"${task.intent}" matched nothing and fell back - the seeded card would narrate the wrong work`,
    );
  }
});

test("the restart continuation prompt routes to the scenario that asks again", () => {
  // This is the whole mechanism behind a waiting-on-you CARD at first paint: the seeded
  // pagination session is suspended mid-ask, and the restore sends this prompt.
  const scenarios = loadScenarios(SCENARIO_DIR);
  const picked = selectScenario(scenarios, RESTART_CONTINUATION_PROMPT);
  assert.equal(picked.title, "Continuing after a restart");
  assert.ok(
    picked.steps.some((step) => step.kind === "ask"),
    "the continuation scenario must re-raise a question, or the card comes back idle",
  );
  // The prompt itself carries the marker the player recognises a continuation by. Asserted
  // against the real sentence rather than trusted, because the marker is a PREFIX of a daemon
  // string this file also holds a copy of, and a drift between the two is silent.
  assert.ok(RESTART_CONTINUATION_PROMPT.includes(CONTINUATION_MARKER));
});

test("each waiting session's continuation asks about ITS OWN work", () => {
  // The demo could hold exactly one waiting-on-you card before continuations were routed by the
  // work they belong to: every restored session gets the same prompt word for word, so a second
  // one came back re-asking the first one's questions - a card narrating the wrong task, which is
  // the failure this whole file exists to catch.
  const scenarios = loadScenarios(SCENARIO_DIR);
  const waiting = SEED_SESSION_TASKS.filter((task) => task.settle === "leave-waiting");
  assert.ok(waiting.length >= 2, "this case is only meaningful with two waiting sessions");

  const continuationTitles = waiting.map((task) =>
    selectContinuation(scenarios, task.intent, RESTART_CONTINUATION_PROMPT).title);
  assert.deepEqual(continuationTitles, [
    // Pagination keeps the generic continuation it shipped with, whose questions are its own.
    "Continuing after a restart",
    "Continuing the UI polish after a restart",
  ]);
  assert.equal(new Set(continuationTitles).size, continuationTitles.length);

  // And every continuation re-raises a question, because that held dialog is what keeps the card
  // waiting on a human - and, for UI Polish, what holds its queued messages.
  for (const title of continuationTitles) {
    const scenario = scenarios.find((candidate) => candidate.title === title)!;
    assert.ok(scenario.steps.some((step) => step.kind === "ask"), `${title} must ask again`);
  }
});

test("a continuation is declared by the scenario it continues, and is never picked otherwise", () => {
  const scenarios = loadScenarios(SCENARIO_DIR);
  const uiPolish = scenarios.find((s) => s.title === "UI Polish")!;
  assert.equal(continuationFor(scenarios, uiPolish)?.title, "Continuing the UI polish after a restart");
  // A scenario nothing continues answers null rather than the first file that happens to sit
  // beside it, which is what makes the fallback in `selectContinuation` reachable and honest.
  assert.equal(continuationFor(scenarios, scenarios.find((s) => s.title === "UI Polish is not a thing")), null);
  // A continuation must not be reachable from an ordinary dispatch: its `match` is empty, so the
  // only way in is the continuation route. Otherwise a person dispatching "polish the UI" would
  // get a session that opens by talking about a restart that never happened.
  const continuation = scenarios.find((s) => s.continues === "UI Polish")!;
  assert.deepEqual(continuation.match, []);
  assert.notEqual(selectScenario(scenarios, uiPolish.title).title, continuation.title);
});

test("firstUserPrompt reads the dispatched intent back out of a transcript", () => {
  // What a RESUMED player knows about the work it is continuing: nothing, except this file. The
  // process is new, the prompt it just received is the same for every session, and the transcript
  // is the only thing that survived the restart.
  const record = (type: string, content: unknown): string =>
    JSON.stringify({ type, uuid: `${type}-1`, message: { role: type, content } });
  assert.equal(
    firstUserPrompt([record("user", "UI polish: even out the card header chips.")]),
    "UI polish: even out the card header chips.",
  );
  // The composer sends blocks rather than a bare string once anything is attached.
  assert.equal(
    firstUserPrompt([record("user", [{ type: "text", text: "queued follow-up" }])]),
    "queued follow-up",
  );
  // The FIRST user turn, not the newest: on a second restart the transcript also holds the
  // previous continuation prompt, and reading that would route the session to a continuation of
  // a continuation.
  assert.equal(
    firstUserPrompt([
      record("assistant", [{ type: "text", text: "working" }]),
      record("user", "the original intent"),
      record("user", RESTART_CONTINUATION_PROMPT),
    ]),
    "the original intent",
  );
  // Tolerant of a file another build wrote, and of no user turn at all.
  assert.equal(firstUserPrompt(["", "not json", record("assistant", "hi")]), null);
  assert.equal(firstUserPrompt([]), null);
});

test("the queued messages parse under the route's own InjectPromptSchema", () => {
  // The seeder posts these to `/api/sessions/:id/inject`, and the two DEFAULTS are what make a
  // message queue instead of being typed at the session: `origin: "human"` with `buffer: true` is
  // the pair `PendingTurnManager.submit` is reached by.
  const queued = SEED_SESSION_TASKS.flatMap((task) => task.queuedMessages ?? []);
  assert.ok(queued.length >= 3, "the demo should show a queue with several messages in it");
  for (const text of queued) {
    const parsed = InjectPromptSchema.safeParse({ text });
    assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
    assert.equal(parsed.data.origin, "human");
    assert.equal(parsed.data.buffer, true);
  }
});

test("only a card parked on a question carries queued messages", () => {
  // `PendingTurnManager.canDrain` requires `paneDialog === null`, so an outbox on any other kind
  // of card is delivered about a second and a half after the demo opens - and the queue the card
  // exists to show would be gone before anybody saw it.
  for (const task of SEED_SESSION_TASKS) {
    if ((task.queuedMessages ?? []).length === 0) continue;
    assert.equal(
      task.settle,
      "leave-waiting",
      `${task.key} queues messages but does not park on a question, so they would drain`,
    );
  }
  const queueing = SEED_SESSION_TASKS.filter((task) => (task.queuedMessages ?? []).length > 0);
  assert.equal(queueing.length, 1, "one card with an outbox is the demo; two is noise");
  assert.equal(queueing[0]!.title, "UI Polish");
});

test("the live starter scenarios still own their own prompts", () => {
  // Phase 1's three scenarios are what a live dispatch from the dashboard hits. The seed
  // scenarios were added beside them and must not have stolen their matches.
  const scenarios = loadScenarios(SCENARIO_DIR);
  assert.equal(selectScenario(scenarios, "Fix the flaky retry test").title, "Fix the retry/abort race");
  assert.equal(
    selectScenario(scenarios, "Surface rate limits on the dashboard").title,
    "Surface rate limits on the dashboard",
  );
  assert.equal(
    selectScenario(scenarios, "Migrate the fleet summary to a running total").title,
    "Migrate the fleet summary to a running total",
  );
});

test("the scenario matcher is case-insensitive and tolerates a missing prompt", () => {
  const scenarios = loadScenarios(SCENARIO_DIR);
  assert.equal(selectScenario(scenarios, "CURSOR PAGINATION, please").title, "Move the ledger to cursor pagination");
  // Not a crash: the driver can deliver an empty first turn, and a scenario table with a
  // default always has an answer.
  assert.equal(selectScenario(scenarios, "").default, true);
  assert.equal(selectScenario(scenarios, undefined).default, true);
});

test("every seeded task body parses under the route's own DispatchSchema", () => {
  for (const spec of SEED_SESSION_TASKS) {
    const parsed = DispatchSchema.safeParse(taskBody(spec, REPO, { backlog: false }));
    assert.ok(parsed.success, `${spec.key}: ${parsed.success ? "" : parsed.error.message}`);
    assert.equal(parsed.data.backlog, false);
    // `null`, not absent: an omitted workflowId applies the machine default after-work
    // Workflow, whose allowlist can refuse the dispatch.
    assert.equal(parsed.data.workflowId, null);
  }
  for (const spec of SEED_BACKLOG_TASKS) {
    const parsed = DispatchSchema.safeParse(
      taskBody(spec, REPO, { backlog: true, dependsOnTaskId: "some-task-id" }),
    );
    assert.ok(parsed.success, `${spec.key}: ${parsed.success ? "" : parsed.error.message}`);
    assert.equal(parsed.data.backlog, true);
    assert.deepEqual(parsed.data.dependencies, [{ type: "task", taskId: "some-task-id" }]);
  }
});

test("a task body with no blocker declares no dependencies at all", () => {
  const parsed = DispatchSchema.parse(taskBody(SEED_BACKLOG_TASKS[0]!, REPO, { backlog: true }));
  assert.deepEqual(parsed.dependencies, []);
});

test("every seeded schedule body parses under CreateScheduleSchema", () => {
  for (const spec of SEED_SCHEDULES) {
    const parsed = CreateScheduleSchema.safeParse(scheduleBody(spec, REPO, "UTC"));
    assert.ok(parsed.success, `${spec.name}: ${parsed.success ? "" : parsed.error.message}`);
    // Five fields exactly - the schema refuses anything else, and a six-field crontab is the
    // easy mistake.
    assert.equal(spec.expression.trim().split(/\s+/).length, 5);
  }
});

test("seeded schedules stay inside the service's one-hour minimum interval", () => {
  // `SCHEDULE_MIN_INTERVAL_MS` is an hour, enforced by the service rather than the schema, so
  // a `* * * * *` would pass CreateScheduleSchema above and be refused at runtime.
  for (const spec of SEED_SCHEDULES) {
    const [minute, hour] = spec.expression.split(" ");
    assert.notEqual(minute, "*", `${spec.name} fires every minute`);
    assert.notEqual(hour, "*", `${spec.name} fires every hour`);
  }
});

test("the seeded persona and workflow draft parse under their own schemas", () => {
  const persona = CreatePersonaSchema.safeParse(SEED_PERSONA);
  assert.ok(persona.success, persona.success ? "" : persona.error.message);

  const workflow = CreateWorkflowSchema.safeParse({
    name: SEED_WORKFLOW_NAME,
    draft: workflowDraft({ customPersonaId: "persona-id" }),
  });
  assert.ok(workflow.success, workflow.success ? "" : workflow.error.message);
  // `{kind:"none"}` by omission, and that is the load-bearing default: an `inspector` completion
  // policy would park the run on the Inspector's pull-request gate, which the demo - no network,
  // no `gh` - can never answer.
  assert.deepEqual(workflow.data.completionPolicy, { kind: "none" });
});

test("the seeded workflow draft is a pipeline the app itself can read", () => {
  // Hand-written to mirror `compileStages`, so the app's own projector is the only honest check
  // that it wired the ports, the join and the repair routes the way a real editor would have. A
  // graph the projector rejects still publishes and still runs - it just cannot be opened in the
  // Pipeline editor, and the demo's showcase workflow opening in fallback Graph view would be a
  // quiet downgrade nobody notices until they click it.
  const draft = workflowDraft({ customPersonaId: "persona-id" });
  assert.deepEqual(stageBlockers(draft), []);
  const pipeline = projectStages(draft);
  assert.ok(pipeline, "the seeded draft must express a pipeline");
  assert.equal(pipeline.endOutcome, "Complete");
  assert.deepEqual(
    pipeline.stages.map((stage) =>
      (stage.kind === "evaluation" ? stage.members : [stage.member]).map((member) =>
        member.kind === "persona" ? member.personaId : `check:${member.kind === "check" ? member.slot : ""}`)),
    [
      // No-Mistakes Review v3's own stage order: the deterministic gate first, so a change that
      // does not compile costs no model call...
      ["check:typecheck", "check:test"],
      // ...then Intent Conformance alone, the cheap judge that keeps a drifted change from
      // costing four reviews...
      [SEED_WORKFLOW_REVIEWERS.intent],
      // ...then the deep reviews in parallel behind it, the seeded custom Persona among them.
      [
        SEED_WORKFLOW_REVIEWERS.risk,
        SEED_WORKFLOW_REVIEWERS.evidence,
        SEED_WORKFLOW_REVIEWERS.documentation,
        "persona-id",
      ],
    ],
  );
  // Each parallel stage needs its all-pass join, or "they all agreed" would mean "the first one
  // to answer agreed". The single-member stage must NOT have one.
  const joins = pipeline.stages.map((stage) =>
    stage.kind === "evaluation" ? stage.joinId !== null : false);
  assert.deepEqual(joins, [true, false, true]);
});

test("the seeded workflow is No-Mistakes Review v3's shape, minus the Inspector gate", () => {
  // The claim this pins is a comparison, and it is the reason the seeded copy exists at all: the
  // graph is the built-in's, stage for stage, and the ONE thing dropped is the completion policy -
  // which `enterInspectorGate` would record `blocked` on a machine with the Inspector off, and
  // which cannot be satisfied here at all because every read of a pull request's state goes
  // through `gh` against a real GitHub.
  const builtin = BUILTIN_WORKFLOWS.find((w) => w.definition.name === "No-Mistakes Review");
  assert.ok(builtin, "this build must still ship No-Mistakes Review");
  const v3 = builtin.versions.find((version) => version.version === 3);
  assert.ok(v3, "version 3 is the one whose graph the demo copies");

  const stageShape = (graph: Parameters<typeof projectStages>[0]): string[][] =>
    projectStages(graph)!.stages.map((stage) =>
      (stage.kind === "evaluation" ? stage.members : [stage.member]).map((member) =>
        member.kind === "persona"
          ? member.personaId
          : member.kind === "check"
            ? `check:${member.slot}`
            : `action:${member.sessionActionId}`));

  // Same stages, in the same order, naming the same shipped roles - compared against the built-in's
  // own published graph rather than against a description of it, so a version-3 edit fails here.
  assert.deepEqual(
    stageShape(workflowDraft()),
    stageShape(v3.graph),
    "the seeded stages must be version 3's",
  );

  // And the ONE difference: the built-in ends on the Inspector, the seeded copy on its End node.
  assert.equal(v3.completionPolicy.kind, "inspector");
  assert.equal(
    CreateWorkflowSchema.parse({ name: SEED_WORKFLOW_NAME }).completionPolicy.kind,
    "none",
  );
});

test("the seeded workflow is still a pipeline without the custom persona", () => {
  // The seeded Persona is created before the Workflow, but a plan without one (or a future
  // reduced plan) must not produce a graph the projector rejects.
  const draft = workflowDraft();
  assert.deepEqual(stageBlockers(draft), []);
  assert.equal(projectStages(draft)?.stages.length, 3);
  assert.equal(draft.nodes.filter((node) => node.kind === "persona").length, 4);
  assert.equal(draft.nodes.filter((node) => node.kind === "check").length, 2);
});

test("every built-in reviewer the seeded workflow names is one this build ships", () => {
  // A slug that no longer ships fails PUBLISH with a `missing_persona` diagnostic in the middle
  // of a several-minute seed, which is the expensive place to find out.
  const shipped = new Set(BUILTIN_PERSONAS.map((persona) => persona.id));
  for (const [role, id] of Object.entries(SEED_WORKFLOW_REVIEWERS)) {
    assert.ok(shipped.has(id), `${role} names ${id}, which BUILTIN_PERSONAS does not contain`);
  }
});

/** A minimal-but-real review context, so the prompt under test is the prompt a run builds. */
function reviewContext(): WorkflowContextSnapshot {
  return {
    primaryGoal: {
      rawPrompt: "Add a health probe to the OTLP exporter so a wedged collector is visible.",
      refined: null,
      sourceNoteKey: "note",
    },
    humanDecisions: [],
    constraints: [],
    acceptanceCriteria: [],
    priorPersonaFeedback: [],
    session: { agent: "claude", name: "Add a health probe", cwd: "/repo", branch: "harness/probe" },
    evidence: {
      headSha: "1dbd885",
      diffFingerprint: "fingerprint",
      diff: "diff --git a/src/exporter-health.ts b/src/exporter-health.ts",
      diffTruncated: false,
      workingTreeDirty: true,
      workingTreeStatus: [" M src/dashboard.ts"],
      workingTreeStatusTruncated: false,
      transcript: [{ role: "user", content: "Add a health probe" }],
      transcriptAnchor: 1,
      transcriptTruncated: false,
      standards: [],
      standardsTruncated: false,
      retention: { state: "full" },
    },
    compaction: { status: "model", runner: "claude", model: "claude-haiku-4-5", error: null },
  };
}

const snapshotOf = (name: string, guidanceMarkdown: string): PersonaSnapshot => ({
  sourcePersonaId: "persona",
  sourceRevision: 1,
  name,
  description: "",
  guidanceMarkdown,
  runner: null,
  model: null,
});

test("the demo player answers a real Persona review prompt with a parseable pass", () => {
  // THE case for the seeded run being a clean completion. A Persona review has no fallback: a
  // verdict `parsePersonaVerdict` cannot read is an infrastructure failure, and three of those
  // block the run - so the demo's showcase card would read "Workflow blocked" instead of
  // "⌁ Approved". Both real halves are in the loop here: the daemon's own prompt builder and its
  // own parser, with only the fake in between.
  const prompt = buildPersonaPrompt(
    snapshotOf("Intent Conformance Judge", "# Intent Conformance Judge\n\nJudge drift."),
    reviewContext(),
  );
  const verdict = parsePersonaVerdict(headlessAnswer(prompt));
  assert.ok(verdict, "the player's answer must parse as a PersonaVerdict");
  assert.equal(verdict.verdict, "pass");
  // Named, not generic: four cards all reading "Demo approval" would tell an operator nothing
  // about which reviewer said it.
  assert.match(verdict.summary, /Intent Conformance Judge/);
});

test("each seeded reviewer's verdict names that reviewer", () => {
  // The custom entry is the REAL seeded document rather than a stand-in, which is what pins its
  // heading and its `name` to agree: the verdict is rendered beside the node's own label, and two
  // spellings of one reviewer read as two reviewers.
  assert.match(SEED_PERSONA.guidanceMarkdown, new RegExp(`^# ${SEED_PERSONA.name}$`, "m"));
  const guidance = {
    "Code Risk Reviewer": "# Code Risk Reviewer\n\nHunt for the failure mode.",
    "Test Evidence Auditor": "## Test Evidence Auditor\n\nWhich test would fail?",
    [SEED_PERSONA.name]: SEED_PERSONA.guidanceMarkdown,
  };
  for (const [name, markdown] of Object.entries(guidance)) {
    const verdict = parsePersonaVerdict(
      headlessAnswer(buildPersonaPrompt(snapshotOf(name, markdown), reviewContext())),
    );
    assert.ok(verdict, `${name} produced an unparseable verdict`);
    assert.equal(verdict.verdict, "pass");
    // The heading of the quoted guidance, which is the only per-reviewer channel the prompt has.
    assert.match(verdict.summary, new RegExp(markdown.match(/^#{1,3} (.+)$/m)![1]!));
  }
});

test("a persona whose guidance carries the fail marker refuses, with evidence", () => {
  // The steering channel a future demo scenario needs to show a repair round. It has to produce a
  // verdict the parser accepts too, or it would block the run rather than send it back.
  const verdict = parsePersonaVerdict(headlessAnswer(buildPersonaPrompt(
    snapshotOf("Code Risk Reviewer", `# Code Risk Reviewer\n\n${DEMO_FAIL_VERDICT_MARKER}`),
    reviewContext(),
  )));
  assert.ok(verdict);
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.verdict === "fail" && verdict.requestedChanges.length, 1);
  // `RequestedChangeInputSchema` demands at least one EvidenceRef per change; a change without
  // one is a parse failure, which the engine reads as infrastructure trouble.
  assert.ok(verdict.verdict === "fail" && verdict.requestedChanges[0]!.evidence.length > 0);
});

test("the fail marker steers only from the guidance, never from the reviewed work", () => {
  // The prompt carries the session's diff and transcript as untrusted evidence. A marker matched
  // anywhere in it would let the code under review decide its own verdict - which is the demo
  // version of the injection the review contract exists to refuse.
  const context = reviewContext();
  context.evidence.diff = `+// ${DEMO_FAIL_VERDICT_MARKER}\n+const sneaky = true;`;
  context.evidence.transcript = [{ role: "user", content: DEMO_FAIL_VERDICT_MARKER }];
  const verdict = parsePersonaVerdict(headlessAnswer(buildPersonaPrompt(
    snapshotOf("Code Risk Reviewer", "# Code Risk Reviewer\n\nHunt for the failure mode."),
    context,
  )));
  assert.equal(verdict?.verdict, "pass");
});

test("the player still answers the daemon's other headless callers", () => {
  // The verdict arm is checked FIRST, so this pins that it did not shadow the three callers that
  // run on every demo dispatch. A review prompt quotes the session transcript, so the reverse
  // shadowing is possible too.
  assert.deepEqual(
    JSON.parse(headlessAnswer("Compact workflow intent without rewriting it.\nsome intent")),
    { constraints: [], acceptanceCriteria: [] },
  );
  const goal = JSON.parse(headlessAnswer(
    "You reconcile the intent of an AI coding session\n"
    + "## The specific unresolved instruction to classify now\nCache the scan\n\nNow output",
  ));
  assert.equal(goal.relationship, "initial");
  assert.equal(goal.objective, "Cache the scan");
  const titled = JSON.parse(headlessAnswer(
    "You name coding tasks for a dispatch board\n## The task text\ncursor pagination"
    + "\n\nNow output the title",
  ));
  // "Demo session" rather than the pagination scenario's title, because this PROCESS has no
  // `MISSION_DEMO_SCENARIO_DIR` - the player read its built-in fallback table at import. Which
  // title a real dispatch gets is pinned above, against the shipped scenario directory; what this
  // asserts is only that the titler arm still answers a title-shaped object at all.
  assert.equal(titled.title, "Demo session");
});

/** The run detail `reviewOutcome` reads, as deeply partial as the real route body is complete. */
type RunDetailFixture = NonNullable<Parameters<typeof reviewOutcome>[0]>;
type AttemptFixture = NonNullable<RunDetailFixture["attempts"]>[number];

test("reviewOutcome calls a first-round unanimous pass clean, and nothing else", () => {
  const attempt = (
    nodeId: string,
    name: string,
    verdict: "pass" | "fail",
    over: AttemptFixture = {},
  ): AttemptFixture => ({
    nodeId,
    attempt: 1,
    state: "completed",
    persona: { name },
    verdict: { verdict },
    error: null,
    sessionAction: null,
    ...over,
  });
  /** The engine synthesizes these for every submission; they carry no verdict and no opinion. */
  const structural = (nodeId: string): AttemptFixture =>
    ({ nodeId, attempt: 1, state: "completed", persona: null, verdict: null, error: null });
  const detail = (over: RunDetailFixture = {}): RunDetailFixture => ({
    run: { status: "completed", currentPhase: "complete" },
    summary: { round: 1, failedPersonaCount: 0 },
    attempts: [
      // Counted as reviewers, a run that reviewed nothing would look unanimous.
      structural("session"),
      structural("end"),
      attempt("intent-conformance", "Intent Conformance Judge", "pass"),
      attempt("code-risk", "Code Risk Reviewer", "pass"),
    ],
    ...over,
  });

  const clean = reviewOutcome(detail());
  assert.equal(clean.clean, true);
  assert.equal(clean.reviewers.length, 2, "only the verdict-bearing attempts are reviewers");
  assert.match(clean.summary, /2 reviewers passed on round 1/);

  // A Check carries a verdict too - synthetic, which is what lets a join aggregate it beside a
  // Persona's - but it is counted apart: "7 reviewers passed" over five reviewers and two skipped
  // checks would overstate what a demo of this pipeline actually demonstrates.
  const gated = reviewOutcome(detail({
    attempts: [
      ...(detail().attempts ?? []),
      { ...attempt("check-typecheck", "unused", "pass"), persona: null },
      { ...attempt("check-test", "unused", "pass"), persona: null },
    ],
  }));
  assert.equal(gated.clean, true);
  assert.equal(gated.reviewers.length, 2);
  assert.deepEqual(gated.checks.map((check) => check.name), ["check-typecheck", "check-test"]);
  assert.match(gated.summary, /2 checks cleared, 2 reviewers passed on round 1/);

  // A check that did NOT pass is not clean, even with every reviewer agreeing: the gate is the
  // stage that decides whether the reviews were worth spending at all.
  const failedCheck = reviewOutcome(detail({
    attempts: [
      ...(detail().attempts ?? []),
      { ...attempt("check-test", "unused", "fail"), persona: null },
    ],
  }));
  assert.equal(failedCheck.clean, false);
  assert.match(failedCheck.summary, /1 did not pass/);

  // Completed, but on round two: a completion that took a repair round is not what the demo is
  // showing, and the count alone could never tell them apart.
  const repaired = reviewOutcome(detail({ summary: { round: 2, failedPersonaCount: 1 } }));
  assert.equal(repaired.clean, false);
  assert.match(repaired.summary, /round 2/);

  // Completed having reviewed nothing - exactly what the two-node stub this replaced produced.
  const empty = reviewOutcome(detail({ attempts: [structural("session"), structural("end")] }));
  assert.equal(empty.clean, false);
  assert.match(empty.summary, /no reviewer/);

  // Passed, but only after a provider retry: the run detail shows `attempt 2` on that card.
  const retried = reviewOutcome(detail({
    attempts: [
      ...(detail().attempts ?? []),
      attempt("code-risk", "Code Risk Reviewer", "pass", { attempt: 2 }),
    ],
  }));
  assert.equal(retried.clean, false);
  assert.match(retried.summary, /retried/);

  // Blocked, which is what an unparseable verdict eventually produces.
  const blocked = reviewOutcome(detail({
    run: { status: "blocked", currentPhase: "infrastructure_error" },
  }));
  assert.equal(blocked.clean, false);
  assert.match(blocked.summary, /blocked/);
});

test("cost exports stamp nanosecond timestamps as digit strings, never floats", () => {
  // The trap this pins: `usage_ledger.window_end_ns` is TEXT because timeUnixNano (~1.78e18)
  // is past Number.MAX_SAFE_INTEGER. A number here stringifies to "1.785e+21" and
  // `nanoString` (which demands /^\d+$/) drops the datapoint - a silently empty cost chip.
  const nowMs = 1_785_000_000_000;
  const exports = costExports({ nowMs, days: 2 });
  let points = 0;
  for (const body of exports) {
    for (const metric of body.resourceMetrics[0]!.scopeMetrics[0]!.metrics) {
      for (const dp of metric.sum.dataPoints) {
        points += 1;
        assert.match(String(dp.timeUnixNano), /^\d+$/);
        assert.match(String(dp.startTimeUnixNano), /^\d+$/);
        // Delta, not cumulative: each export is its own window so rows accumulate.
        assert.equal(metric.sum.aggregationTemporality, 1);
      }
    }
  }
  assert.ok(points > 0);
});

test("a finished demo turn reports usage the driver can put in the ledger", () => {
  // The other half of the demo's cost chip, and the half that has to go through the DRIVER: an
  // OTLP row naming a driven session is dropped, so a card's own spend can only arrive off its
  // `result` frame. `recordDriverTurnUsage` writes nothing unless `claudeTurnUsage` comes back
  // with a turn id AND at least one model, which is exactly what an envelope missing `uuid` or
  // `modelUsage` produces - silently, and only visible as a fleet that spent $0.00.
  const frame = { type: "result", subtype: "success", session_id: "demo", ...turnUsage() };
  const usage = claudeTurnUsage(frame as never, "claude-demo-mock");
  assert.ok(usage, "the result frame must report usage");
  assert.ok(usage.turnId, "without a turn id the ledger has no dedup key and drops the row");
  assert.equal(usage.models?.length, 1);
  const [model] = usage.models!;
  assert.equal(model!.modelId, "claude-demo-mock", "the ledger charges the model the card shows");
  // Priced: one unknown row today turns the whole fleet figure into "unpriced" rather than a
  // smaller number, which reads as a broken chip.
  assert.ok((model!.reportedCostUsd ?? 0) > 0);
  assert.ok(model!.input > 0 && model!.output > 0 && model!.cacheRead > 0);

  // Each turn differs, so a card's total is not one number times a count - and every turn gets
  // its own id, or the ledger's unique index would treat the second as a re-record of the first.
  const next = claudeTurnUsage(
    { type: "result", ...turnUsage() } as never,
    "claude-demo-mock",
  );
  assert.notEqual(next?.turnId, usage.turnId);
  assert.notEqual(next?.models?.[0]?.input, model!.input);
});

test("cost exports name no live card, and reach both today and the days behind it", () => {
  const nowMs = 1_785_000_000_000;
  const days = 3;
  const exports = costExports({ nowMs, days });
  const rows = exports.flatMap((body) =>
    body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.flatMap((m) =>
      m.sum.dataPoints.map((dp) => ({
        sessionId: dp.attributes.find((a) => a.key === "session.id")!.value.stringValue,
        atMs: Number(BigInt(dp.timeUnixNano) / 1_000_000n),
      })),
    ),
  );

  // THE rule, and the one this used to get wrong: not one row may name a session the demo has a
  // card for. `Registry.applyOtelMetrics` drops every datapoint whose note key belongs to a driven
  // session (`sdkOwnedNoteKey`) - the driver owns that key's spend - so a row attributed to a
  // seeded card is not a per-card figure, it is a row that silently never lands.
  for (const row of rows) {
    assert.match(
      row.sessionId,
      /^demo-(earlier-today|history)-/,
      "an OTLP row may only name a session that is over",
    );
  }

  // Earlier today, so the topbar's today figure is nonzero even before a card finishes a turn -
  // and never stamped ahead of `nowMs`, which would put spend in the future.
  const today = rows.filter((r) => r.sessionId.startsWith("demo-earlier-today-"));
  assert.ok(today.length > 0, "some of today's spend must come from a session that is over");
  for (const row of today) {
    assert.ok(row.atMs < nowMs, "earlier today means earlier");
    assert.ok(row.atMs > nowMs - 3 * 3_600_000, "and still today, not last night");
  }

  // And the days behind it, so the cost drawer's per-day view has bars to draw.
  const history = rows.filter((r) => r.sessionId.startsWith("demo-history-"));
  assert.ok(history.length > 0);
  for (const row of history) assert.ok(row.atMs < nowMs, "history must be backdated");
  const oldest = Math.min(...history.map((r) => r.atMs));
  assert.ok(oldest < nowMs - (days - 1) * 86_400_000, "history should span the requested days");
});

test("automation reports name only roles this build knows, with unique run ids", () => {
  const reports = automationReports({ nowMs: 1_785_000_000_000, days: 4 });
  assert.ok(reports.length > 0);
  const runIds = new Set<string>();
  for (const report of reports) {
    // The route validates `role` against this exact enum and answers 422 otherwise, which
    // the seeder would surface as a thrown error mid-seed.
    assert.ok(
      (LLM_SPEND_ROLES as readonly string[]).includes(report.role),
      `${report.role} is not an LlmSpendRole`,
    );
    const parsed = SpendReportSchema.safeParse(report);
    assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
    // `ON CONFLICT DO NOTHING` on (note_key, model_id, query_source, window_end_ns), where
    // window_end_ns holds the run id - so a duplicate id silently drops a row.
    assert.ok(!runIds.has(report.runId), `duplicate runId ${report.runId}`);
    runIds.add(report.runId);
    // A priced row: one `cost_known = 0` anywhere in the window nulls the whole figure.
    for (const model of report.models) assert.ok((model.reportedCostUsd ?? 0) > 0);
  }
});

test("the reduced seed is a strict subset that still exercises suspend and restore", () => {
  const full = seedPlan();
  const reduced = seedPlan({ reduced: true });

  assert.equal(full.sessionTasks.length, SEED_SESSION_TASKS.length);
  assert.ok(reduced.sessionTasks.length < full.sessionTasks.length);
  assert.ok(reduced.backlogTasks.length < full.backlogTasks.length);

  for (const task of reduced.sessionTasks) assert.ok(full.sessionTasks.includes(task));
  for (const task of reduced.backlogTasks) assert.ok(full.backlogTasks.includes(task));

  // `--check`'s one dispatched session must be the one that suspends MID-ASK: that is the
  // path with a continuation turn in it, and the one most likely to break silently.
  assert.deepEqual(
    reduced.sessionTasks.map((t) => t.settle),
    ["leave-waiting"],
  );
  assert.ok(reduced.ledgerDays >= 1, "even the reduced seed needs a priced ledger row");
});

test("the README seed keeps a real fleet tour without the full demo's breadth", () => {
  const readme = seedPlan({ readme: true });

  assert.deepEqual(readme.sessionTasks.map((task) => task.key), ["pagination"]);
  assert.deepEqual(readme.backlogTasks.map((task) => task.key), ["ingest", "pool-docs"]);
  assert.equal(readme.persona?.name, "Demo test-first reviewer");
  assert.equal(readme.workflow, false);
  assert.equal(readme.ledgerDays, 1);
});

test("the non-fleet screenshot seed does not spend time creating sessions", () => {
  const capture = seedPlan({ capture: true });

  assert.deepEqual(capture.sessionTasks, []);
  assert.deepEqual(capture.backlogTasks, []);
  assert.equal(capture.persona?.name, "Demo test-first reviewer");
  assert.equal(capture.workflow, false);
});

test("the full seed covers every settle mode, so the fleet shows mixed states", () => {
  const settles = new Set(seedPlan().sessionTasks.map((t) => t.settle));
  assert.deepEqual(
    [...settles].sort(),
    ["complete", "leave-running", "leave-waiting", "workflow"],
  );
});

test("the full backlog covers ready, blocked, parked and cancelled", () => {
  const backlog = seedPlan().backlogTasks;
  assert.ok(backlog.some((t) => t.dependsOn), "one task must be blocked on another");
  assert.ok(backlog.some((t) => t.park), "one task must be parked");
  assert.ok(backlog.some((t) => t.cancel), "one task must be cancelled");
  assert.ok(
    backlog.some((t) => !t.dependsOn && !t.park && !t.cancel),
    "and one must be plainly ready",
  );
  // The blocker has to be declared before its dependent, because the seeder resolves the
  // edge from tasks it has already created.
  const blocked = backlog.findIndex((t) => t.dependsOn);
  const blocker = backlog.findIndex((t) => t.key === backlog[blocked]!.dependsOn);
  assert.ok(blocker >= 0 && blocker < blocked, "a blocker must be declared before its dependent");
});

test("holdSignals registers exactly one handler per signal and releases both", () => {
  // The leak this pins is not the orphan - it is the STALE LISTENER. The seed holds a daemon
  // for minutes and wires signals to it; `main` then boots a second daemon and installs its
  // own handlers. A release that missed one would leave a signal stopping the daemon the
  // operator is no longer looking at, while the one they are looking at survives.
  const before = {
    int: process.listenerCount("SIGINT"),
    term: process.listenerCount("SIGTERM"),
  };

  let stops = 0;
  const release = holdSignals(async () => {
    stops += 1;
  });
  assert.equal(process.listenerCount("SIGINT"), before.int + 1);
  assert.equal(process.listenerCount("SIGTERM"), before.term + 1);
  assert.equal(stops, 0, "holding must not stop anything by itself");

  release();
  assert.equal(process.listenerCount("SIGINT"), before.int);
  assert.equal(process.listenerCount("SIGTERM"), before.term);
});

test("holdSignals releases idempotently, so a double release cannot strip a later hold", () => {
  // `seedDemoFleet` releases in a `finally` that also runs on the error path, and a caller
  // could reasonably release again. Removing a listener twice must not reach past this hold
  // into whatever registered before it.
  const baseline = process.listenerCount("SIGINT");
  const release = holdSignals(async () => {});
  release();
  release();
  assert.equal(process.listenerCount("SIGINT"), baseline);
});
