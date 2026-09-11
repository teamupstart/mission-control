import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { cmuxControlProbe } from "../src/server/terminal/cmux.ts";
import {
  cmuxConfigBackupPath,
  enableCmuxSocketControl,
  readCmuxSocketControl,
  withCmuxSocketControlAllowed,
} from "../src/server/setup/cmux-config.ts";
import { stubRun } from "../src/server/util/exec.ts";
import type { TerminalExec } from "../src/server/terminal/exec.ts";

/**
 * The two facts that stand between an installed cmux and a working one, and the repair for
 * the second of them.
 *
 * Both readings were measured against a real cmux 0.64.20 before they were written down -
 * the CLI reports all of this as prose on stderr and there is no structured error to key on,
 * so the exact sentences below are the contract.
 */

const exec = (result: { stdout?: string; stderr?: string; code: number }): TerminalExec =>
  async () => stubRun({ stdout: "", stderr: "", ...result });

test("a cmux socket that answers reports its own access mode", async () => {
  const probe = await cmuxControlProbe(
    exec({ stdout: '{\n  "access_mode" : "allowAll",\n  "methods" : []\n}\n', code: 0 }),
  );
  assert.deepEqual(probe, { state: "ready", accessMode: "allowAll" });
});

test("a closed app and a refusing socket are told apart by what cmux said", async () => {
  // Two failures that are indistinguishable by exit code - both are 1 - and that call for
  // opposite repairs. Keying on the exit code alone is how Setup would offer to open an app
  // that is already open.
  const closed = await cmuxControlProbe(
    exec({ stderr: "Error: Socket not found at /Users/x/.local/state/cmux/cmux.sock\n", code: 1 }),
  );
  assert.deepEqual(closed, { state: "stopped" });

  const refused = await cmuxControlProbe(
    exec({ stderr: "Error: ERROR: Access denied - only processes started inside cmux can connect\n", code: 1 }),
  );
  assert.deepEqual(refused, { state: "refused" });
});

test("any other failure keeps cmux's own sentence rather than being read as one of the two", async () => {
  const probe = await cmuxControlProbe(exec({ stderr: "Error: socket handshake timed out\n", code: 1 }));
  assert.deepEqual(probe, { state: "failed", error: "Error: socket handshake timed out" });
});

test("a failure with nothing on stderr still says which call failed", async () => {
  const probe = await cmuxControlProbe(exec({ code: 1 }));
  assert.deepEqual(probe, { state: "failed", error: "cmux capabilities failed" });
});

// ---- the repair ----

/** cmux writes a file that is mostly a commented-out template of every setting. */
const SHIPPED = `{
  "$schema": "https://example.invalid/cmux.schema.json",
  "schemaVersion": 1,

  // This file uses JSON with comments (JSONC).
  // Uncomment and edit any setting to make it file-managed.

  //   "automation" : {
  //     "socketControlMode" : "cmuxOnly",
  //     "claudeCodeIntegration" : true
  //   },
}
`;

test("the operator's comments and their commented-out template survive the edit", () => {
  const edited = withCmuxSocketControlAllowed(SHIPPED);
  assert.match(edited, /"socketControlMode":\s*"allowAll"/);
  assert.ok(edited.includes("// This file uses JSON with comments (JSONC)."));
  assert.ok(edited.includes('//     "claudeCodeIntegration" : true'));
  // The commented-out copy is left exactly as it was: it is documentation, not configuration,
  // and rewriting it would tell the operator their default had changed.
  assert.ok(edited.includes('//     "socketControlMode" : "cmuxOnly",'));
  assert.equal(readCmuxSocketControl(edited), "allowAll");
});

test("a commented-out key is not read as the file's answer", () => {
  // The trap this whole module is built around: `SHIPPED` mentions `socketControlMode` and
  // configures nothing. A scan that matched the text would report the file as already set to
  // `cmuxOnly` and, worse, would edit the comment.
  assert.equal(readCmuxSocketControl(SHIPPED), null);
  assert.equal(readCmuxSocketControl(""), null);
  assert.equal(readCmuxSocketControl('{"automation": {}}'), null);
  assert.equal(readCmuxSocketControl('{"automation": {"socketControlMode": "cmuxOnly"}}'), "cmuxOnly");
});

test("an existing automation block is added to rather than replaced", () => {
  const edited = withCmuxSocketControlAllowed(
    '{\n  "automation": {\n    "socketPassword": "hunter2"\n  }\n}\n',
  );
  assert.equal(readCmuxSocketControl(edited), "allowAll");
  assert.ok(edited.includes('"socketPassword": "hunter2"'));
});

/** A disposable stand-in for `~/.config/cmux/cmux.json`, seeded or absent. */
function configPath(seed?: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "mission-cmux-config-")), ".config", "cmux", "cmux.json");
  if (seed !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, seed);
  }
  return path;
}

test("the repair backs the file up before it writes, and says where", () => {
  const path = configPath(SHIPPED);
  const at = new Date(2026, 8, 10, 10, 23, 33);
  const result = enableCmuxSocketControl(path, at);

  assert.equal(result.ok && result.outcome, "enabled");
  assert.ok(result.ok && result.backup);
  const backup = result.ok ? result.backup! : "";
  // The shape cmux's own `--help` asks an editor to leave behind.
  assert.equal(backup, cmuxConfigBackupPath(path, at));
  assert.match(backup, /cmux\.json\.20260910-102333\.bak$/);
  assert.equal(readFileSync(backup, "utf8"), SHIPPED, "the backup is the file as it was");
  assert.equal(readCmuxSocketControl(readFileSync(path, "utf8")), "allowAll");
});

test("re-running the repair changes nothing and takes no second backup", () => {
  // The row is re-checked after the button, so "already correct" and "just repaired" have to
  // be distinguishable - and an unconditional rewrite would restamp an operator's file and
  // leave a backup per press.
  const path = configPath('{\n  "automation": {\n    "socketControlMode": "allowAll"\n  }\n}\n');
  const before = readFileSync(path, "utf8");
  const result = enableCmuxSocketControl(path);
  assert.equal(result.ok && result.outcome, "unchanged");
  assert.equal(result.ok && result.backup, null);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a machine with no cmux config yet gets one, and no backup of a file that never existed", () => {
  const path = configPath();
  const result = enableCmuxSocketControl(path);
  assert.equal(result.ok && result.outcome, "enabled");
  assert.equal(result.ok && result.backup, null);
  assert.equal(readCmuxSocketControl(readFileSync(path, "utf8")), "allowAll");
});

test("a config that will not parse is refused rather than replaced", () => {
  // Everything else in that file is the operator's, and a JSONC file that no longer parses is
  // something they need to see rather than something to overwrite on their behalf.
  const broken = '{\n  "automation": {\n';
  const path = configPath(broken);
  const result = enableCmuxSocketControl(path);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /is not valid JSON\/JSONC/);
  assert.equal(readFileSync(path, "utf8"), broken);
  // Every `.bak` in the directory, not the one name this second would produce: the write and
  // the assertion can land either side of a second boundary, and a backup taken at 10:23:32
  // would pass a check that only looked for 10:23:33.
  assert.deepEqual(
    readdirSync(dirname(path)).filter((name) => name.endsWith(".bak")),
    [],
    "a refused edit backs nothing up",
  );
});
