import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

/** Run `source` under the tracer in a fresh node, return its records and the report's JSON. */
function traced(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "mission-spawn-trace-"));
  const script = join(dir, "probe.mjs");
  writeFileSync(script, source);
  const trace = join(dir, "trace");
  mkdirSync(join(trace, "trace2"), { recursive: true });
  // Without an inherited test file, the probe is a worker of its own.
  const env: NodeJS.ProcessEnv = { ...process.env, MISSION_TEST_SPAWN_TRACE: trace };
  delete env.MISSION_TEST_SPAWN_TRACE_FILE;
  execFileSync(process.execPath, ["--import", join(root, "test/spawn-trace.mjs"), script], { env, stdio: "pipe" });
  const records = readdirSync(trace).filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(trace, name), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
  const report = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/test-spawn-report.mjs"), trace, "--json"], { encoding: "utf8" }));
  rmSync(dir, { recursive: true, force: true });
  return { spawns: records.filter((record) => record.event === "spawn"), report };
}

test("one traced call is one record, however the API is reached", () => {
  // `exec` calls the exported `execFile`, and the promisified forms call the plain ones.
  const { spawns } = traced(`
    import cp from "node:child_process";
    import { promisify } from "node:util";
    await new Promise((done) => cp.exec("true", done));
    await promisify(cp.exec)("true");
    await promisify(cp.execFile)("true");
    cp.execSync("true");
    cp.execFileSync("true");
  `);
  assert.deepEqual(spawns.map((spawn) => spawn.api), ["exec", "exec", "execFile", "execSync", "execFileSync"]);
});

test("records carry the executable and git subcommand, never the arguments", () => {
  const { spawns } = traced(`
    import cp from "node:child_process";
    cp.spawnSync("git", ["-c", "http.extraHeader=Authorization: Bearer secret-token", "--version"]);
    cp.spawnSync("git", ["-C", "/nonexistent-secret-path", "-c", "core.editor=true", "status"]);
    cp.execSync("echo secret-token");
  `);
  const text = JSON.stringify(spawns);
  for (const secret of ["secret-token", "extraHeader", "nonexistent-secret-path", "core.editor"]) {
    assert.ok(!text.includes(secret), `${secret} reached the trace: ${text}`);
  }
  assert.deepEqual(spawns.map((spawn) => [spawn.cmd, spawn.sub]), [["git", "(none)"], ["git", "status"], ["echo", null]]);
});

test("a launch that starts no process is recorded as such and left out of the total", () => {
  const { spawns, report } = traced(`
    import cp from "node:child_process";
    cp.spawnSync("definitely-missing-binary-for-the-tracer");
    try { cp.execFileSync("definitely-missing-binary-for-the-tracer"); } catch {}
    cp.spawnSync("true");
  `);
  assert.deepEqual(spawns.map((spawn) => spawn.launched), [false, false, true]);
  assert.equal(report.failedLaunches, 2);
  assert.equal(report.directSpawns, 1);
  // The probe's own node is the one worker; its one real spawn is the only other process.
  assert.equal(report.processTotal, 2);
});
