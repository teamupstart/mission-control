import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskCandidate, TaskSourceInstance } from "../src/shared/task-source.ts";

// The two DURABLE task creators, against a real database and a real `TaskManager`.
//
// The goal this phase answers is "the choice reaches every path that creates or launches a
// task, not just the dispatch form", and these two are the paths that file work while nobody
// is watching: a Recurring Mission's due instant, and a task source's sweep. Both used to
// carry `agent: "claude"` from a schema default, which is not a value an operator ever chose -
// it is the absence of a choice, spelled as a pin. A pin is exactly what the kind default is
// forbidden to override, so the two creators that most need a default were the two it could
// never reach.
//
// What is under test is therefore not "does null round-trip" but the consequence:
//
//   - A mission written before the kind was repointed files on the kind's CURRENT agent,
//     because the row is read when the run fires, not when the mission was saved.
//   - A mission or source that NAMES an agent keeps it, whatever the kind says. Choosing is
//     still choosing.
//   - A stored template that already names one is untouched by this change, so nothing
//     already scheduled quietly moves harness on upgrade.
//   - An inheriting template cannot pin a model, for the reason a kind row cannot: a model id
//     belongs to one harness, and the harness is not known until the run fires.

const home = mkdtempSync(join(tmpdir(), "mission-kind-creators-"));
process.env.MISSION_HOME = home;

const db = await import("../src/server/db.ts");
const store = await import("../src/server/schedules/store.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ScheduleManager } = await import("../src/server/schedules/manager.ts");
const { ingestSweep } = await import("../src/server/task-sources/ingest.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { UpdateScheduleSchema: ScheduleDefinitionSchema } = await import("@shared/protocol.ts");
const { TaskSourceDefaultsSchema } = await import("@shared/task-source.ts");
type CreateScheduleInput = import("../src/server/schedules/manager.ts").CreateScheduleInput;

after(() => rmSync(home, { recursive: true, force: true }));

db.openDb();
const registry = new Registry();
const tasks = new TaskManager(registry);

const REPO = "/repos/main";
const T0 = Date.parse("2026-07-23T08:00:00Z");
const NINE = Date.parse("2026-07-23T09:00:00Z");
const DAY = 24 * 3600_000;

beforeEach(() => {
  db.openDb().exec("DELETE FROM app_config; DELETE FROM tasks; DELETE FROM task_source_seen;");
});

function harness(label: string) {
  for (const existing of store.listSchedules()) store.archiveSchedule(existing.id, T0 - 1);
  const clock = { now: T0 };
  let n = 0;
  const manager = new ScheduleManager({
    tasks,
    now: () => clock.now,
    uuid: () => `${label}-${++n}`,
    resolveRepoRoot: async (path: string) => ({ ok: true as const, repoRoot: path }),
    notifier: { upsert: () => {}, remove: () => {} },
    log: () => {},
  });
  return { manager, clock };
}

/** A daily 09:00 mission that inherits everything it can. */
function definition(over: Record<string, unknown> = {}): CreateScheduleInput {
  const template = {
    title: "Draft the plan",
    intent: "Read the brief and produce a reviewed plan.",
    repoRoot: REPO,
    kind: "plan" as const,
    agent: null,
    priority: null,
    labels: [],
    model: null,
    effort: null,
    ...((over.template as Record<string, unknown>) ?? {}),
  };
  return {
    name: "Nightly plan",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    completionPolicy: "manual",
    ...over,
    template,
  } as CreateScheduleInput;
}

function scheduledTasks(scheduleId: string) {
  return db.listTasks().filter((t) => t.scheduleId === scheduleId);
}

// ---- Recurring Missions ----

test("a mission that inherits its agent files on the kind's agent, read when the run fires", async () => {
  setHarnessesConfig({ kindDefaults: { plan: { agent: "codex" } } });
  const h = harness("inherit");
  // `allow`, so the second run is not skipped by the first task still sitting in the backlog:
  // what this test is about is the SECOND run's agent, not the overlap guard.
  const created = await h.manager.create(definition({ overlapPolicy: "allow" }));
  assert.ok(created.ok, JSON.stringify(created));

  h.clock.now = NINE + 5_000;
  await h.manager.tick();
  const first = scheduledTasks(created.schedule.id);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.agent, "codex", "the kind's agent reached a scheduled run");

  // The row is read at each run, not frozen into the mission when it was written. Repointing
  // the kind therefore moves the NEXT run without anyone editing the mission - which is the
  // whole point of choosing once on Settings instead of on every dispatch.
  setHarnessesConfig({ kindDefaults: { plan: { agent: "pi" } } });
  h.clock.now = NINE + DAY + 5_000;
  await h.manager.tick();
  const agents = scheduledTasks(created.schedule.id).map((t) => t.agent);
  assert.equal(agents.length, 2);
  assert.ok(agents.includes("pi"), `expected a pi run, got ${agents.join(", ")}`);
});

test("a mission that NAMES an agent keeps it, whatever the kind says", async () => {
  setHarnessesConfig({ kindDefaults: { plan: { agent: "codex" } } });
  const h = harness("pinned");
  const created = await h.manager.create(definition({ template: { agent: "pi" } }));
  assert.ok(created.ok, JSON.stringify(created));

  h.clock.now = NINE + 5_000;
  await h.manager.tick();
  const filed = scheduledTasks(created.schedule.id);
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.agent, "pi", "choosing is still choosing");
});

