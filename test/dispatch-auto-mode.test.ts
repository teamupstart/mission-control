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
//   - ON + codex -> no permission-mode flag, EVEN THOUGH Codex now names an `onDispatch`
//     mode: it declares no `launchArgs`, and that gate is what keeps a dispatched pane
//     byte-identical while the embedded runtime - which sets its posture through the
//     app-server's own turn parameters rather than through argv - still learns which mode
//     an auto dispatch means. Its widened launch sandbox stays `prepareCodexLaunch`'s;
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

test("setting ON + codex: a mode is resolved, and no flag is rendered for it", async () => {
  setHarnessesConfig({ autoModeOnDispatch: true });
  // The two halves have to be checked together, because the risk is that naming an
  // `onDispatch` mode for the embedded runtime quietly starts changing the terminal argv.
  // It cannot: `launchArgs` is null for Codex and `dispatchPermissionModeArgs` gates on it.
  const { dispatchPermissionMode } = await import("../src/server/dispatcher.ts");
  assert.equal(dispatchPermissionMode("codex"), "askForApproval");
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
