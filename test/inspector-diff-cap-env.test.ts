import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { resolveMaxDiffBytes } from "../src/server/inspector/worker.ts";

// The README documents `INSPECTOR_MAX_DIFF_BYTES` as the Inspector's diff-cap override,
// and a documented setting that silently does nothing is worse than an undocumented one:
// the operator sets it, watches the prompt stay the same size, and has no way to tell a
// broken cap from a cap that is working as designed.
//
// It is worth pinning because this name is an EXCEPTION. Every other override in that
// table reaches the process through `envVar`, which only ever reads `MISSION_` / `FLEET_`
// / `HARNESS_` prefixed names - so the bare spelling here is a per-setting alias that a
// later refactor to "just use envVar like everything else" would quietly delete.
//
// The prefixed forms must keep winning, because they are what existing installs set.

const KEYS = [
  "INSPECTOR_MAX_DIFF_BYTES",
  "MISSION_INSPECTOR_MAX_DIFF_BYTES",
  "FLEET_INSPECTOR_MAX_DIFF_BYTES",
  "HARNESS_INSPECTOR_MAX_DIFF_BYTES",
] as const;

const saved = new Map(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clear(): void {
  for (const key of KEYS) delete process.env[key];
}

test("the documented bare name is honoured", () => {
  clear();
  process.env.INSPECTOR_MAX_DIFF_BYTES = "111111";
  assert.equal(resolveMaxDiffBytes(), 111_111);
});

test("the prefixed spellings still work, and win over the bare one", () => {
  // Existing installs set these; the alias must not demote them.
  clear();
  process.env.MISSION_INSPECTOR_MAX_DIFF_BYTES = "222222";
  assert.equal(resolveMaxDiffBytes(), 222_222, "MISSION_ alone");

  process.env.INSPECTOR_MAX_DIFF_BYTES = "111111";
  assert.equal(resolveMaxDiffBytes(), 222_222, "MISSION_ wins over bare");

  clear();
  process.env.FLEET_INSPECTOR_MAX_DIFF_BYTES = "333333";
  process.env.INSPECTOR_MAX_DIFF_BYTES = "111111";
  assert.equal(resolveMaxDiffBytes(), 333_333, "FLEET_ wins over bare");

  clear();
  process.env.HARNESS_INSPECTOR_MAX_DIFF_BYTES = "444444";
  process.env.INSPECTOR_MAX_DIFF_BYTES = "111111";
  assert.equal(resolveMaxDiffBytes(), 444_444, "HARNESS_ wins over bare");
});

test("with nothing set it is the documented default", () => {
  clear();
  assert.equal(resolveMaxDiffBytes(), 400_000, "the figure the README prints");
});
