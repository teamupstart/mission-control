import { after, beforeEach, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Persona } from "../src/shared/workflow.ts";
import type { ResidentProfile } from "../src/shared/residents.ts";
import type { ServerEvent } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

// Resident profiles: the section registry and its defaults, compare-and-set revisions,
// archive, the HTTP routes and their SSE frames, and the refusal of `resident` on every task
// creation path except the resident launch.

const home = mkdtempSync(join(tmpdir(), "mission-residents-profiles-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const {
  MANUAL_DISPATCH_TASK_CREATE,
  RESIDENT_LAUNCH_TASK_CREATE,
  TaskKindBacklogError,
  TaskManager,
} = await import("./helpers/task-manager-fixture.ts");
const { ResidentManager } = await import("../src/server/residents/manager.ts");
const store = await import("../src/server/residents/store.ts");
const { buildApp } = await import("../src/server/routes.ts");
const {
  CreateScheduleSchema,
  DispatchSchema,
  UpdateTaskSchema,
  BulkUpdateTasksSchema,
  McpCreateTaskV3Schema,
  CreateResidentProfileSchema,
} = await import("../src/shared/protocol.ts");
const { TaskSourceDefaultsSchema } = await import("../src/shared/task-source.ts");
const { RESIDENT_TASK_REFUSAL } = await import("../src/shared/task.ts");
const {
  RESIDENT_LIMITS,
  RESIDENT_PROFILE_SECTION_IDS,
  ResidentProfileRevisionSchema,
} = await import("../src/shared/residents.ts");

type ReviewManager = import("../src/server/reviews.ts").ReviewManager;
type QueueManager = import("../src/server/queue.ts").QueueManager;

const PERSONA: Persona = {
  id: "builtin:code-reviewer",
  name: "Code Reviewer",
  normalizedName: "code reviewer",
  description: "",
  guidanceMarkdown: "Review code.",
  runner: null,
  model: null,
  revision: 1,
  archivedAt: null,
  createdAt: 0,
  updatedAt: 0,
  provenance: null,
  builtin: true,
};

const registry = new Registry();
const tasks = new TaskManager(registry);
const residents = new ResidentManager({
  registry,
  createTask: (input, internal) => tasks.create(input, internal, RESIDENT_LAUNCH_TASK_CREATE),
  persona: (id) => (id === PERSONA.id ? PERSONA : id === "archived" ? { ...PERSONA, id, archivedAt: 1 } : null),
  resolveRepoRoot: async (path) => ({ ok: false as const, error: `not a git repository: ${path}` }),
});
const app = buildApp({
  registry,
  reviews: {} as ReviewManager,
  tasks,
  queues: {} as QueueManager,
  residents,
});
const headers = { host: "127.0.0.1:7317", "content-type": "application/json" };

let scanClock = 0;
beforeEach((t) => {
  // Route fixtures start outside the preceding test's rescan cooldown.
  scanClock += 10_000;
  assert.ok("mock" in t);
  t.mock.method(performance, "now", () => scanClock);
  openDb().exec("DELETE FROM resident_runs; DELETE FROM resident_profile_revisions; DELETE FROM resident_profiles;");
  for (const profile of registry.listResidentProfiles()) registry.removeResidentProfile(profile.id);
});

function body(name: string, over: Record<string, unknown> = {}) {
  return {
    identity: { name },
    persona: { personaId: PERSONA.id },
    ...over,
  };
}

async function request(method: string, path: string, payload?: unknown) {
  const response = await app.request(path, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

test("a revision fills every later section with its defaults and round-trips unchanged", () => {
  const parsed = ResidentProfileRevisionSchema.parse(body("Triage Bot"));
  assert.deepEqual(parsed, {
    identity: { name: "Triage Bot", description: "" },
    persona: { personaId: PERSONA.id },
    instructions: { markdown: "" },
    execution: { agent: "claude", model: null, effort: null },
    workspace: { defaultRepoRoot: null },
    board: { colorId: "cyan", label: null, pin: true },
    loop: { prompt: "Continue your standing task. Check what has changed since your last iteration, act on it, and end with a one-line status. Call `schedule_next_iteration` if you need to wake sooner or later than usual.", delaySeconds: 300, minDelaySeconds: 60, maxDelaySeconds: 3600, iterationCap: 200, spendCapUsd: 20, contextThreshold: 70, compactionFocus: "" },
    authority: { controlOtherSessions: false },
  });
  assert.deepEqual(ResidentProfileRevisionSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.deepEqual(RESIDENT_PROFILE_SECTION_IDS, ["identity", "persona", "instructions", "execution", "workspace", "board", "authority", "loop"]);
  // A stored revision from a newer build, carrying a section this build does not know, still reads.
  assert.equal(ResidentProfileRevisionSchema.safeParse({ ...parsed, marker: { color: "cyan" } }).success, true);
  // A request body may not smuggle one in.
  assert.equal(CreateResidentProfileSchema.safeParse({ settings: { ...parsed, marker: {} } }).success, false);
});

test("the execution section accepts only Claude Code and Codex, and only an effort the harness offers", () => {
  assert.equal(ResidentProfileRevisionSchema.safeParse(body("Pi", { execution: { agent: "pi" } })).success, false);
  assert.equal(ResidentProfileRevisionSchema.safeParse(body("Codex", { execution: { agent: "codex", model: "gpt-6-luna" } })).success, true);
  const unsupported = ResidentProfileRevisionSchema.safeParse(body("Max", { execution: { agent: "codex", effort: "max" } }));
  assert.equal(unsupported.success, false);
  assert.equal(ResidentProfileRevisionSchema.safeParse(body("")).success, false, "a resident needs a name");
});

test("create, compare-and-set update, and archive write immutable revisions and emit SSE frames", async () => {
  const events: ServerEvent[] = [];
  const unsubscribe = registry.subscribe((event) => {
    if (event.type === "resident_profile_upsert" || event.type === "resident_profile_remove") events.push(event);
  });
  try {
    const created = await request("POST", "/api/residents/profiles", { settings: body("Triage Bot") });
    assert.equal(created.status, 201);
    const profile = created.json as unknown as ResidentProfile;
    assert.equal(profile.revision, 1);

    const duplicate = await request("POST", "/api/residents/profiles", { settings: body("  triage   BOT ") });
    assert.equal(duplicate.status, 409, "names are unique among live profiles, after normalization");

    const updated = await request("PATCH", `/api/residents/profiles/${profile.id}`, {
      expectedRevision: 1,
      settings: body("Triage Bot", { instructions: { markdown: "Summarize blockers." } }),
    });
    assert.equal(updated.status, 200);
    assert.equal((updated.json as unknown as ResidentProfile).revision, 2);

    const stale = await request("PATCH", `/api/residents/profiles/${profile.id}`, {
      expectedRevision: 1,
      settings: body("Triage Bot", { instructions: { markdown: "A lost write." } }),
    });
    assert.equal(stale.status, 409);
    assert.equal((stale.json.profile as ResidentProfile).revision, 2, "the conflict carries the current profile");
    assert.equal(store.residentProfileRevision(profile.id, 1)?.instructions.markdown, "", "revision 1 is immutable");
    assert.equal(store.residentProfileRevision(profile.id, 2)?.instructions.markdown, "Summarize blockers.");

    const listed = await app.request("/api/residents/profiles", { headers });
    assert.deepEqual(((await listed.json()) as ResidentProfile[]).map((p) => p.revision), [2]);

    const archived = await request("DELETE", `/api/residents/profiles/${profile.id}`, { expectedRevision: 2 });
    assert.equal(archived.status, 200);
    assert.notEqual((archived.json as unknown as ResidentProfile).archivedAt, null);
    assert.equal(registry.listResidentProfiles().length, 0);
    const again = await request("DELETE", `/api/residents/profiles/${profile.id}`, { expectedRevision: 2 });
    assert.equal(again.status, 200, "archive is idempotent");

    const reused = await request("POST", "/api/residents/profiles", { settings: body("Triage Bot") });
    assert.equal(reused.status, 201, "archiving a profile frees its name");

    assert.deepEqual(events.map((event) => event.type), [
      "resident_profile_upsert",
      "resident_profile_upsert",
      "resident_profile_remove",
      "resident_profile_upsert",
    ]);
    assert.deepEqual(registry.snapshot().residentProfiles.map((p) => p.name), ["Triage Bot"]);
  } finally {
    unsubscribe();
  }
});

test("saving refuses a missing or archived Persona, and the routes refuse malformed bodies", async () => {
  assert.equal((await request("POST", "/api/residents/profiles", { settings: { identity: { name: "X" }, persona: { personaId: "nope" } } })).status, 400);
  assert.equal((await request("POST", "/api/residents/profiles", { settings: { identity: { name: "X" }, persona: { personaId: "archived" } } })).status, 400);
  assert.equal((await request("POST", "/api/residents/profiles", { settings: body("X"), extra: true })).status, 400);
  assert.equal((await request("PATCH", "/api/residents/profiles/missing", { expectedRevision: 1, settings: body("X") })).status, 404);
  assert.equal((await request("POST", "/api/residents/profiles/missing/launch", { repoRoot: "/r" })).status, 400, "requestId is required");
  assert.equal((await request("POST", "/api/residents/profiles/missing/launch", { repoRoot: "/r", requestId: "a" })).status, 400, "an unresolvable repository is refused before the profile is read");
});

test("the live profile collection is bounded: creation past the limit is refused, never truncated", () => {
  const at = Date.now();
  const db = openDb();
  const insert = db.prepare(`INSERT INTO resident_profiles (id, name, normalized_name, revision, archived_at, created_at, updated_at) VALUES (?, ?, ?, 1, NULL, ?, ?)`);
  const revision = db.prepare(`INSERT INTO resident_profile_revisions (profile_id, revision, settings_json, created_at) VALUES (?, 1, ?, ?)`);
  for (let i = 0; i < RESIDENT_LIMITS.liveProfiles; i += 1) {
    insert.run(`bulk-${i}`, `Bulk ${i}`, `bulk ${i}`, at, at);
    revision.run(`bulk-${i}`, JSON.stringify(ResidentProfileRevisionSchema.parse(body(`Bulk ${i}`))), at);
  }
  const refused = residents.createProfile(ResidentProfileRevisionSchema.parse(body("One too many")));
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.status, 409);
  assert.equal(store.listLiveResidentProfiles().length, RESIDENT_LIMITS.liveProfiles);
});

test("resident is refused on every task creation path except the resident launch", async () => {
  const input = {
    repoRoot: "/repo",
    intent: "Begin your standing task.",
    title: "Triage Bot",
    kind: "resident" as const,
    agent: "claude" as const,
    workflowId: null,
    backlog: false,
  };
  const dispatched = DispatchSchema.safeParse(input);
  assert.equal(dispatched.success, false);
  assert.equal(dispatched.error?.issues[0]?.message, RESIDENT_TASK_REFUSAL);
  assert.equal(UpdateTaskSchema.safeParse({ kind: "resident" }).success, false);
  assert.equal(BulkUpdateTasksSchema.safeParse({ taskIds: ["a"], set: { kind: "resident" } }).success, false);
  assert.equal(TaskSourceDefaultsSchema.safeParse({ kind: "resident" }).success, false);
  assert.equal(McpCreateTaskV3Schema.safeParse({
    env: {}, cwd: "/repo", repoRoot: "/repo", title: "t", intent: "i", kind: "resident",
  }).success, false);
  assert.equal(CreateScheduleSchema.safeParse({
    name: "Resident", expression: "0 9 * * *", timezone: "UTC",
    overlapPolicy: "skip-active", missedPolicy: "coalesce-latest",
    template: { title: "t", intent: "i", repoRoot: "/repo", kind: "resident", agent: "claude", priority: null, labels: [], model: null, effort: null },
  }).success, false);

  for (const [label, create] of [
    ["no capability", () => tasks.create(input)],
    ["manual dispatch", () => tasks.create(input, undefined, MANUAL_DISPATCH_TASK_CREATE)],
    ["resident capability without a reserved run", () => tasks.create(input, undefined, RESIDENT_LAUNCH_TASK_CREATE)],
    ["a schedule id", () => tasks.create({ ...input, backlog: true }, { id: "r1" }, RESIDENT_LAUNCH_TASK_CREATE)],
  ] as const) {
    assert.throws(create, (error) => {
      assert.ok(error instanceof TaskKindBacklogError, label);
      return true;
    });
  }
  assert.throws(
    () => tasks.create({ ...input, kind: "ship", backlog: true }, { id: "r2", resident: { runId: "run" } }),
    TaskKindBacklogError,
    "a resident reservation cannot file another kind",
  );
  assert.equal(registry.listTasks().some((task) => task.kind === "resident"), false);

  // A resident row can never be retried, requeued or assigned outside its profile.
  registry.upsertTask(mkTask({ id: "resident-failed", kind: "resident", status: "failed", worktreePath: null }));
  const retried = await tasks.dispatch("resident-failed");
  assert.equal(retried.ok, false);
  if (!retried.ok) assert.equal(retried.error, RESIDENT_TASK_REFUSAL);
  assert.equal((await tasks.reschedule("resident-failed")).error, RESIDENT_TASK_REFUSAL);
});

test("a section or field written by a newer build survives this build reading, editing and re-saving the profile", async () => {
  const created = await request("POST", "/api/residents/profiles", { settings: body("Forward Compat") });
  assert.equal(created.status, 201);
  const profile = created.json as unknown as ResidentProfile;
  // What a newer build would have written: a whole section, and a field inside a known section.
  const newer = {
    ...ResidentProfileRevisionSchema.parse(body("Forward Compat")),
    marker: { color: "cyan", label: "FWD" },
    execution: { agent: "claude", model: null, effort: null, loopHint: 5 },
  };
  openDb().prepare("UPDATE resident_profile_revisions SET settings_json = ? WHERE profile_id = ? AND revision = 1")
    .run(JSON.stringify(newer), profile.id);

  // Read: this build parses what it knows and keeps the profile readable.
  const read = store.getResidentProfile(profile.id)!;
  assert.equal(read.settings.execution.agent, "claude");
  assert.equal((read.settings as Record<string, unknown>).marker, undefined, "the typed view holds only known sections");

  // A request body is still strictly validated: it cannot smuggle a section in itself.
  const smuggled = await request("PATCH", `/api/residents/profiles/${profile.id}`, {
    expectedRevision: 1,
    settings: { ...body("Forward Compat"), marker: { color: "red" } },
  });
  assert.equal(smuggled.status, 400);

  // Save: an edit through the route carries the unknown section and field forward.
  const saved = await request("PATCH", `/api/residents/profiles/${profile.id}`, {
    expectedRevision: 1,
    settings: body("Forward Compat", { instructions: { markdown: "Edited here." }, execution: { agent: "codex", model: "gpt-6-luna" } }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const stored = store.storedResidentSettings(profile.id, 2)!;
  assert.deepEqual(stored.marker, { color: "cyan", label: "FWD" });
  assert.deepEqual(stored.execution, { agent: "codex", model: "gpt-6-luna", effort: null, loopHint: 5 }, "known values from the request, unknown kept");
  assert.deepEqual(stored.instructions, { markdown: "Edited here." });
  // And the revision it replaced is untouched.
  assert.deepEqual(store.storedResidentSettings(profile.id, 1)!.marker, { color: "cyan", label: "FWD" });
});

test("skill source routes validate registrations, rescan on demand, and keep the index out of SSE", async () => {
  const path = join(home, "http-skills");
  mkdirSync(join(path, "fixture"), { recursive: true });
  writeFileSync(join(path, "fixture/SKILL.md"), "---\nname: route-fixture\ndescription: fixture\n---\n");
  const config = { directories: [{ id: "custom-00000000-0000-0000-0000-000000000001", path }] };
  const events: ServerEvent[] = [];
  const off = registry.subscribe((event) => events.push(event));
  try {
    const expectedRevision = (await request("GET", "/api/residents/skills")).json.configRevision;
    assert.equal((await request("PUT", "/api/residents/skill-sources", { expectedRevision, config: { directories: [{ ...config.directories[0], path: "relative" }] } })).status, 400);
    assert.equal((await request("PUT", "/api/residents/skill-sources", { expectedRevision, config })).status, 200);
    const read = await request("GET", "/api/residents/skills");
    assert.equal(read.status, 200);
    assert.ok((read.json.skills as Array<{ name: string }>).some((skill) => skill.name === "route-fixture"));
    assert.equal((await request("POST", "/api/residents/skills/rescan", { unexpected: true })).status, 400);
    assert.equal((await request("POST", "/api/residents/skills/rescan", {})).status, 200);
    assert.deepEqual(events, []);
  } finally { off(); }
});

test("skill source writes reject stale adds and removals without losing another window's changes", async () => {
  const endpoint = "/api/residents/skill-sources";
  const first = (await request("GET", "/api/residents/skills")).json;
  const original = first.config as { directories: Array<{ id: string; path: string }> };
  const added = { id: "custom-00000000-0000-0000-0000-000000000002", path: join(home, "another-window") };
  const config = { directories: [...original.directories, added] };
  const saved = await request("PUT", endpoint, { config, expectedRevision: first.configRevision });
  assert.equal(saved.status, 200);
  for (const stale of [original, { directories: [] }]) {
    const refused = await request("PUT", endpoint, { config: stale, expectedRevision: first.configRevision });
    assert.equal(refused.status, 409);
    assert.match(String(refused.json.error), /another window/);
    assert.deepEqual((await request("GET", "/api/residents/skills")).json.config, config);
  }
  assert.equal((await request("PUT", endpoint, { config: original })).status, 400, "writes require a comparison token");
  assert.equal((await request("PUT", endpoint, { config: original, expectedRevision: saved.json.configRevision })).status, 200);
});

function countSkillConfigReads(t: TestContext): () => number {
  const db = openDb();
  const prepare = db.prepare.bind(db);
  let configReads = 0;
  t.mock.method(db, "prepare", (sql: string) => {
    const statement = prepare(sql);
    if (sql === "SELECT value FROM app_config WHERE key = ?") {
      const get = statement.get.bind(statement);
      t.mock.method(statement, "get", (key: string) => {
        if (key === "residents.skillSources") configReads++;
        return get(key);
      });
    }
    return statement;
  });
  return () => configReads;
}

test("skill rescans refuse browser simple requests and untrusted origins before reading the catalog", async (t) => {
  const configReads = countSkillConfigReads(t);
  for (const overrides of [
    { "content-type": "text/plain", origin: "http://127.0.0.1:9999" },
    { "content-type": "application/x-www-form-urlencoded", origin: "https://example.com" },
    { "content-type": "application/json", origin: "https://example.com" },
    { "content-type": "application/json", origin: "null" },
  ]) {
    const response = await app.request("/api/residents/skills/rescan", { method: "POST", headers: { ...headers, ...overrides }, body: "{}" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  }
  assert.equal(configReads(), 0, "refused requests never reach the catalog");
  const preflight = await app.request("/api/residents/skills/rescan", { method: "OPTIONS", headers: {
    host: headers.host, origin: "http://127.0.0.1:9999", "access-control-request-method": "POST", "access-control-request-headers": "content-type",
  } });
  assert.equal(preflight.headers.get("access-control-allow-origin"), null, "another loopback website cannot preflight a JSON scan");
  const validOrigins: Array<Record<string, string>> = [{}, { origin: "http://127.0.0.1:7317" }, { origin: "http://localhost:5173" }];
  for (const extra of validOrigins) {
    scanClock += 1_000;
    const response = await app.request("/api/residents/skills/rescan", { method: "POST", headers: { ...headers, ...extra }, body: "{}" });
    assert.equal(response.status, 200, "dashboard, dev proxy and local API JSON requests remain supported");
  }
});

test("all local clients share the rescan cooldown and can retry at its boundary", async (t) => {
  const reads = countSkillConfigReads(t);
  const rescan = () => app.request("/api/residents/skills/rescan", { method: "POST", headers, body: "{}" });
  assert.equal((await rescan()).status, 200);
  const afterScan = reads();
  scanClock += 999;
  for (const response of await Promise.all([rescan(), rescan()])) {
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.match((await response.json() as { error: string }).error, /Wait a second/);
  }
  assert.equal(reads(), afterScan, "rejected requests do not reach the catalog");
  scanClock += 1;
  assert.equal((await rescan()).status, 200);
  assert.equal(reads(), afterScan + 1);
});

test("skill-source validation returns 400 while storage failures stay server errors", async (t) => {
  const expectedRevision = (await request("GET", "/api/residents/skills")).json.configRevision;
  const { homedir } = await import("node:os");
  const predefined = await request("PUT", "/api/residents/skill-sources", { expectedRevision, config: {
    directories: [{ id: "custom-00000000-0000-0000-0000-000000000003", path: join(homedir(), ".agents/skills") }],
  } });
  assert.equal(predefined.status, 400);
  assert.match(String(predefined.json.error), /predefined/);
  const db = openDb();
  const prepare = db.prepare.bind(db);
  t.mock.method(db, "prepare", (sql: string) => {
    if (/INSERT INTO app_config/.test(sql)) throw new Error("private-storage-fault");
    return prepare(sql);
  });
  t.mock.method(console, "error", () => {});
  const response = await app.request("/api/residents/skill-sources", { method: "PUT", headers,
    body: JSON.stringify({ expectedRevision, config: { directories: [] } }),
  });
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes("private-storage-fault"));
});

test("malformed stored sources keep global skills readable and require the current revision to repair", async () => {
  const db = openDb();
  const key = "residents.skillSources";
  const original = db.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as { value: string } | undefined;
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(home, "recovery-codex");
  mkdirSync(join(process.env.CODEX_HOME, "skills/recovery"), { recursive: true });
  writeFileSync(join(process.env.CODEX_HOME, "skills/recovery/SKILL.md"), "---\nname: recovery-global\ndescription: fixture\n---\n");
  const seed = (value: unknown) => db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  const stored = () => (db.prepare("SELECT value FROM app_config WHERE key = ?").get(key) as { value: string }).value;
  try {
    seed({ directories: "invalid" });
    const read = await request("GET", "/api/residents/skills");
    assert.equal(read.status, 200);
    assert.match(String(read.json.configurationProblem), /invalid/);
    assert.deepEqual(read.json.config, { directories: [] });
    assert.ok((read.json.skills as Array<{ name: string }>).some(skill => skill.name === "recovery-global"));
    assert.equal((await request("POST", "/api/residents/skills/rescan", {})).status, 200);
    assert.equal(stored(), '{"directories":"invalid"}', "reads and rescans preserve the stored value");
    seed({ directories: ["also-invalid"] });
    const changed = await request("GET", "/api/residents/skills");
    assert.notEqual(changed.json.configRevision, read.json.configRevision, "invalid values have distinct revisions despite the same fallback");
    assert.equal((await request("PUT", "/api/residents/skill-sources", { expectedRevision: read.json.configRevision, config: { directories: [] } })).status, 409);
    assert.equal(stored(), '{"directories":["also-invalid"]}');
    const repaired = await request("PUT", "/api/residents/skill-sources", { expectedRevision: changed.json.configRevision, config: { directories: [] } });
    assert.equal(repaired.status, 200);
    assert.equal(repaired.json.configurationProblem, null);
    assert.equal(stored(), '{"directories":[]}');
    assert.equal((await request("GET", "/api/residents/skills")).json.configurationProblem, null);
  } finally {
    if (codexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = codexHome;
    if (original) db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)").run(key, original.value);
    else db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
  }
});
