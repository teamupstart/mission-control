import assert from "node:assert/strict";
import test from "node:test";

import type { SetupChecksSnapshot } from "../src/shared/setup-catalog.ts";
import { readSetupChecks } from "../src/web/useSetupChecks.ts";

test("a rejected setup read becomes panel error state", async () => {
  const result = await readSetupChecks(async () => {
    throw new Error("daemon restarting");
  });

  assert.deepEqual(result, {
    view: null,
    error: "Mission Control could not inspect this machine's setup.",
  });
});

test("a successful setup read keeps its view and clears the error", async () => {
  const view: SetupChecksSnapshot = {
    snapshotToken: "00000000-0000-4000-8000-000000000000",
    rows: [],
    home: "/home/test",
    banner: { visible: true, attentionRowIds: [], attentionCount: 0 },
  };
  assert.deepEqual(await readSetupChecks(async () => view), { view, error: null });
});
