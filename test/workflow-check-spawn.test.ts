import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnCheckProcess } from "../src/server/workflows/check-spawn.ts";
import { checkGroupAnswers } from "../src/server/workflows/check-group.ts";
import { onPath } from "../src/server/util/exec.ts";

// The streaming adapter, against REAL short-lived processes and no mocks.
//
// Every case here is about a claim the buffered `run()` helper cannot make: an exact count of
// dropped bytes, a tail rather than a head, stdout and stderr interleaved in arrival order, and
// a missing executable told apart from a command that ran and failed.

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mission-check-spawn-"));
  dirs.push(dir);
  return dir;
}

/**
 * Every supervisor this file created, so the suite can PROVE it left nothing behind.
 *
 * The merge criterion is "no orphan process survives the suite - assert it, do not eyeball
 * it", and a check runtime that leaks a process group is the failure that costs a pooled
 * worktree. `ps` by hand would not have caught it.
 */
const supervisors: number[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  const leaked = supervisors.filter((pid) => checkGroupAnswers(pid));
  assert.deepEqual(leaked, [], "these check process groups outlived the suite");
});

const NODE = process.execPath;

async function run(
  command: readonly string[],
  over: { cwd?: string; timeoutMs?: number; maxOutputBytes?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Awaited<ReturnType<typeof spawnCheckProcess>>> {
  const outcome = await spawnCheckProcess({
    attemptId: `attempt-${supervisors.length}-${command[0]}`,
    command,
    cwd: over.cwd ?? process.cwd(),
    env: over.env ?? { PATH: process.env.PATH ?? "" },
    timeoutMs: over.timeoutMs ?? 20_000,
    maxOutputBytes: over.maxOutputBytes,
  });
  if (outcome.supervisor) supervisors.push(outcome.supervisor.pid);
  return outcome;
}

test("a command that exits 0 reports its output", async () => {
  const { result, emptiness } = await run(["sh", "-c", "echo hello"]);
  assert.deepEqual(result, { kind: "exited", exitCode: 0, output: "hello\n", truncatedBytes: 0 });
  // Proven, not assumed: the group is confirmed gone before this returns.
  assert.equal(emptiness, "empty");
});

test("a non-zero exit is `exited`, not a failure of the runtime", async () => {
  const { result } = await run(["sh", "-c", "echo nope 1>&2; exit 7"]);
  assert.deepEqual(result, { kind: "exited", exitCode: 7, output: "nope\n", truncatedBytes: 0 });
});

test("stdout and stderr share one ring, in arrival order", async () => {
  // The sleeps are what make this an assertion rather than a coin toss: without them both
  // pipes can hold data at the moment the parent is scheduled, and which one is drained first
  // says nothing about which was written first.
  const { result } = await run([
    "sh",
    "-c",
    "echo one; sleep 0.05; echo two 1>&2; sleep 0.05; echo three",
  ]);
  assert.equal(result.kind, "exited");
  assert.equal(result.kind === "exited" && result.output, "one\ntwo\nthree\n");
});

test("the tail is kept and truncatedBytes is EXACT against a known byte count", async () => {
  const total = 5_000;
  const keep = 1_000;
  const { result } = await run(
    [NODE, "-e", `process.stdout.write("x".repeat(${total - 1}) + "Z")`],
    { maxOutputBytes: keep },
  );
  assert.equal(result.kind, "exited");
  if (result.kind !== "exited") return;
  assert.equal(Buffer.byteLength(result.output), keep);
  assert.equal(result.truncatedBytes, total - keep);
  assert.equal(
    Buffer.byteLength(result.output) + result.truncatedBytes,
    total,
    "kept plus dropped must equal every byte the command wrote",
  );
  // Tail-biased, so the LAST byte is the one that survived. A head-biased clip of a build log
  // is four kilobytes of dependency resolution.
  assert.equal(result.output.endsWith("Z"), true);
});

test("a multi-byte character straddling the cut costs its bytes, and is not mangled", async () => {
  // 1,000 x U+00E9 is 2,000 bytes. Retaining 1,001 lands the cut inside a character, so the
  // ring advances past the continuation byte - and counts it as dropped, which it is.
  const { result } = await run([NODE, "-e", `process.stdout.write("\\u00e9".repeat(1000))`], {
    maxOutputBytes: 1_001,
  });
  assert.equal(result.kind, "exited");
  if (result.kind !== "exited") return;
  assert.equal(result.output, "é".repeat(500));
  assert.equal(result.truncatedBytes, 1_000);
  assert.equal(Buffer.byteLength(result.output) + result.truncatedBytes, 2_000);
  assert.equal(result.output.includes("�"), false, "no replacement character at the cut");
});

test("a missing executable is `unavailable`, and nothing else here is", async () => {
  const { result } = await run(["mission-control-no-such-binary"]);
  assert.equal(result.kind, "unavailable");
  assert.match(result.kind === "unavailable" ? result.note : "", /was not found/);
});

test("a relative ./script in the working directory is found - the onPath trap", async () => {
  const dir = workspace();
  writeFileSync(join(dir, "check"), "#!/bin/sh\necho ran-relative\n");
  chmodSync(join(dir, "check"), 0o755);

  // The trap itself, asserted rather than described: `onPath` answers this question against
  // the DAEMON's cwd, so it calls a script that plainly exists "missing". Anything that
  // prechecked a check command with it would refuse to run `./scripts/check` and
  // `node_modules/.bin/tsc` in every repository on the machine.
  assert.equal(onPath("./check"), false, "onPath resolves relative names against the wrong directory");

  const { result } = await run(["./check"], { cwd: dir });
  assert.deepEqual(result, {
    kind: "exited",
    exitCode: 0,
    output: "ran-relative\n",
    truncatedBytes: 0,
  });
});

test("a timeout is infrastructure, never a non-zero exit", async () => {
  const { result, emptiness } = await run(["sh", "-c", "sleep 30"], { timeoutMs: 400 });
  assert.equal(result.kind, "infrastructure");
  assert.match(result.kind === "infrastructure" ? result.reason : "", /did not finish within 400ms/);
  // And the tree is provably safe to hand back afterwards.
  assert.equal(emptiness, "empty");
});

test("a command killed by a signal is infrastructure, never a fail", async () => {
  const { result } = await run([NODE, "-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.equal(result.kind, "infrastructure");
  assert.match(result.kind === "infrastructure" ? result.reason : "", /killed by SIGKILL/);
});

test("shell: false - metacharacters are literal arguments, not syntax", async () => {
  const args = ["a;b", "$(id -u)", "x && y", "`whoami`", "*", "|", ">out.txt"];
  const { result } = await run([
    NODE,
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    ...args,
  ]);
  assert.equal(result.kind, "exited");
  // If any shell were involved, `$(id -u)` would be a number and `*` would be a file listing.
  assert.deepEqual(JSON.parse(result.kind === "exited" ? result.output : "[]"), args);
});

test("the command inherits the handed environment and nothing of the daemon's", async () => {
  process.env.MISSION_CHECK_SPAWN_SENTINEL = "the daemon's own environment";
  try {
    const { result } = await run(
      [NODE, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))"],
      { env: { PATH: process.env.PATH ?? "", KEPT: "1" } },
    );
    assert.equal(result.kind, "exited");
    const seen = JSON.parse(result.kind === "exited" ? result.output : "[]") as string[];
    // `__CF_USER_TEXT_ENCODING` is added by CoreFoundation to every process macOS starts, so
    // "exactly the handed set" is not a claim any spawn on this platform can make. Filtering
    // it names the platform quirk rather than weakening the assertion to a subset check.
    assert.deepEqual(seen.filter((name) => !name.startsWith("__CF")), ["KEPT", "PATH"]);
    assert.equal(
      seen.includes("MISSION_CHECK_SPAWN_SENTINEL"),
      false,
      "the child gets what it was handed, not what the daemon happens to be carrying",
    );
  } finally {
    delete process.env.MISSION_CHECK_SPAWN_SENTINEL;
  }
});

test("stdin is closed, so a command that reads it fails rather than hanging", async () => {
  const { result } = await run([
    NODE,
    "-e",
    "const b=require('node:fs').readFileSync(0,'utf8'); process.stdout.write('read:'+JSON.stringify(b))",
  ]);
  // The point is that it ANSWERS - quickly - instead of blocking until the timeout.
  assert.equal(result.kind, "exited");
  assert.equal(result.kind === "exited" && result.output, 'read:""');
});

/**
 * Every process whose command line carries this attempt id.
 *
 * The attempt id is in the supervisor's argv so that ITS identity is unique, and that makes it
 * the one reliable way a test can ask "is a supervisor of mine still out there" without being
 * handed a pid. `-ww` because macOS otherwise clips the line, and the id sits after the shim's
 * own source in the argv.
 */
function processesCarrying(attemptId: string): string[] {
  const out = execFileSync("ps", ["-ww", "-eo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\n").filter((line) => line.includes(attemptId));
}

test("a timeout before the supervisor is ready leaves no held shim behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-check-spawn-"));
  dirs.push(dir);
  const marker = join(dir, "branch-ran");
  const attemptId = `attempt-early-timeout-${process.pid}`;

  // 1ms: the run timer fires long before `node` can start and report readiness, so the gate is
  // still HELD when the command's own timeout expires. That path has no process group to tear
  // down - nothing was released - so it has to abort the shim directly. Getting this wrong
  // returns a tidy-looking `empty` while leaving a detached supervisor waiting on its gate
  // forever, registered with nothing and owned by nobody.
  const outcome = await spawnCheckProcess({
    attemptId,
    command: ["sh", "-c", 'touch "$1"', "sh", marker],
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: 1,
  });

  assert.equal(outcome.result.kind, "infrastructure");
  assert.equal(outcome.supervisor, null, "the gate never opened, so there is no owner to report");
  assert.equal(existsSync(marker), false, "and no branch code may run");
  assert.deepEqual(
    processesCarrying(attemptId),
    [],
    "a supervisor was left holding its gate after the call returned",
  );
});

test("an unusable working directory is infrastructure, not a missing executable", async () => {
  // The distinction the shim buys: a bad cwd fails the SUPERVISOR's spawn, while a missing
  // command fails the shim's. Spawned directly, both arrive as ENOENT and a missing directory
  // would be reported to the operator as a command they never mistyped.
  const { result, supervisor } = await run(["sh", "-c", "echo hi"], {
    cwd: join(tmpdir(), "mission-check-spawn-does-not-exist"),
  });
  assert.equal(result.kind, "infrastructure");
  assert.equal(supervisor, null, "nothing ran, so there is no owner to record");
});
