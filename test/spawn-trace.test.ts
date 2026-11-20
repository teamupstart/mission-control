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

test("a shell line is never split into a subcommand, and a leading assignment is not kept", () => {
  // A whitespace split ignores quoting, so it would hand `secret-token"` back as git's subcommand.
  const { spawns } = traced(`
    import cp from "node:child_process";
    cp.execSync('git -c "http.extraHeader=Authorization: secret-token" --version');
    cp.execSync("SECRET_VALUE=secret-token true");
    // \`shell: true\` makes Node join the command and arguments into the same kind of line.
    cp.spawnSync("SECRET_VALUE=secret-token true", { shell: true });
    cp.execFileSync("SECRET_VALUE=secret-token", ["true"], { shell: true });
  `);
  const text = JSON.stringify(spawns);
  assert.ok(!text.includes("secret-token") && !text.includes("SECRET_VALUE"), text);
  assert.deepEqual(spawns.map((spawn) => [spawn.cmd, spawn.sub]), [["git", null], ["(shell)", null], ["(shell)", null], ["(shell)", null]]);
});

test("a compound shell line around git counts its shell; a lone command does not", () => {
  const { spawns, report } = traced(`
    import cp from "node:child_process";
    cp.execSync("git --version > /dev/null && git --version > /dev/null");
    cp.execSync("git --version");
  `);
  assert.deepEqual(spawns.map((spawn) => spawn.compound), [true, false]);
  // No trace2 here, so git processes are 0: the worker plus the one shell that stayed alive.
  assert.equal(report.processTotalParts.shellsAroundGitLines, 1);
  assert.equal(report.processTotal, 2);
});

test("a shell line that execs git is git's one process, not a shell beside it", () => {
  // `exec` replaces the shell with git, so trace2's count of that git is the whole of it.
  const { spawns, report } = traced(`
    import cp from "node:child_process";
    cp.execSync("exec git --version");
  `);
  assert.deepEqual(spawns.map((spawn) => spawn.cmd), ["git"]);
  assert.equal(report.processTotalParts.nonGitSpawns, 0);
});

test("the report labels a shell git started by its git command, never by the child's text", () => {
  const trace = mkdtempSync(join(tmpdir(), "mission-spawn-report-"));
  try {
    mkdirSync(join(trace, "trace2"));
    writeFileSync(join(trace, "1.jsonl"), `${JSON.stringify({ event: "start", role: "worker", file: "t", pid: 1, ppid: 0 })}\n`);
    writeFileSync(join(trace, "trace2", "a"), [
      { event: "start", argv: ["/usr/bin/git", "fetch"] },
      { event: "cmd_name", name: "fetch" },
      { event: "child_start", use_shell: true, argv: ["SECRET_TOKEN=secret-in-child some-helper 'arg'"] },
    ].map((event) => JSON.stringify(event)).join("\n"));
    const output = execFileSync(process.execPath, [join(root, "scripts/test-spawn-report.mjs"), trace], { encoding: "utf8" });
    const report = JSON.parse(execFileSync(process.execPath, [join(root, "scripts/test-spawn-report.mjs"), trace, "--json"], { encoding: "utf8" }));
    for (const text of [output, JSON.stringify(report)]) {
      assert.ok(!text.includes("secret-in-child") && !text.includes("SECRET_TOKEN"), text);
    }
    assert.deepEqual(report.shellsStartedByGitFor, [["sh -c from git fetch", 1]]);
  } finally {
    rmSync(trace, { recursive: true, force: true });
  }
});

test("a call Node rejects before spawning is not a launch", () => {
  const { spawns, report } = traced(`
    import cp from "node:child_process";
    try { cp.spawnSync(""); } catch {}
  `);
  assert.deepEqual(spawns.map((spawn) => spawn.launched), [false]);
  assert.equal(report.failedLaunches, 1);
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
