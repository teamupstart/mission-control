import assert from "node:assert/strict";
import test from "node:test";
import { backgroundEffortEnabled } from "../src/server/foreman/background-effort.ts";

test("each Foreman operation reads the current preview gate and fails closed", async () => {
  let enabled = true;
  const read = async () => ({ backgroundReasoningEffort: enabled });
  const firstOperation = await backgroundEffortEnabled(read);
  enabled = false;
  const nextOperation = await backgroundEffortEnabled(read);
  assert.equal(firstOperation, true);
  assert.equal(nextOperation, false);
  assert.equal(await backgroundEffortEnabled(async () => { throw new Error("offline"); }), false);
});
