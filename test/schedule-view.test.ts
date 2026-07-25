import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  availableTimezones,
  cadenceLabel,
  delayIsLate,
  expressionToForm,
  formatDelay,
  occurrenceStatusView,
  presetToExpression,
  scheduleDefinitionFingerprint,
  scheduleMatchesFilter,
  scheduleMatchesQuery,
  shortRepo,
  sortSchedulesForCatalog,
  triggerKindLabel,
  type CadenceForm,
} from "../src/web/lib/schedules.ts";
import { mkSchedule, mkScheduleTemplate } from "./helpers/schedule-fixture.ts";

/**
 * The Scheduled Catalog's presentation helpers, and the boundary they must not cross.
 *
 * These decide how a daemon-computed answer is SPELLED - a cadence label, a delay, a
 * status tone, a search match - and nothing about WHEN anything runs. The recurrence math,
 * DST, missed policy and health thresholds are all server-owned; a bug in here is cosmetic,
 * so the tests pin the spelling and the append-only fallbacks, not scheduling behaviour.
 * The last test is the load-bearing one: it proves this module never fetches the catalog.
 */

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/web");

test("cadence labels read the shapes the presets produce, and pass everything else through", () => {
  assert.equal(cadenceLabel("0 8 * * 1"), "Mondays · 8:00 AM");
  assert.equal(cadenceLabel("30 7 * * 1-5"), "Weekdays · 7:30 AM");
  assert.equal(cadenceLabel("0 0 * * *"), "Daily · 12:00 AM");
  assert.equal(cadenceLabel("0 12 1 * *"), "Monthly on the 1st · 12:00 PM");
  // An expression it does not recognise is handed back verbatim, never guessed at.
  assert.equal(cadenceLabel("*/5 9-17 * * 1,3,5"), "*/5 9-17 * * 1,3,5");
});

test("presets and expressions round-trip so the editor reopens on the right controls", () => {
  const forms: CadenceForm[] = [
    { preset: "daily", weekday: 1, monthday: 1, time: "09:15", expression: "" },
    { preset: "weekdays", weekday: 1, monthday: 1, time: "07:30", expression: "" },
    { preset: "weekly", weekday: 4, monthday: 1, time: "08:00", expression: "" },
    { preset: "monthly", weekday: 1, monthday: 15, time: "06:00", expression: "" },
  ];
  for (const form of forms) {
    const expression = presetToExpression(form);
    const recovered = expressionToForm(expression);
    assert.equal(recovered.preset, form.preset, `preset for ${expression}`);
    assert.equal(presetToExpression(recovered), expression, `re-expression for ${expression}`);
  }
  // Advanced passes its raw string straight through, normalized.
  assert.equal(
    presetToExpression({ preset: "advanced", weekday: 1, monthday: 1, time: "08:00", expression: "*/10 * * * *" }),
    "*/10 * * * *",
  );
  assert.equal(expressionToForm("*/10 * * * *").preset, "advanced");
  assert.equal(
    presetToExpression({ preset: "daily", weekday: 1, monthday: 1, time: "", expression: "" }),
    "",
  );
  assert.equal(
    presetToExpression({ preset: "daily", weekday: 1, monthday: 1, time: "25:00", expression: "" }),
    "",
  );
});

test("the timezone list always contains UTC", () => {
  assert.ok(availableTimezones().includes("UTC"));
});

test("a delay under a minute reads as on time; anything more is spelled and flagged", () => {
  assert.equal(formatDelay(0), "on time");
  assert.equal(formatDelay(30_000), "on time");
  assert.equal(delayIsLate(30_000), false);
  assert.equal(formatDelay(2 * 60 * 60 * 1000 + 14 * 60 * 1000), "2h 14m late");
  assert.equal(delayIsLate(2 * 60 * 60 * 1000), true);
  assert.match(formatDelay(9 * 24 * 60 * 60 * 1000), /9d/);
});

test("an occurrence status this build cannot read is an explicit unknown, never a nearest match", () => {
  assert.equal(occurrenceStatusView("created").tone, "healthy");
  assert.equal(occurrenceStatusView("failed").tone, "attention");
  assert.equal(occurrenceStatusView("skipped_overlap").label, "Skipped (active)");
  const unknown = occurrenceStatusView(null);
  assert.equal(unknown.label, "Unknown");
  assert.equal(unknown.tone, "attention");
});

