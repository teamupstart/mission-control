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

test("setupFlagsRefresh re-reads a reading taken under other flags, once per live key", async () => {
  const { setupFlagsRefresh } = await import("../src/web/useSetupChecks.ts");
  // CodeRabbit's race: the mount read ran with voice off ("000"), voice was switched on in another
  // window before this window's first snapshot, which arrives already on ("100").
  assert.deepEqual(setupFlagsRefresh(null, "100", "000"), { settled: "100", refresh: true });
  // The re-read comes back under the live flags: settled, nothing more.
  assert.deepEqual(setupFlagsRefresh("100", "100", "100"), { settled: "100", refresh: false });
  // The ordinary load: the reading already matches its first snapshot, so no extra request.
  assert.deepEqual(setupFlagsRefresh(null, "100", "100"), { settled: "100", refresh: false });
  // A later switch re-reads.
  assert.deepEqual(setupFlagsRefresh("100", "110", "100"), { settled: "110", refresh: true });
  // A reading that still disagrees after one re-read for this key (a window whose own flags are
  // stale) is not read again until the live key moves.
  assert.deepEqual(setupFlagsRefresh("110", "110", "100"), { settled: "110", refresh: false });
  // An older daemon stamps nothing: the first key is taken as the one it read under, and only a
  // later change re-reads, as before.
  assert.deepEqual(setupFlagsRefresh(null, "100", undefined), { settled: "100", refresh: false });
  assert.deepEqual(setupFlagsRefresh("100", "110", undefined), { settled: "110", refresh: true });
  assert.deepEqual(setupFlagsRefresh("110", "110", undefined), { settled: "110", refresh: false });
});
