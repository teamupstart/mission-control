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
  m.resetForemanInstructions();
  return m;
}

test("the shipped markdown is what an operator who has changed nothing gets", async () => {
  const m = await withSeed("# Defaults\n\nCorrectness first.");
  assert.match(m.foremanInstructions(), /Correctness first/);
  assert.equal(m.defaultForemanInstructions(), m.foremanInstructions());
});

test("a stored value replaces the default", async () => {
  const m = await withSeed("# Defaults\n\nCorrectness first.");
  m.setForemanInstructions("Only ever escalate.");
  assert.equal(m.foremanInstructions(), "Only ever escalate.");
  // The default is still reportable, so a settings panel can offer to restore it.
  assert.match(m.defaultForemanInstructions(), /Correctness first/);
});

test("an EMPTY stored value means none - it does not fall back to the default", async () => {
  // The whole reason this is not `stored || seed()`. Clearing the box is a choice, and
  // quietly reinstating the shipped text there would override an operator who had just
  // decided they wanted Foreman judging on its own policy.
  const m = await withSeed("# Defaults\n\nCorrectness first.");
  m.setForemanInstructions("");
  assert.equal(m.foremanInstructions(), "");
});

test("reset is distinct from clearing, and restores the default", async () => {
  const m = await withSeed("# Defaults\n\nCorrectness first.");
  m.setForemanInstructions("");
  assert.equal(m.foremanInstructions(), "", "precondition: cleared");

  assert.match(m.resetForemanInstructions(), /Correctness first/);
  assert.match(m.foremanInstructions(), /Correctness first/, "and it sticks");
});

test("a missing seed file degrades to no instructions, not a crash", async () => {
  // A packaging slip must not take the daemon down, and it must not invent instructions
  // either. "No instructions" is a state the whole path already handles: it renders nothing
  // and leaves every prompt exactly as it was before this setting existed.
  const m = await withSeed(null);
  assert.equal(m.foremanInstructions(), "");
  assert.equal(m.defaultForemanInstructions(), "");
});
