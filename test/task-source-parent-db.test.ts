import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

// `source_parent` is display data read in `rowToTask`: a bad blob must read as no parent
// (or a parent with no url) and never take out `getTask` / `listTasks`.
const home = mkdtempSync(join(tmpdir(), "mission-source-parent-db-"));
process.env.HARNESS_HOME = home;
const { openDb, upsertTask, getTask, listTasks } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => openDb().exec("DELETE FROM tasks"));

const REF = { sourceId: "gh", externalId: "acme/demo#3", url: "https://github.com/acme/demo/issues/3" };

function withRaw(raw: string | null) {
  upsertTask(mkTask({ id: "t", status: "backlog", source: { ...REF, externalId: "acme/demo#4" } }));
  openDb().prepare("UPDATE tasks SET source_parent = ? WHERE id = 't'").run(raw);
  return { one: getTask("t")!.sourceParent, all: listTasks().find((t) => t.id === "t")!.sourceParent };
}

test("a well-formed parent round-trips through upsertTask", () => {
  upsertTask(mkTask({ id: "t", status: "backlog", sourceParent: REF }));
  assert.deepEqual(getTask("t")!.sourceParent, REF);
  assert.equal(openDb().prepare("SELECT source_parent AS p FROM tasks WHERE id = 't'").get()!.p, JSON.stringify(REF));
});

for (const [name, raw] of [
  ["NULL", null],
  ["an empty string", ""],
  ["invalid JSON", "{not json"],
  ["JSON null", "null"],
  ["an empty object", "{}"],
  ["a missing externalId", JSON.stringify({ sourceId: "gh", url: REF.url })],
  ["a non-string sourceId", JSON.stringify({ sourceId: 7, externalId: REF.externalId, url: REF.url })],
] as const) {
  test(`${name} reads as no parent, without throwing`, () => {
    assert.deepEqual(withRaw(raw), { one: null, all: null });
  });
}

test("a non-string url keeps the parent with url null", () => {
  const expected = { ...REF, url: null };
  assert.deepEqual(withRaw(JSON.stringify({ ...REF, url: 42 })), { one: expected, all: expected });
});
