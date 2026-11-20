// Opt-in process-spawn tracer for the `node --test` suite.
//
// Endpoint security agents on developer Macs inspect every exec, so the suite's cost to a
// laptop scales with how many short-lived processes it starts rather than with how heavy
// each one is. This file makes that number measurable instead of guessed at: load it with
// an extra `--import` and point `MISSION_TEST_SPAWN_TRACE` at an empty directory, and every
// traced process appends JSON lines to `<dir>/<pid>.jsonl` - one `start` line for itself, and
// one `spawn` line per process it starts. `scripts/test-spawn-report.mjs` turns the directory
// into ranked tables and a whole-run process total; `docs/runbooks/test-process-churn.md`
// has the command.
//
// Traced processes are the test workers and every node process descended from one: a worker
// adds this file to `NODE_OPTIONS`, which a spawned daemon, script or nested runner inherits.
// The worker's test file travels as `MISSION_TEST_SPAWN_TRACE_FILE`, so a descendant's spawns
// - and git's own trace2 events - are attributed to the file that caused them.
//
// Without the variable this file does nothing, and it never changes what a spawn does: it
// records the call and forwards the original arguments untouched.

import childProcess from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";

const dir = process.env.MISSION_TEST_SPAWN_TRACE;

if (dir) {
  mkdirSync(dir, { recursive: true });
  // A worker is the first traced process in its chain: nothing above it named a file yet.
  const role = process.env.MISSION_TEST_SPAWN_TRACE_FILE ? "descendant" : "worker";
  const file = process.env.MISSION_TEST_SPAWN_TRACE_FILE
    ?? (process.argv[1] ? relative(process.cwd(), process.argv[1]) : "(unknown)");
  process.env.MISSION_TEST_SPAWN_TRACE_FILE = file;
  // Reach node descendants too. Only this file, never the state preload: a descendant that
  // was not already isolated must not become something else because it was measured.
  const preload = `--import=${import.meta.url}`;
  if (!(process.env.NODE_OPTIONS ?? "").includes(preload)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
  }
  const out = join(dir, `${process.pid}.jsonl`);
  const root = `${process.cwd()}/`;
  const self = new URL(import.meta.url).pathname;

  const write = (line) => {
    try {
      appendFileSync(out, `${JSON.stringify(line)}\n`);
    } catch {
      // A trace that cannot be written must never fail the test that spawned.
    }
  };
  write({ event: "start", role, file, pid: process.pid, ppid: process.ppid });

  // The first frame in this checkout that is not this file: `test/...` when a fixture spawned,
  // `src/...` when the code under test did. That split is what says whether a spawn is
  // incidental setup or the behavior a test exists to exercise.
  const caller = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    const stack = new Error().stack ?? "";
    Error.stackTraceLimit = limit;
    for (const match of stack.matchAll(/(?:file:\/\/)?(\/[^\s():]+):(\d+):\d+/g)) {
      const path = match[1];
      if (path === self || !path.startsWith(root) || path.includes("/node_modules/")) continue;
      // The shared runner every production spawn funnels through says nothing about why.
      if (path.endsWith("/src/server/util/exec.ts")) continue;
      return `${path.slice(root.length)}:${match[2]}`;
    }
    return "(outside the checkout)";
  };

  /** The options argument, wherever this API's overloads put it. */
  const optionsOf = (callArgs) =>
    callArgs.slice(1).find((arg) => arg !== null && typeof arg === "object" && !Array.isArray(arg)) ?? {};

  /**
   * One spawn. `pid` is the child's, when the API hands one back, so the report can tell a
   * node descendant its traced parent already counted from one a shell started. `shell` marks
   * a command run through `/bin/sh`, which is one more exec than the program it names.
   */
  const record = (api, callArgs, child) => {
    const [command, args] = callArgs;
    const shellString = api === "exec" || api === "execSync";
    const shell = shellString || Boolean(optionsOf(callArgs).shell);
    const program = api === "fork" ? process.execPath : command;
    const cmd = shellString
      ? basename(String(command).trim().split(/\s+/)[0] ?? "")
      : basename(String(program));
    const argv = shellString
      ? [String(command).slice(0, 200)]
      : (api === "fork" ? [command] : Array.isArray(args) ? args : []).filter((a) => typeof a === "string").slice(0, 8);
    write({ event: "spawn", file, api, cmd, argv, caller: caller(), shell, pid: child?.pid ?? null, ppid: process.pid });
  };

  for (const api of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const original = childProcess[api];
    const traced = function traced(...callArgs) {
      let result;
      try {
        result = Reflect.apply(original, this, callArgs);
      } catch (error) {
        // execFileSync and execSync throw for a non-zero exit; the process still ran.
        record(api, callArgs, { pid: error?.pid ?? null });
        throw error;
      }
      // A ChildProcess and a spawnSync result both carry `pid`; the *Sync output forms do not.
      record(api, callArgs, result && typeof result === "object" && "pid" in result ? result : null);
      return result;
    };
    // `exec` and `execFile` carry a custom promisified form that resolves `{ stdout, stderr }`.
    // A wrapper without it would make `promisify(execFile)` resolve stdout alone, and the
    // original's own form calls the unwrapped function, so it is wrapped rather than copied.
    const custom = original[promisify.custom];
    if (typeof custom === "function") {
      traced[promisify.custom] = function tracedPromise(...callArgs) {
        const promise = Reflect.apply(custom, this, callArgs);
        record(api, callArgs, promise.child ?? null);
        return promise;
      };
    }
    childProcess[api] = traced;
  }
  syncBuiltinESMExports();
}
