import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WORKFLOW_CHECK_SLOTS, type CodeRabbitComparison } from "../src/shared/workflow.ts";

// What is at stake: the store is the boundary a future caller reaches WITHOUT passing the
// route schema, and what it holds is an argv the daemon spawns. So the rules that make
// resolution deterministic - one command per repository per slot, all slots always present,
// a whole-slot replacement - have to hold here and not only one layer up. And a value this
// build cannot read must degrade the FIELD holding it rather than the row or the catalog: one
// hand-edited value taking every Check node down is a worse failure than one slot reading as
// unconfigured, and one that took the row's revision with it would make the slot unrepairable.

const home = mkdtempSync(join(tmpdir(), "mission-workflow-commands-store-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore, clearWorkflowTables } = await import("../src/server/workflows/store.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

function store() {
  clearWorkflowTables(db);
  const created = new WorkflowStore(db);
  created.seedWorkflowCommands(1_000);
  return created;
}

test("only successful CodeRabbit comparisons freeze, including recovery of previously stored errors", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("CREATE TABLE workflow_submissions (id TEXT PRIMARY KEY, coderabbit_json TEXT)");
  database.prepare("INSERT INTO workflow_submissions (id) VALUES (?)").run("submission");
  const s = new WorkflowStore(database);
  const resolved: CodeRabbitComparison = {
    interpreterVersion: 1,
    yaml: { source: ".coderabbit.yaml", digest: "a".repeat(64), enabled: true, state: "enabled", diagnostic: "enabled" },
    head: "a".repeat(40), baseRef: "origin/main", baseTip: "b".repeat(40), mergeBase: "b".repeat(40),
    severity: "major", ruleRevision: 1, timeoutMs: 2_700_000, maxRuns: 10, empty: false, error: null,
  };
  const failed = { ...resolved, baseTip: null, mergeBase: null, error: "Git comparison timed out" };
  assert.deepEqual(s.freezeCodeRabbitComparison("submission", failed), failed);
  assert.equal(s.getCodeRabbitComparison("submission"), null, "failed resolution must stay retryable");
  assert.deepEqual(database.prepare("SELECT coderabbit_json FROM workflow_submissions").get()?.coderabbit_json, null);

  // Previously published builds persisted errors. They must not prevent Retry from recovering.
  database.prepare("UPDATE workflow_submissions SET coderabbit_json = ?").run(JSON.stringify(failed));
  assert.equal(s.getCodeRabbitComparison("submission"), null);
  assert.deepEqual(s.freezeCodeRabbitComparison("submission", resolved), resolved);
  const moved = { ...resolved, baseTip: "c".repeat(40), mergeBase: "c".repeat(40), maxRuns: 1 };
  assert.deepEqual(s.freezeCodeRabbitComparison("submission", moved), resolved, "first successful identity and policy stay pinned");
  assert.deepEqual(s.freezeCodeRabbitComparison("submission", failed), resolved);
  assert.deepEqual(new WorkflowStore(database).getCodeRabbitComparison("submission"), resolved, "successful pin survives reload");
  database.prepare("UPDATE workflow_submissions SET coderabbit_json = ?").run('{"corrupt":true}');
  assert.throws(() => s.getCodeRabbitComparison("submission"), "corrupt metadata must still fail closed");
});

test("seeding is idempotent and never resets a slot somebody configured", () => {
  const s = store();
  assert.equal(s.seedWorkflowCommands(2_000), false, "a seeded catalog is no longer empty");
  assert.equal(
    s.replaceWorkflowCommandCas("test", 1, { defaultCommand: ["npm", "test"], overrides: [], maxRuns: 1 }, 3_000)
      .ok,
    true,
  );
  s.seedWorkflowCommands(4_000);
  const view = s.getWorkflowCommand("test")!;
  assert.deepEqual(view.defaultCommand, ["npm", "test"]);
  assert.equal(view.revision, 2, "a restart must not bump a revision two windows compare");
});

test("a replacement swaps the whole slot and refuses a stale or duplicate write", () => {
  const s = store();
  const first = s.replaceWorkflowCommandCas("lint", 1, {
    defaultCommand: ["npm", "run", "lint"],
    maxRuns: 1,
    overrides: [
      { repoRoot: "/repo/packages/web", command: ["pnpm", "lint"] },
      { repoRoot: "/repo", command: ["eslint", "."] },
    ],
  }, 2_000);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  // Canonical order, so a projection over this is deterministic rather than insertion-shaped.
  assert.deepEqual(first.view.overrides.map((entry) => entry.repoRoot), [
    "/repo",
    "/repo/packages/web",
  ]);

  const stale = s.replaceWorkflowCommandCas("lint", 1, { defaultCommand: null, overrides: [], maxRuns: 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, "revision_conflict");
  assert.deepEqual(
    stale.ok === false ? stale.current?.defaultCommand : null,
    ["npm", "run", "lint"],
    "a refusal carries what is stored, which is what makes 'reload latest' possible",
  );

  // Refused at the STORE, not only at the schema. The composite key would refuse the second
  // row anyway, but as a constraint violation rather than an answer a caller can read.
  const duplicate = s.replaceWorkflowCommandCas("lint", 2, {
    defaultCommand: null,
    maxRuns: 1,
    overrides: [
      { repoRoot: "/repo", command: ["a"] },
      { repoRoot: "/repo", command: ["b"] },
    ],
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.ok === false && duplicate.reason, "duplicate_override");
  assert.deepEqual(s.getWorkflowCommand("lint")?.overrides.length, 2, "nothing was written");

  assert.equal(
    s.replaceWorkflowCommandCas("deploy", 1, { defaultCommand: null, overrides: [], maxRuns: 1 }).ok,
    false,
    "the slots are built in; a write cannot mint another",
  );
  assert.equal(s.getWorkflowCommand("deploy"), null);
});

test("policy fields default compatibly, persist atomically, and survive legacy-shaped writes", () => {
  const s = store();
  const initial = s.getWorkflowCommand("test")!;
  assert.deepEqual({
    timeoutMs: initial.timeoutMs,
    onUnavailable: initial.onUnavailable,
    onBudgetExhausted: initial.onBudgetExhausted,
  }, {
    timeoutMs: null,
    onUnavailable: "skip",
    onBudgetExhausted: "skip",
  });

  const changed = s.replaceWorkflowCommandCas("test", initial.revision, {
    defaultCommand: ["npm", "test"],
    overrides: [],
    maxRuns: 10,
    timeoutMs: 90 * 60_000,
    onUnavailable: "block",
    onBudgetExhausted: "block",
  });
  assert.equal(changed.ok, true);
  const configured = s.getWorkflowCommand("test")!;
  assert.equal(configured.timeoutMs, 90 * 60_000);
  assert.equal(configured.onUnavailable, "block");
  assert.equal(configured.onBudgetExhausted, "block");

  assert.equal(s.replaceWorkflowCommandCas("test", configured.revision, {
    defaultCommand: ["npm", "run", "test:ci"],
    overrides: [],
    maxRuns: 10,
  }).ok, true);
  const preserved = s.getWorkflowCommand("test")!;
  assert.equal(preserved.timeoutMs, 90 * 60_000);
  assert.equal(preserved.onUnavailable, "block");
  assert.equal(preserved.onBudgetExhausted, "block");
});

test("an untouched override keeps its creation instant across a neighbour's edit", () => {
  const s = store();
  s.replaceWorkflowCommandCas("test", 1, {
    defaultCommand: null,
    maxRuns: 1,
    overrides: [{ repoRoot: "/repo", command: ["npm", "test"] }],
  }, 5_000);
  s.replaceWorkflowCommandCas("test", 2, {
    defaultCommand: null,
    maxRuns: 1,
    overrides: [
      { repoRoot: "/repo", command: ["npm", "test"] },
      { repoRoot: "/other", command: ["make", "test"] },
    ],
  }, 6_000);
  // The replace is a delete-and-insert, which is what makes removal expressible at all - but
  // a surviving row must not report itself as newly written every time a neighbour changes.
  const rows = db.prepare(
    `SELECT repo_root, created_at FROM workflow_command_overrides WHERE slot = 'test' ORDER BY repo_root`,
  ).all() as unknown as Array<{ repo_root: string; created_at: number }>;
  assert.deepEqual(rows.map((row) => ({ repo_root: row.repo_root, created_at: row.created_at })), [
    { repo_root: "/other", created_at: 6_000 },
    { repo_root: "/repo", created_at: 5_000 },
  ]);
});

test("an unreadable CodeRabbit override emits a bounded diagnostic while preserving catalog recovery", (t) => {
  const s = store();
  const logs: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args.join(" ")));
  for (const raw of ["not json fixture-secret", JSON.stringify({ kind: "coderabbit", severity: "invalid" })]) {
    db.prepare(`INSERT OR REPLACE INTO workflow_command_overrides (slot, repo_root, command_json, created_at, updated_at)
      VALUES ('coderabbit', '/repo', ?, 1, 1)`).run(raw);
    assert.deepEqual(s.getWorkflowCommand("coderabbit")!.overrides, []);
  }
  assert.equal(logs.length, 2);
  assert.ok(logs.every(line => line.includes("event=malformed_durable_row")));
  assert.ok(logs.every(line => !line.includes("fixture-secret")));
  assert.equal(s.getWorkflowCommand("coderabbit")!.revision, 1);
});

test("an unreadable row degrades what it holds, not the catalog around it", () => {
  const s = store();
  s.replaceWorkflowCommandCas("build", 1, {
    defaultCommand: ["npm", "run", "build"],
    maxRuns: 1,
    overrides: [],
  }, 7_000);
  // A downgrade, or a hand-edited row: an argv that never passed the write schema.
  db.prepare(`UPDATE workflow_commands SET default_command_json = ? WHERE slot = 'test'`)
    .run("not json at all");
  db.prepare(
    `INSERT INTO workflow_command_overrides (slot, repo_root, command_json, created_at, updated_at)
     VALUES ('typecheck', '/repo', '[]', 1, 1)`,
  ).run();

  const catalog = s.workflowCommandCatalog();
  assert.deepEqual(catalog.map((view) => view.slot), [...WORKFLOW_CHECK_SLOTS]);
  // The unreadable command reads as unconfigured, which SKIPS - the safe direction. It must
  // not degrade to some other slot's command, and it must not throw.
  assert.equal(catalog.find((view) => view.slot === "test")?.defaultCommand, null);
  assert.deepEqual(catalog.find((view) => view.slot === "typecheck")?.overrides, []);
  // And its neighbours are untouched, which is the whole point of failing per row.
  assert.deepEqual(
    catalog.find((view) => view.slot === "build")?.defaultCommand,
    ["npm", "run", "build"],
  );
});

test("an unreadable command degrades the FIELD, so the slot can still be repaired", () => {
  // The recovery the per-row degrade exists for, and the reason it is a FIELD and not a row.
  // The row also carries the revision every write compares against: failing it whole would
  // report revision 1 for a row sitting at 3, and the slot would become permanently
  // unwritable - every compare-and-swap refused as stale against a number no caller could
  // ever learn, with no way back through any surface.
  const s = store();
  s.replaceWorkflowCommandCas("test", 1, {
    defaultCommand: ["npm", "test"],
    maxRuns: 1,
    overrides: [{ repoRoot: "/repo", command: ["npm", "test"] }],
  }, 8_000);
  s.replaceWorkflowCommandCas("test", 2, {
    defaultCommand: ["npm", "test"],
    maxRuns: 1,
    overrides: [{ repoRoot: "/repo", command: ["npm", "run", "test:ci"] }],
  }, 9_000);
  db.prepare(`UPDATE workflow_commands SET default_command_json = ? WHERE slot = 'test'`)
    .run("not json at all");
  db.prepare(`UPDATE workflow_command_overrides SET command_json = ? WHERE slot = 'test'`)
    .run("[]");

  const damaged = s.getWorkflowCommand("test")!;
  assert.equal(damaged.defaultCommand, null, "an unreadable command reads as not configured");
  assert.deepEqual(damaged.overrides, [], "and an unreadable override is not projected");
  assert.equal(damaged.revision, 3, "but the revision a write must carry is the STORED one");

  const repaired = s.replaceWorkflowCommandCas("test", damaged.revision, {
    defaultCommand: ["npm", "test"],
    maxRuns: 1,
    overrides: [],
  }, 10_000);
  assert.equal(repaired.ok, true, "the slot is writable, so the damage is recoverable");
  assert.deepEqual(repaired.ok ? repaired.view.defaultCommand : null, ["npm", "test"]);
});
