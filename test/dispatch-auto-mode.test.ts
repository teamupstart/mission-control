import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The launch flag "auto mode on dispatch" now rides in on - the heart of the setting.
// `dispatchPermissionModeArgs` is exercised against the REAL harnesses config (a
// round-trip through the app_config KV) and the REAL harness registry, so what is tested
// is the exact argv a dispatch builds, not a mock of it.
//
// The contract under test:
//   - ON + claude -> `--permission-mode auto` on the launch argv, so the session STARTS
//     in auto mode with no post-launch keystrokes and no readable footer required (a
//     fresh session's folder-trust dialog hides that footer, which is what broke the old
//     Shift+Tab walk);
//   - ON + codex -> no permission-mode flag: Codex exposes live native modes but declares
//     no autonomous on-dispatch mode, while its launch builder applies a widened sandbox;
//   - ON + pi -> no flag: pi declares no permission modes at all;
//   - OFF (or unconfigured) -> nothing, for every agent.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-auto-"));
// Set before importing anything that resolves the state dir / opens the db.
process.env.HARNESS_HOME = join(home, "state");

const { dispatchPermissionModeArgs } = await import("../src/server/dispatcher.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { openDb } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

test("setting ON + claude: the launch carries --permission-mode auto", () => {
  setHarnessesConfig({ autoModeOnDispatch: true });
  assert.deepEqual(dispatchPermissionModeArgs("claude"), ["--permission-mode", "auto"]);
});

test("setting ON + codex: its native picker is not armed at launch", () => {
  setHarnessesConfig({ autoModeOnDispatch: true });
  // The absence is the point: Codex has live modes but no autonomous `onDispatch` mode;
  // its widened launch sandbox remains the responsibility of `prepareCodexLaunch`.
  assert.deepEqual(dispatchPermissionModeArgs("codex"), []);
});

test("setting ON + pi: no flag - pi declares no permission modes", () => {
  setHarnessesConfig({ autoModeOnDispatch: true });
  assert.deepEqual(dispatchPermissionModeArgs("pi"), []);
});

test("setting OFF: claude is launched with no mode flag, in its default mode", () => {
  setHarnessesConfig({ autoModeOnDispatch: false });
  assert.deepEqual(dispatchPermissionModeArgs("claude"), []);
});

test("default config (nothing stored): claude gets no flag - the setting is off until opted in", () => {
  // No setHarnessesConfig call: the KV is empty, so the schema default (off) governs.
  assert.deepEqual(dispatchPermissionModeArgs("claude"), []);
});
