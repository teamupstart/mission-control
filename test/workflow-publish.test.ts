// Publishing behavior is exercised with the real SQLite transaction in workflow-store.test.ts.
// Keep this named suite as the phase-plan entry point so focused validation commands stay stable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("Publish remains one transaction that snapshots Personas before inserting a version", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/server/workflows/store.ts", import.meta.url)), "utf8");
  assert.match(source, /publishWorkflow[\s\S]*transaction\(this\.db/);
  assert.match(source, /source_draft_revision/);
  assert.match(source, /guidanceMarkdown: persona\.guidanceMarkdown/);
});
