import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalTargetView } from "../src/shared/terminal.ts";
import {
  forgetTerminalTargets,
  loadTerminalTargets,
} from "../src/web/lib/terminalTargets.ts";

const view = (id: string): TerminalTargetView => ({
  id: id as TerminalTargetView["id"],
  label: id,
  glyph: "",
  blurb: "",
  detail: null,
  unavailable: null,
});

/** A read whose Nth call resolves only when `releases[n]` is called. */
function deferrable(answers: readonly string[]) {
  const releases: Array<() => void> = [];
  let calls = 0;
  const read = (): Promise<{ targets: TerminalTargetView[] } | null> => {
    const answer = answers[calls] ?? answers.at(-1)!;
    calls += 1;
    return new Promise((resolve) => {
      releases.push(() => resolve({ targets: [view(answer)] }));
    });
  };
  return { read, releases, calls: () => calls };
}

test("a read superseded while in the air never writes its answer into the memo", async () => {
  forgetTerminalTargets();
  const gate = deferrable(["stale", "fresh"]);

  const first = loadTerminalTargets(gate.read);
  // What Re-check does: drop the memo. It cannot cancel the request already in the air.
  forgetTerminalTargets();
  const second = loadTerminalTargets(gate.read);
  assert.equal(gate.calls(), 2, "the invalidation started a second request");

  // The OLDER read settles LAST, which is the ordering this guards against.
  gate.releases[1]!();
  assert.deepEqual((await second)?.map((t) => t.id), ["fresh"]);
  gate.releases[0]!();
  assert.deepEqual(
    (await first)?.map((t) => t.id),
    ["stale"],
    "still the honest answer for whoever awaited that promise",
  );

  // But it may not become the memo the next reader is handed, and it may not have cleared
  // the newer request's `inFlight` on its way out.
  assert.deepEqual(
    (await loadTerminalTargets(gate.read))?.map((t) => t.id),
    ["fresh"],
  );
  assert.equal(gate.calls(), 2, "the refreshed answer was memoized, so no third request ran");
  forgetTerminalTargets();
});
