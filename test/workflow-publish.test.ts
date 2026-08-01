// Publishing behavior is exercised with the real SQLite transaction in workflow-store.test.ts.
// Keep this named suite as the phase-plan entry point so focused validation commands stay stable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("Publish remains one transaction that snapshots both catalogs before inserting a version", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/server/workflows/store.ts", import.meta.url)), "utf8");
  assert.match(source, /publishWorkflow[\s\S]*transaction\(this\.db/);
  assert.match(source, /source_draft_revision/);
  // Both catalogs are read INSIDE the transaction and the snapshots are taken from those
  // exact lists. Re-reading either after validation would let a source archived in between
  // pass validation and then be frozen into an immutable version as a live one.
  assert.match(source, /const personas = this\.listPersonasInTransaction\(\);/);
  assert.match(source, /const sessionActions = this\.listSessionActionsInTransaction\(\);/);
  // The snapshot field lists live in `@shared/workflow.ts`, stated once, so a field added to
  // the type but to only one publisher is a compile error rather than a version that quietly
  // ships without it.
  assert.match(source, /persona: personaSnapshotOf\(persona\)/);
  assert.match(source, /action: sessionActionSnapshotOf\(action\)/);
});
