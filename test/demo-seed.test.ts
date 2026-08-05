import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CreatePersonaSchema,
  CreateScheduleSchema,
  CreateWorkflowSchema,
  DispatchSchema,
  SpendReportSchema,
} from "../src/shared/protocol.ts";
import { LLM_SPEND_ROLES } from "../src/shared/llm-spend.ts";
import { loadScenarios, selectScenario } from "../scripts/demo/fake-claude.mjs";
import {
  SEED_BACKLOG_TASKS,
  SEED_PERSONA,
  SEED_SCHEDULES,
  SEED_SESSION_TASKS,
  automationReports,
  costExports,
  scheduleBody,
  seedPlan,
  taskBody,
  workflowDraft,
} from "../scripts/demo/seed.mjs";

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
 *    task - nothing errors, nothing is empty, it is just wrong, and a reader has to know all
 *    eight scenario files to notice.
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
  // 8 rather than "some": a file that fails to parse is skipped silently by design (one bad
  // scenario must not take the demo down), so only a count notices a broken one.
  assert.equal(scenarios.length, 8, "all eight scenario files should load");
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
    name: "Demo review and ship",
    draft: workflowDraft(),
  });
  assert.ok(workflow.success, workflow.success ? "" : workflow.error.message);
  // The graph has to actually reach an end node, or the run would never complete and the
  // seeder would wait its whole timeout out.
  const draft = workflowDraft();
  assert.ok(draft.nodes.some((n) => n.kind === "end"));
  assert.ok(draft.edges.some((e) => e.sourcePort === "submitted" && e.target === "end"));
});

test("cost exports stamp nanosecond timestamps as digit strings, never floats", () => {
  // The trap this pins: `usage_ledger.window_end_ns` is TEXT because timeUnixNano (~1.78e18)
  // is past Number.MAX_SAFE_INTEGER. A number here stringifies to "1.785e+21" and
  // `nanoString` (which demands /^\d+$/) drops the datapoint - a silently empty cost chip.
  const nowMs = 1_785_000_000_000;
  const exports = costExports({ nowMs, sessionIds: ["sess-a"], days: 2 });
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

test("cost exports attribute today to live cards and backdate the rest", () => {
  const nowMs = 1_785_000_000_000;
  const days = 3;
  const exports = costExports({ nowMs, sessionIds: ["sess-a", "sess-b"], days });
  const rows = exports.flatMap((body) =>
    body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.flatMap((m) =>
      m.sum.dataPoints.map((dp) => ({
        sessionId: dp.attributes.find((a) => a.key === "session.id")!.value.stringValue,
        atMs: Number(BigInt(dp.timeUnixNano) / 1_000_000n),
      })),
    ),
  );

  // The live ids carry today's spend, so the chip and the per-card figure agree.
  for (const id of ["sess-a", "sess-b"]) {
    const mine = rows.filter((r) => r.sessionId === id);
    assert.ok(mine.length > 0, `${id} should carry some of today's spend`);
    for (const row of mine) assert.ok(row.atMs <= nowMs && row.atMs > nowMs - 3_600_000);
  }

  // History is NOT attributed to a card: a session that ran three days ago has none today,
  // and claiming one would be the single dishonest row in the seed.
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
