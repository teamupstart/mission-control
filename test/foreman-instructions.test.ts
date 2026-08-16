import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Foreman's standing instructions are the prose half of its configuration, and this file is
// about where that prose comes from: the markdown shipped with the app until the operator
// edits it, their stored text afterwards.
//
// The distinction that has to survive is EMPTY versus UNSET. An operator who clears the box is
// saying "judge by your own policy alone"; an operator who has never touched it should get the
// default. Collapse the two and clearing the box silently reinstates instructions they just
// deleted - which they would experience as the setting not working, with nothing to point at.

// Isolate the daemon's db BEFORE anything imports it: `config.ts` resolves STATE_DIR (and
// DB_PATH off it) at module scope, so an unset home would point these writes at the
// developer's live ~/.mission-control/harness.db from a unit test.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "foreman-instr-home-"));
const { getAppConfig } = await import("../src/server/db.ts");

/** Point the seed at a scratch file, then load the module fresh so nothing is cached. */
async function withSeed(text: string | null): Promise<typeof import("../src/server/foreman/instructions.ts")> {
  const dir = mkdtempSync(join(tmpdir(), "foreman-instr-"));
  const file = join(dir, "FOREMAN.md");
  if (text !== null) writeFileSync(file, text);
  // `MISSION_`-prefixed: `envVar` walks the MISSION_/FLEET_/HARNESS_ chain, so a bare
  // FOREMAN_INSTRUCTIONS is invisible to it and the real shipped file would be read instead.
  process.env.MISSION_FOREMAN_INSTRUCTIONS = file;
  // A cache-busting query so each case gets its own module instance - `seed()` memoizes, which
  // is right in production (the file cannot change under a running daemon) and would otherwise
  // leak the first case's answer into every later one.
  const m = await import(`../src/server/foreman/instructions.ts?case=${encodeURIComponent(file)}`);
  // Each case starts from "never edited", whatever the previous one stored in the shared db.
  const reset = m.updateForemanInstructions({
    expectedEtag: m.foremanInstructionsView().etag,
    reset: true,
  });
  assert.ok(reset.ok);
  return m;
}

test("the built-in view returns the exact shipped default with a stable ETag", async () => {
  const text = "# Defaults\r\n\r\nCorrectness first.\n";
  const m = await withSeed(text);
  const first = m.foremanInstructionsView();
  const second = m.foremanInstructionsView();

  assert.equal(first.source, "builtin");
  assert.equal(first.text, text);
  assert.equal(first.defaultText, text);
  assert.equal(first.etag, second.etag);
  assert.equal(getAppConfig<unknown>("foreman.instructions"), null);
});

test("a custom view preserves whitespace, line endings, Unicode, and storage bytes exactly", async () => {
  const m = await withSeed("# Defaults\n\nCorrectness first.");
  const exact = " \r\n# Operator\r\n\r\nCafé 😀\t \n";
  const changed = m.updateForemanInstructions({
    expectedEtag: m.foremanInstructionsView().etag,
    text: exact,
  });

  assert.ok(changed.ok);
  assert.equal(changed.view.source, "custom");
  assert.equal(changed.view.text, exact);
  assert.match(changed.view.defaultText, /Correctness first/);
  assert.equal(m.foremanInstructionsView().text, exact);
  assert.equal(m.foremanInstructionsView().etag, changed.view.etag);
  assert.equal(getAppConfig<string>("foreman.instructions"), exact);
});

test("custom text identical to the seed remains source-distinct from built-in", async () => {
  const text = "# Defaults\n\nCorrectness first.";
  const m = await withSeed(text);
  const builtin = m.foremanInstructionsView();
  const changed = m.updateForemanInstructions({ expectedEtag: builtin.etag, text });

  assert.ok(changed.ok);
  assert.equal(changed.view.source, "custom");
  assert.equal(changed.view.text, builtin.text);
  assert.notEqual(changed.view.etag, builtin.etag);
});

test("an empty stored value is intentional none, while reset restores built-in", async () => {
  const m = await withSeed("# Defaults\n\nCorrectness first.");
  const builtin = m.foremanInstructionsView();
  const cleared = m.updateForemanInstructions({ expectedEtag: builtin.etag, text: "" });

  assert.ok(cleared.ok);
  assert.equal(cleared.view.source, "none");
  assert.equal(cleared.view.text, "");
  assert.match(cleared.view.defaultText, /Correctness first/);
  assert.equal(getAppConfig<string>("foreman.instructions"), "");

  const reset = m.updateForemanInstructions({ expectedEtag: cleared.view.etag, reset: true });
  assert.ok(reset.ok);
  assert.equal(reset.view.source, "builtin");
  assert.equal(reset.view.text, builtin.text);
  assert.equal(reset.view.etag, builtin.etag);
  assert.equal(getAppConfig<unknown>("foreman.instructions"), null);
});

test("a stale mutation returns the current view and performs no storage write", async () => {
  const m = await withSeed("# Defaults\n\nCorrectness first.");
  const initial = m.foremanInstructionsView();
  const changed = m.updateForemanInstructions({
    expectedEtag: initial.etag,
    text: "Current document\r\n",
  });
  assert.ok(changed.ok);

  const stale = m.updateForemanInstructions({
    expectedEtag: initial.etag,
    text: "Stale overwrite",
  });
  assert.ok(!stale.ok);
  assert.deepEqual(stale.current, changed.view);
  assert.equal(m.foremanInstructionsView().text, "Current document\r\n");
  assert.equal(getAppConfig<string>("foreman.instructions"), "Current document\r\n");
});

test("a missing seed is empty built-in and remains distinct from intentional none", async () => {
  const m = await withSeed(null);
  const builtin = m.foremanInstructionsView();

  assert.equal(builtin.source, "builtin");
  assert.equal(builtin.text, "");
  assert.equal(builtin.defaultText, "");

  const cleared = m.updateForemanInstructions({ expectedEtag: builtin.etag, text: "" });
  assert.ok(cleared.ok);
  assert.equal(cleared.view.source, "none");
  assert.equal(cleared.view.text, "");
  assert.equal(cleared.view.defaultText, "");
  assert.notEqual(cleared.view.etag, builtin.etag);
});
