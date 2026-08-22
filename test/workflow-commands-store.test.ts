import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKFLOW_CHECK_SLOTS } from "../src/shared/workflow.ts";

// What is at stake: the store is the boundary a future caller reaches WITHOUT passing the
// route schema, and what it holds is an argv the daemon spawns. So the rules that make
// resolution deterministic - one command per repository per slot, four slots always present,
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
    "the four slots are built in; a write cannot mint a fifth",
  );
  assert.equal(s.getWorkflowCommand("deploy"), null);
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
