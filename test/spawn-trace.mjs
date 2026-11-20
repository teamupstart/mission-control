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

  /** Git's subcommand, past the global options that may precede it - and never their values. */
  const gitSubcommand = (words) => {
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(word)) {
        i++;
        continue;
      }
      if (word.startsWith("-")) continue;
      return word;
    }
    return "(none)";
  };

  /**
   * Whether the call started a process. A missing or unrunnable executable still reaches the
   * API, so the record says so rather than counting a process that never existed. Null when
   * the API cannot tell (the *Sync output forms), which the report counts as started.
   */
  const LAUNCH_FAILURES = new Set(["ENOENT", "EACCES", "ENOTDIR", "E2BIG"]);
  const launchedFrom = (outcome) => {
    if (outcome === undefined || outcome === null || typeof outcome !== "object") return null;
    if (outcome instanceof Error) return !LAUNCH_FAILURES.has(outcome.code);
    if (outcome.error) return !LAUNCH_FAILURES.has(outcome.error.code);
    if ("pid" in outcome) return typeof outcome.pid === "number" && outcome.pid > 0;
    return null;
  };

  /**
   * One spawn, recorded without its arguments: a command line can carry a credential, and the
   * report needs only the executable and, for git, the subcommand. `pid` is the child's when
   * the API hands one back, so the report can tell a node descendant its traced parent already
   * counted from one a shell started.
   */
  const record = (api, callArgs, outcome) => {
    const [command, args] = callArgs;
    const shellString = api === "exec" || api === "execSync";
    const words = shellString
      ? String(command).trim().split(/\s+/)
      : [String(api === "fork" ? process.execPath : command),
        ...(api === "fork" ? [] : Array.isArray(args) ? args.filter((a) => typeof a === "string") : [])];
    const cmd = basename(words[0] ?? "");
    write({
      event: "spawn", file, api, cmd,
      sub: cmd === "git" ? gitSubcommand(words.slice(1)) : null,
      caller: caller(),
      shell: shellString || Boolean(optionsOf(callArgs).shell),
      launched: launchedFrom(outcome),
      pid: outcome && typeof outcome === "object" && typeof outcome.pid === "number" ? outcome.pid : null,
      ppid: process.pid,
    });
  };

  // One call is one record. `exec` calls the exported `execFile`, and the promisified forms call
  // the plain ones, so only the outermost traced entry records; nested entries pass straight on.
  let depth = 0;
  for (const api of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
    const original = childProcess[api];
    const traced = function traced(...callArgs) {
      if (depth > 0) return Reflect.apply(original, this, callArgs);
      depth++;
      let result;
      try {
        result = Reflect.apply(original, this, callArgs);
      } catch (error) {
        depth--;
        // execFileSync and execSync throw for a non-zero exit too; the process still ran.
        record(api, callArgs, error);
        throw error;
      }
      depth--;
      record(api, callArgs, result);
      return result;
    };
    // `exec` and `execFile` carry a custom promisified form that resolves `{ stdout, stderr }`.
    // A wrapper without it would make `promisify(execFile)` resolve stdout alone, and the
    // original's own form calls the unwrapped function, so it is wrapped rather than copied.
    const custom = original[promisify.custom];
    if (typeof custom === "function") {
      traced[promisify.custom] = function tracedPromise(...callArgs) {
        if (depth > 0) return Reflect.apply(custom, this, callArgs);
        depth++;
        let promise;
        try {
          promise = Reflect.apply(custom, this, callArgs);
        } finally {
          depth--;
        }
        record(api, callArgs, promise.child ?? null);
        return promise;
      };
    }
    childProcess[api] = traced;
  }
  syncBuiltinESMExports();
}
