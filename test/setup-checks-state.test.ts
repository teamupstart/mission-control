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

test("setupFlagsRefresh re-reads a reading taken under other flags, once per live stamp", async () => {
  const { setupFlagsRefresh } = await import("../src/web/useSetupChecks.ts");
  // CodeRabbit's race: the mount read ran with voice off, so it carries no stamp (""), and voice
  // was switched on in another window before this window's first snapshot, which arrives on.
  assert.deepEqual(setupFlagsRefresh(null, "1000", ""), { settled: "1000", refresh: true });
  // The re-read comes back stamped with the live flags: settled, nothing more.
  assert.deepEqual(setupFlagsRefresh("1000", "1000", "1000"), { settled: "1000", refresh: false });
  // The ordinary loads: the reading already matches its first snapshot, so no extra request,
  // whether voice is off (no stamp on either side) or on.
  assert.deepEqual(setupFlagsRefresh(null, "", ""), { settled: "", refresh: false });
  assert.deepEqual(setupFlagsRefresh(null, "1111", "1111"), { settled: "1111", refresh: false });
  // A later switch re-reads, including voice going off.
  assert.deepEqual(setupFlagsRefresh("1000", "1110", "1000"), { settled: "1110", refresh: true });
  assert.deepEqual(setupFlagsRefresh("1110", "", "1110"), { settled: "", refresh: true });
  // A reading that still disagrees after one re-read for this stamp (a window whose own flags are
  // stale) is not read again until the live stamp moves.
  assert.deepEqual(setupFlagsRefresh("1110", "1110", "1000"), { settled: "1110", refresh: false });
});
