import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ArchiveScheduleSchema,
  CreateScheduleSchema,
  RunScheduleNowSchema,
  ScheduleHistoryQuerySchema,
  SchedulePreviewSchema,
  SetScheduleEnabledSchema,
} from "../src/shared/protocol.ts";

// What is at stake: these schemas are the SHAPE gate every schedule mutation passes through,
// and the split with the Phase 2 service is deliberate - the schema refuses what is wrong
// about the REQUEST (a four-field cron, an execution mode this build cannot honour, a runner
// id V1 does not accept, a standby window that runs backwards) while the service refuses what
// is wrong about the CADENCE (a bad IANA zone, a sub-hour interval). A schema that let a
// six-field seconds expression through would schedule a mission every second under a string
// the operator read as a minute; a schema the preview did not share would let the browser
// preview a value the save route then rejects. Both are pinned here, with no database.

function definition(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Nightly sweep",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: {
      title: "Sweep the inbox",
      intent: "Read the inbox and file whatever needs filing.",
      repoRoot: "/repos/main",
      kind: "ship",
      agent: "claude",
      priority: null,
      labels: [],
      model: null,
      effort: null,
    },
    ...over,
  };
}

function template(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(definition().template as Record<string, unknown>), ...over };
}

test("a valid definition parses and fills the V1-pinned defaults", () => {
  const parsed = CreateScheduleSchema.safeParse(definition());
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  // V1 pins these regardless of what the caller sent.
  assert.equal(parsed.data.executionMode, "local-catchup");
  assert.equal(parsed.data.runnerId, null);
  // Enabled defaults to true - save paused sends false explicitly.
  assert.equal(parsed.data.enabled, true);
});

test("the cron expression must have exactly five fields", () => {
  assert.equal(CreateScheduleSchema.safeParse(definition({ expression: "0 9 * *" })).success, false);
  assert.equal(CreateScheduleSchema.safeParse(definition({ expression: "0 9 * * * *" })).success, false);
  // Seconds syntax (six fields) is refused before the parser ever sees it.
  assert.equal(CreateScheduleSchema.safeParse(definition({ expression: "*/1 * * * * *" })).success, false);
  assert.equal(CreateScheduleSchema.safeParse(definition({ expression: "0 9 * * *" })).success, true);
  // Whitespace is normalized before counting, so extra spaces still read as five fields.
  assert.equal(CreateScheduleSchema.safeParse(definition({ expression: "0   9 * * *" })).success, true);
});

test("name, title, and intent are required and trimmed", () => {
  assert.equal(CreateScheduleSchema.safeParse(definition({ name: "   " })).success, false);
  assert.equal(CreateScheduleSchema.safeParse(definition({ template: template({ title: "  " }) })).success, false);
  assert.equal(CreateScheduleSchema.safeParse(definition({ template: template({ intent: "" }) })).success, false);
});

test("V1 refuses a non-local execution mode and a non-null runner id", () => {
  assert.equal(CreateScheduleSchema.safeParse(definition({ executionMode: "os-wake" })).success, false);
  assert.equal(CreateScheduleSchema.safeParse(definition({ executionMode: "remote-runner" })).success, false);
  assert.equal(CreateScheduleSchema.safeParse(definition({ runnerId: "home-server" })).success, false);
  // Omitting them is fine - the defaults apply.
  const parsed = CreateScheduleSchema.safeParse({ ...definition(), executionMode: undefined, runnerId: undefined });
  assert.equal(parsed.success, true);
});

test("the template normalizes labels and refuses an effort the harness cannot do", () => {
  const parsed = CreateScheduleSchema.safeParse(
    definition({ template: template({ labels: ["  API ", "api", "backend"] }) }),
  );
  assert.equal(parsed.success, true);
  // Trimmed, deduped case-insensitively (first spelling wins) - the shared normalizer.
  if (parsed.success) assert.deepEqual(parsed.data.template.labels, ["API", "backend"]);
  // Codex does not offer "max" reasoning effort; the refine attaches to the effort field.
  const bad = CreateScheduleSchema.safeParse(definition({ template: template({ agent: "codex", effort: "max" }) }));
  assert.equal(bad.success, false);
  if (!bad.success) assert.ok(bad.error.issues.some((i) => i.path.includes("effort")));
});

test("preview accepts the save definition plus its own bounded knobs", () => {
  // Same definition the save route takes.
  assert.equal(SchedulePreviewSchema.safeParse(definition()).success, true);
  // Count is bounded to 10-50.
  assert.equal(SchedulePreviewSchema.safeParse(definition({ count: 5 })).success, false);
  assert.equal(SchedulePreviewSchema.safeParse(definition({ count: 51 })).success, false);
  assert.equal(SchedulePreviewSchema.safeParse(definition({ count: 25 })).success, true);
});

test("the standby simulation is both-or-neither and ordered", () => {
  assert.equal(SchedulePreviewSchema.safeParse(definition({ sleepStartedAt: 1000 })).success, false);
  assert.equal(SchedulePreviewSchema.safeParse(definition({ resumedAt: 1000 })).success, false);
  assert.equal(SchedulePreviewSchema.safeParse(definition({ sleepStartedAt: 2000, resumedAt: 1000 })).success, false);
  assert.equal(SchedulePreviewSchema.safeParse(definition({ sleepStartedAt: 1000, resumedAt: 2000 })).success, true);
});

test("set-enabled needs a boolean; run-now and archive reject a stray key", () => {
  assert.equal(SetScheduleEnabledSchema.safeParse({}).success, false);
  assert.equal(SetScheduleEnabledSchema.safeParse({ enabled: "yes" }).success, false);
  assert.equal(SetScheduleEnabledSchema.safeParse({ enabled: true }).success, true);
  // Bodyless actions accept exactly the empty object and nothing more.
  assert.equal(RunScheduleNowSchema.safeParse({}).success, true);
  assert.equal(RunScheduleNowSchema.safeParse({ force: true }).success, false);
  assert.equal(ArchiveScheduleSchema.safeParse({}).success, true);
  assert.equal(ArchiveScheduleSchema.safeParse({ hard: true }).success, false);
});

test("history cursor and limit are validated, not silently coerced past their bounds", () => {
  // An absent query is fine (defaults live in the route).
  assert.equal(ScheduleHistoryQuerySchema.safeParse({}).success, true);
  // A numeric-string cursor coerces; a non-numeric one is refused.
  const good = ScheduleHistoryQuerySchema.safeParse({ before: "1721721600000", limit: "25" });
  assert.equal(good.success, true);
  if (good.success) assert.equal(good.data.before, 1721721600000);
  assert.equal(ScheduleHistoryQuerySchema.safeParse({ before: "abc" }).success, false);
  assert.equal(ScheduleHistoryQuerySchema.safeParse({ limit: "0" }).success, false);
  assert.equal(ScheduleHistoryQuerySchema.safeParse({ limit: "1000" }).success, false);
});
