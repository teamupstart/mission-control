import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: the operator's real settings database.
//
// A test file that imports server modules without redirecting the state dir first gets
// `~/.mission-control/harness.db` - silently. One such test on a feature branch ran
// `DELETE FROM app_config` in its beforeEach and wiped every saved setting on the
// developer's machine each time the suite ran; the Foreman looked "switched off" and
// nothing pointed back at the test. `openDb` now refuses that open outright under the
// test runner, and this file pins the refusal from the outside: a real child process,
// a real (jailed) home, both the failing and the correct isolation pattern.

const home = mkdtempSync(join(tmpdir(), "mission-db-isolation-"));
after(() => rmSync(home, { recursive: true, force: true }));

/**
 * Run a child that imports db.ts and opens the db, the way a test file would.
 *
 * `HOME` is jailed into the temp dir so that if the guard ever regresses, the child
 * scribbles on a scratch home rather than the real one - the test must never rely on
 * the very guard it is checking. `NODE_TEST_CONTEXT` is set by `node --test` in every
 * test child; stating it explicitly keeps the child honest about what it simulates.
 */
function openInChild(extraEnv: Record<string, string>): { status: number; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_TEST_CONTEXT: "child-v8",
    HOME: home,
  };
  delete env.MISSION_HOME;
  delete env.FLEET_HOME;
  delete env.HARNESS_HOME;
  Object.assign(env, extraEnv);
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const { openDb } = await import("./src/server/db.ts"); openDb();`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer };
    return { status: e.status ?? 1, stderr: String(e.stderr ?? "") };
  }
}

test("a test that never redirected the state dir cannot open the real db", () => {
  const res = openInChild({});
  assert.notEqual(res.status, 0, "the open must fail, not fall through to the home dir");
  assert.match(res.stderr, /real\s+state dir/i);
  assert.equal(
    existsSync(join(home, ".mission-control")),
    false,
    "the refusal must come before anything is created",
  );
});

test("an override set the documented way opens exactly where it points", () => {
  const state = join(home, "state");
  const res = openInChild({ HARNESS_HOME: state });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(join(state, "harness.db")), true);
});