test("a stored template that already names an agent is read back unchanged", () => {
  // The upgrade case. Every mission written before this change carries `agent: "claude"` in
  // its revision JSON, and nullable-with-a-null-default must not rewrite those into inherits -
  // that would silently move existing scheduled work onto whatever the kind says.
  const parsed = ScheduleDefinitionSchema.parse({
    name: "Old mission",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: {
      title: "T",
      intent: "I",
      repoRoot: REPO,
      kind: "ship",
      agent: "claude",
      priority: null,
      labels: [],
      model: null,
      effort: null,
    },
  });
  assert.equal(parsed.template.agent, "claude");

  // And a template that says nothing is an inherit rather than a Claude pin.
  const fresh = ScheduleDefinitionSchema.parse({
    name: "New mission",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    template: { title: "T", intent: "I", repoRoot: REPO, kind: "ship" },
  });
  assert.equal(fresh.template.agent, null);
});

test("an inheriting template may set an effort but never a model", () => {
  const base = {
    name: "M",
    expression: "0 9 * * *",
    timezone: "UTC",
    overlapPolicy: "skip-active" as const,
    missedPolicy: "coalesce-latest" as const,
  };
  const template = { title: "T", intent: "I", repoRoot: REPO, kind: "ship" as const, agent: null };

  // A model id is agent-namespaced, so this pair could never apply to anything.
  assert.equal(
    ScheduleDefinitionSchema.safeParse({
      ...base,
      template: { ...template, model: "claude-opus-4-8" },
    }).success,
    false,
  );
  // An effort is one shared vocabulary, so it survives the harness being unknown and is
  // checked against whatever the kind resolves at launch.
  assert.equal(
    ScheduleDefinitionSchema.safeParse({ ...base, template: { ...template, effort: "high" } })
      .success,
    true,
  );
});

test("an inheriting mission cannot file a task at an effort its kind's harness lacks", async () => {
  // The hole this closes: the mission names no agent, so nothing checked its effort when it
  // was written - and the task row it files is a PIN, which the launch ladder used to pass
  // through unchecked. `max` is a level Codex does not offer AT ALL, so a plan kind pointed at
  // Codex must not produce a task carrying it.
  setHarnessesConfig({ kindDefaults: { plan: { agent: "codex" } } });
  const h = harness("effort");
  const created = await h.manager.create(definition({ template: { effort: "max" } }));
  assert.ok(created.ok, JSON.stringify(created));

  h.clock.now = NINE + 5_000;
  await h.manager.tick();

  // Refused at creation, loudly: no task at all rather than one that launches on a flag the
  // CLI rejects. The occurrence carries the reason, which is where an operator can act on it.
  assert.deepEqual(scheduledTasks(created.schedule.id), []);
  const failed = store
    .historyPage(created.schedule.id, { before: null, limit: 10 })
    ?.occurrences.filter((o) => o.status === "failed") ?? [];
  assert.equal(failed.length, 1, "the run should fail visibly rather than file wrong work");
  assert.match(String(failed[0]?.error ?? ""), /max/);

  // The same mission on a kind whose harness DOES offer the level files normally, so this is a
  // capability check and not a ban on inheriting missions setting an effort.
  setHarnessesConfig({ kindDefaults: { plan: { agent: "claude" } } });
  h.clock.now = NINE + DAY + 5_000;
  await h.manager.tick();
  const filed = scheduledTasks(created.schedule.id);
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.effort, "max");
  assert.equal(filed[0]!.agent, "claude");
});

// ---- task sources ----

function source(over: Partial<TaskSourceInstance> = {}): TaskSourceInstance {
  return {
    id: "src-kind",
    kind: "github-issues",
    label: "issues",
    enabled: true,
    repoRoot: REPO,
    intervalMs: 900_000,
    defaults: TaskSourceDefaultsSchema.parse({ kind: "plan" }),
    maxPerSweep: 25,
    config: {},
    ...over,
  } as TaskSourceInstance;
}

function candidate(externalId: string, over: Partial<TaskCandidate> = {}): TaskCandidate {
  return {
    ref: { sourceId: "src-kind", externalId, url: `https://example.test/${externalId}` },
    title: "Fix the thing",
    intent: "it is broken",
    repoRoot: REPO,
    ...over,
  };
}

const resolveRepo = { resolveRepoRoot: async (p: string) => ({ ok: true as const, repoRoot: p }) };

test("a source left unset files on the kind's agent; one that names an agent pins it", async () => {
  setHarnessesConfig({ kindDefaults: { plan: { agent: "codex" } } });

  // An untouched source: `TaskSourceDefaultsSchema` leaves its agent null, which is the
  // absence of a choice rather than a Claude pin.
  assert.equal(source().defaults.agent, null);
  await ingestSweep(source(), { items: [candidate("owner/repo#1")], error: null }, tasks, resolveRepo);
  const inherited = db.listTasks().find((t) => t.source?.externalId === "owner/repo#1");
  assert.equal(inherited?.agent, "codex");

  // A source that names one wins, exactly as a per-task pin does.
  await ingestSweep(
    source({ id: "src-pin", defaults: TaskSourceDefaultsSchema.parse({ kind: "plan", agent: "pi" }) }),
    { items: [candidate("owner/repo#2", { ref: { sourceId: "src-pin", externalId: "owner/repo#2", url: "u" } })], error: null },
    tasks,
    resolveRepo,
  );
  const pinned = db.listTasks().find((t) => t.source?.externalId === "owner/repo#2");
  assert.equal(pinned?.agent, "pi");
});

test("a candidate's own agent still beats both the source and the kind", async () => {
  setHarnessesConfig({ kindDefaults: { plan: { agent: "codex" } } });
  await ingestSweep(
    source(),
    { items: [candidate("owner/repo#3", { agent: "claude" })], error: null },
    tasks,
    resolveRepo,
  );
  const filed = db.listTasks().find((t) => t.source?.externalId === "owner/repo#3");
  assert.equal(filed?.agent, "claude");
});