test("trigger labels distinguish scheduled from manual, and refuse to guess an unknown", () => {
  assert.equal(triggerKindLabel("scheduled"), "Scheduled");
  assert.equal(triggerKindLabel("manual"), "Run now");
  assert.equal(triggerKindLabel(null), "-");
});

test("search matches name, title, repo, agent and labels; filter reads server health", () => {
  const schedule = mkSchedule({
    name: "Dependency audit",
    template: mkScheduleTemplate({ title: "Update packages", labels: ["maintenance"], agent: "codex" }),
  });
  assert.equal(scheduleMatchesQuery(schedule, ""), true);
  assert.equal(scheduleMatchesQuery(schedule, "depend"), true);
  assert.equal(scheduleMatchesQuery(schedule, "packages"), true);
  assert.equal(scheduleMatchesQuery(schedule, "codex"), true);
  assert.equal(scheduleMatchesQuery(schedule, "maintenance"), true);
  assert.equal(scheduleMatchesQuery(schedule, "nothing-here"), false);

  assert.equal(scheduleMatchesFilter(schedule, "all"), true);
  assert.equal(scheduleMatchesFilter(schedule, "healthy"), true);
  assert.equal(scheduleMatchesFilter({ ...schedule, health: "attention" }, "attention"), true);
  assert.equal(scheduleMatchesFilter(schedule, "attention"), false);
});

test("the catalog sorts attention first, then healthy, then paused", () => {
  const sorted = sortSchedulesForCatalog([
    mkSchedule({ id: "p", name: "Paused one", health: "paused" }),
    mkSchedule({ id: "h", name: "Healthy one", health: "healthy" }),
    mkSchedule({ id: "a", name: "Attention one", health: "attention" }),
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ["a", "h", "p"]);
});

test("shortRepo keeps the last path segment for the catalog's tight columns", () => {
  assert.equal(shortRepo("/Users/dev/workspace/mission-control"), "mission-control");
  assert.equal(shortRepo("/Users/dev/workspace/mission-control/"), "mission-control");
  assert.equal(shortRepo(null), "-");
});

test("the definition fingerprint changes when the saved definition changes", () => {
  const base = {
    name: "n",
    expression: "0 8 * * 1",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: {
      title: "t",
      intent: "i",
      repoRoot: "/repo",
      kind: "ship",
      agent: "claude",
      priority: null,
      labels: [],
      model: null,
      effort: null,
    },
  };
  const a = scheduleDefinitionFingerprint(base);
  // Whitespace-only difference in the expression is the SAME schedule.
  assert.equal(a, scheduleDefinitionFingerprint({ ...base, expression: "0  8 * * 1" }));
  // A real cadence change is a different fingerprint - the Save & enable gate depends on it.
  assert.notEqual(a, scheduleDefinitionFingerprint({ ...base, expression: "0 9 * * 1" }));
  assert.notEqual(a, scheduleDefinitionFingerprint({ ...base, timezone: "America/New_York" }));
  assert.notEqual(a, scheduleDefinitionFingerprint({ ...base, name: "renamed" }));
  assert.notEqual(
    a,
    scheduleDefinitionFingerprint({
      ...base,
      template: { ...base.template, priority: "high" },
    }),
  );
  assert.notEqual(
    a,
    scheduleDefinitionFingerprint({
      ...base,
      template: { ...base.template, labels: ["scheduled"] },
    }),
  );
  assert.notEqual(
    a,
    scheduleDefinitionFingerprint({
      ...base,
      template: { ...base.template, model: "claude-sonnet" },
    }),
  );
  assert.notEqual(
    a,
    scheduleDefinitionFingerprint({
      ...base,
      template: { ...base.template, effort: "high" },
    }),
  );
});

test("the schedule view module never fetches the catalog - it is SSE-owned", () => {
  // The live catalog arrives over the EventSource; a fetch of /api/schedules here would be
  // a poll the plan forbids. History is the one on-demand read, and it lives in api.ts.
  const source = readFileSync(path.join(WEB, "lib/schedules.ts"), "utf8");
  assert.doesNotMatch(source, /\/api\/schedules/, "lib/schedules must not call any schedule route");
  assert.doesNotMatch(source, /\bfetch\(/, "lib/schedules must do no fetching");
});
