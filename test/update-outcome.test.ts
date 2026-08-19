import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  consumeUpdateOutcome,
  readUpdateOutcome,
  UPDATE_OUTCOME_SCHEMA,
  writeUpdateOutcome,
} from "../src/main/update-outcome.js";

test("update outcome markers round-trip schema-1 failures and refuse unknown schemas", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-outcome-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const supportedPath = join(directory, "supported.json");
  const unsupportedPath = join(directory, "unsupported.json");
  const outcome = {
    result: "failure" as const,
    targetVersion: "2.0.0",
    recordedAt: "2026-08-19T12:00:00.000Z",
    message: "The update could not be installed.",
  };

  await writeUpdateOutcome(supportedPath, outcome);
  await writeFile(
    unsupportedPath,
    JSON.stringify({ schema: UPDATE_OUTCOME_SCHEMA + 1, ...outcome }),
  );

  assert.deepEqual(
    [await readUpdateOutcome(supportedPath), await readUpdateOutcome(unsupportedPath)],
    [outcome, null],
  );
});

test("a surfaced outcome is consumed exactly once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-update-consume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "outcome.json");
  const outcome = {
    result: "success" as const,
    targetVersion: "2.0.0",
    recordedAt: "2026-08-19T12:00:00.000Z",
  };
  writeUpdateOutcome(path, outcome);
  assert.deepEqual([consumeUpdateOutcome(path), consumeUpdateOutcome(path)], [outcome, null]);
});
