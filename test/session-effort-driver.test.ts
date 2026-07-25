import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { meta, mkSession } from "./helpers/session-fixture.ts";

// What is at stake: the reasoning-effort picker on a card with no pane.
//
// `sessionEffortTargetResult` narrows the reachable levels to the ones ONE keystroke away,
// because a `shortcuts` picker (Codex's) is a list walked with Shift+Up / Shift+Down and a
// jump would need an unbounded number of presses. Every word of that is about keystrokes,
// and an embedded session has none - `turn/start` takes `effort` as a parameter, so any
// level the model offers is one hop.
//
// The bug this pins was invisible while Claude was the only driver: its picker is
// `horizontal`, so the narrowing is a no-op and the shared gate looked harness-neutral.
// Point the same route at an embedded Codex session and it refuses "low" from "high" with a
// sentence about atomic reachability that describes a walk nobody is doing.

process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "mission-effort-driver-"));

const { driverEffortTargetResult, sessionEffortTargetResult } = await import(
  "../src/server/actions.ts"
);

/** An embedded Codex session on a model whose effort list is the full five. */
const embedded = (over: Parameters<typeof meta>[0] = {}) =>
  mkSession({
    agent: "codex",
    runtime: "sdk",
    id: "sdk:1",
    tty: null,
    terminals: [],
    meta: meta({ model: "GPT-5.6", modelId: "gpt-5.6-sol", thinkingLevel: "high", ...over }),
  });

test("a driver reaches any level its model offers, however far from the current one", () => {
  const session = embedded();
  // The pane gate refuses this - correctly, for a pane.
  assert.match(
    sessionEffortTargetResult(session, "low")?.error ?? "",
    /not atomically reachable/,
  );
  // The driver gate lets it through: null means "nothing to refuse, go ahead".
  assert.equal(driverEffortTargetResult(session, "low"), null);
  assert.equal(driverEffortTargetResult(session, "max"), null);
});

test("a level this model does not offer is still refused", () => {
  // `gpt-5.6-codex` is not one of the two ids Codex's `levelsFor` widens to five, so `max`
  // is genuinely not on offer - and that refusal survives, because it is not about panes.
  const session = embedded({ modelId: "gpt-5.6-codex" });
  const refusal = driverEffortTargetResult(session, "max");
  assert.equal(refusal?.ok, false);
  assert.match(refusal?.error ?? "", /max effort is not offered for this model/);
  assert.equal(driverEffortTargetResult(session, "xhigh"), null);
});

test("setting the level a session already runs at is answered, not delivered", () => {
  // Short-circuits rather than spending a turn parameter, and reports the level so the card
  // does not sit waiting on a change that was never going to happen.
  assert.deepEqual(driverEffortTargetResult(embedded(), "high"), { ok: true, effort: "high" });
});

test("an unknown model falls back to the harness's conservative list, not to nothing", () => {
  // A session that has not reported a model id yet is not a session that cannot change
  // effort - the pane gate refuses it because a walk needs to know where it starts, and a
  // driver does not walk. Codex's `levelsFor(null)` is its four-level default.
  const session = embedded({ modelId: null, thinkingLevel: null });
  assert.match(
    sessionEffortTargetResult(session, "low")?.error ?? "",
    /model id is not known yet/,
  );
  assert.equal(driverEffortTargetResult(session, "low"), null);
  assert.equal(driverEffortTargetResult(session, "max")?.ok, false);
});
