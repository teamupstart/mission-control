import assert from "node:assert/strict";
import test from "node:test";

import { LAYOUT_MODES, UI_CONFIG_DEFAULTS, UiConfigPatchSchema } from "../src/shared/protocol.ts";
import {
  DEMO_LAYOUT,
  createShutdownGate,
  demoLayoutAccepted,
  demoUiConfigBody,
} from "../scripts/demo/launch.mjs";

/**
 * The demo LAUNCHER's pure half, under the suite CI actually runs.
 *
 * `scripts/demo/launch.test.mjs` used to hold the shutdown-gate cases below, outside
 * `npm test`'s `test/**` glob and behind a header telling the reader to run it by hand - so the
 * launcher's only regression coverage was coverage nothing ran. They are here now, unchanged in
 * substance, beside the new cases for the layout write. `test/demo-seed.test.ts` remains the
 * SEEDER's half; this file is the launcher's.
 *
 * What is NOT here, deliberately: booting a demo daemon. `test/` runs against `src/` with no
 * build, and a launcher test that spawned `dist/server/index.mjs` would need one - and would have
 * to write to `~/.mission-control-demo-check`, the root `npm run demo -- --check` owns, on the one
 * fixed port it uses. So the runtime proof stays where it can be honest: `--check` boots a real
 * demo daemon, reboots over it, and asserts the stored layout through `GET /api/ui/config`. This
 * file covers everything that can be decided without a daemon, which is the part that breaks
 * silently.
 */

test("the demo opens on a layout this build actually ships", () => {
  // A renamed or retired layout id is the realistic break, and it would reach an operator as a
  // 400 mid-boot rather than as a failing test. `LAYOUT_MODES` is the daemon's own list, and the
  // render switch branches on the same one.
  assert.ok(
    (LAYOUT_MODES as readonly string[]).includes(DEMO_LAYOUT),
    `${DEMO_LAYOUT} is not one of ${LAYOUT_MODES.join(", ")}`,
  );
  // Named, not merely valid: "the demo opens on the Board" is the behaviour, and a change to
  // `console` or `grid` should have to edit a test that says so out loud.
  assert.equal(DEMO_LAYOUT, "board");
});

test("the layout write is a body the route's own schema accepts, and asks for nothing else", () => {
  const body = demoUiConfigBody();
  const parsed = UiConfigPatchSchema.safeParse(body);
  assert.ok(parsed.success, parsed.success ? "" : parsed.error.message);
  assert.equal(parsed.data.layout, DEMO_LAYOUT);

  // THE case, and it is about the fields the body leaves out. `UiConfigPatchSchema` is a plain
  // `.partial()` because every top-level key is owned whole by one panel, so a body that also
  // mentioned `keybindings` or `alerts` would REPLACE them - a demo launcher silently resetting an
  // operator's rebinds and notification choices in the demo root on every boot.
  assert.deepEqual(Object.keys(body), ["layout"]);
});

test("the demo layout is a deliberate override, not the shipped default restated", () => {
  // If these ever agree, the launcher's write has become a no-op and this file should say which
  // one moved - the point of the write is that a demo daemon does NOT open the way a fresh
  // install does.
  assert.notEqual(
    UI_CONFIG_DEFAULTS.layout,
    DEMO_LAYOUT,
    "the app default now matches the demo's; the launcher's PUT is redundant and should be revisited",
  );
});

test("only an echo of the stored layout counts as accepted", () => {
  assert.equal(demoLayoutAccepted({ configured: true, config: { layout: "board" } }), true);
  // The silent failure this guard exists for: a partial patch whose key was misspelled is VALID
  // input, so the route answers 200 with a config that still says `grid`.
  assert.equal(demoLayoutAccepted({ configured: true, config: { layout: "grid" } }), false);
  // And a 200 whose body carries no layout at all - the same mistake, differently spelled.
  assert.equal(demoLayoutAccepted({ configured: true, config: {} }), false);
  assert.equal(demoLayoutAccepted({ config: null }), false);
  assert.equal(demoLayoutAccepted({}), false);
  assert.equal(demoLayoutAccepted(null), false);
  assert.equal(demoLayoutAccepted(undefined), false);
  // A body that is not the shape at all (an HTML error page parsed as text, a bare string) must
  // not throw its way out of the boot path.
  assert.equal(demoLayoutAccepted("board"), false);
  assert.equal(demoLayoutAccepted({ layout: "board" }), false, "the layout lives under `config`");
});

// --- the shutdown gate, moved here from `scripts/demo/launch.test.mjs` ----------------------
//
// Regression coverage for the orphan-daemon bug a Code Risk Reviewer round found in `launch.mjs`,
// and for the subtler race the first fix introduced: see `createShutdownGate` for the full story.

test("stop runs the cleanup", async () => {
  let calls = 0;
  const gate = createShutdownGate(async () => {
    calls += 1;
  });
  const claimed = await gate.stop("SIGINT");
  assert.equal(claimed, true);
  assert.equal(calls, 1);
  assert.equal(gate.isStopping(), true);
});

test("two concurrent callers race for the SAME stop: exactly one runs cleanup, exactly one is told it lost", async () => {
  // This is the shape of the real bug: a SIGINT arriving while the Foreman lease-wait's own
  // failure path is about to call stop() too. Both call stop() before either's onStop has
  // resolved - a losing caller that could not tell it lost would call process.exit itself and race
  // the winner's still-in-flight cleanup, exiting before it finished.
  let calls = 0;
  const gate = createShutdownGate(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
  });
  const [signalWon, foremanWon] = await Promise.all([
    gate.stop("SIGINT"),
    gate.stop("foreman-failed"),
  ]);
  assert.equal(calls, 1, "cleanup must run exactly once, not once per caller");
  assert.equal(
    [signalWon, foremanWon].filter(Boolean).length,
    1,
    "exactly one caller must be told it won",
  );
});

test("a stop claimed after cleanup already finished is told it lost, and does not re-run cleanup", async () => {
  let calls = 0;
  const gate = createShutdownGate(async () => {
    calls += 1;
  });
  await gate.stop("first");
  const second = await gate.stop("second");
  assert.equal(calls, 1);
  assert.equal(second, false);
});

test("a caller that loses the race never sees onStop's return value or throws on its behalf", async () => {
  // The exact defect: a losing caller that still called process.exit(1) unconditionally would exit
  // the process before the winner's own cleanup (started first, still running) ever reached its own
  // process.exit. Modeled here as: the winner's cleanup takes a while, and the loser resolves
  // immediately with `false` rather than waiting on it at all.
  const order: string[] = [];
  const gate = createShutdownGate(async () => {
    order.push("cleanup-start");
    await new Promise((r) => setTimeout(r, 30));
    order.push("cleanup-end");
  });
  const winner = gate.stop("winner").then((won) => order.push(won ? "winner-done" : "winner-lost"));
  const loser = gate.stop("loser").then((won) => order.push(won ? "loser-done" : "loser-lost"));
  await Promise.all([winner, loser]);
  // The loser resolves as soon as it sees `stopping` already true - it must not block on the
  // winner's cleanup, and it must resolve `false` rather than duplicate the work.
  assert.equal(order.filter((e) => e === "cleanup-start").length, 1);
  assert.ok(order.includes("loser-lost") || order.includes("winner-lost"));
  assert.equal(order.filter((e) => e === "winner-done" || e === "loser-done").length, 1);
});
