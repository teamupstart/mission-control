import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import type { Socket } from "node:net";
import { WORKFLOW_EXECUTION_LIMITS } from "@shared/workflow.ts";
import type { CheckExecutionResult } from "./checks.ts";
import {
  terminateCheckGroup,
  unwatchCheckGroup,
  watchCheckGroup,
  type CheckGroupEmptiness,
  type CheckGroupTeardownOptions,
} from "./check-group.ts";
import { processStartIdentity } from "./check-identity.ts";

// Running branch-authored code: the streaming adapter, and the gate that makes its owner
// durable before it is allowed to start.
//
// **This is the only `spawn` under `src/server/workflows/`, deliberately.** A second one would
// be a second set of answers to "what is a timeout", "what counts as unavailable" and "who
// tears the group down", and the third of those is the one that leaks pooled worktrees.
//
// ## Why `run()` cannot serve this
//
// `util/exec.ts`'s `run` is `execFile`-based: it buffers from the first byte and kills the
// child when `maxBuffer` is exceeded. A check needs the OPPOSITE of both - the last few
// kilobytes of a 40,000-line build log, and an exact count of what was dropped, with the
// command left running. `run` stays correct for the short, bounded lease and status commands.
//
// ## Why `onPath()` must not be used to precheck a check command
//
// `onPath(bin)` answers `existsSync(bin)` for any name containing a slash, relative to the
// DAEMON's cwd - not to the leased checkout. So `./scripts/check` and `node_modules/.bin/tsc`
// would be reported missing while being perfectly present in the tree the command actually
// runs in. The spawn's own `ENOENT` is the single authority here, and it is raised by the
// shim, whose cwd IS the checkout.

/** The identity of one supervisor: what gets persisted, and what every later signal checks. */
export interface CheckSupervisorIdentity {
  pid: number;
  /** Opaque composite from `processStartIdentity`. Compared, never parsed. */
  identity: string;
}

export interface CheckSpawnRequest {
  /**
   * The attempt this check belongs to. Passed to the shim as an argument so the supervisor's
   * COMMAND LINE is unique to one attempt - the half of the start identity that a whole-second
   * timestamp cannot supply on its own. It is not decoration and not for logging.
   */
  attemptId: string;
  /** argv, never a shell string, spawned with `shell: false`. */
  command: readonly string[];
  /** The leased checkout joined with the command's working subpath. */
  cwd: string;
  /** Already scrubbed - see `check-env.ts`. This module does not decide what a check may see. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Defaults to `WORKFLOW_EXECUTION_LIMITS.checkOutput`; there is no second output bound. */
  maxOutputBytes?: number;
  /** How long the shim gets to report readiness before the attempt is abandoned. */
  readyMs?: number;
  teardown?: CheckGroupTeardownOptions;
  /**
   * THE GATE. Runs after the supervisor's identity is readable and BEFORE branch code is
   * allowed to run, and it must be synchronous - there is deliberately no `await` between it
   * and the byte that releases the command, so no crash can land in between.
   *
   * Throwing closes the gate and terminates the supervisor without ever starting branch code.
   * Its one production caller persists identity, which is what makes "crashed between spawn
   * and durable identity" unreachable rather than merely unlikely.
   */
  onSupervisorReady?: (supervisor: CheckSupervisorIdentity) => void;
}

export interface CheckSpawnOutcome {
  /** The published three-variant result. Contract E; this module produces no fourth. */
  result: CheckExecutionResult;
  /**
   * What could be PROVEN about the command's process group when this returned. Only `empty`
   * authorises returning the leased worktree - leader exit is not emptiness.
   */
  emptiness: CheckGroupEmptiness;
  /** Null when the gate was never released, which is proof that no branch code ran. */
  supervisor: CheckSupervisorIdentity | null;
}

/** How long the shim gets to say "ready". Generous: it is one `node` start, nothing else. */
const DEFAULT_READY_MS = 30_000;

/**
 * The trusted shim, held in argv rather than written to disk.
 *
 * ## What it is for
 *
 * The ordering invariant this whole module exists to keep is *persist the owner, THEN let
 * branch code run*. A plain `spawn` cannot do that: the command is already running by the time
 * the pid comes back. So the supervisor starts with the command HELD - it reports readiness,
 * waits for one byte, and only then launches the configured argv.
 *
 * ## Two load-bearing properties
 *
 * **It forks and waits; it must never `exec`.** An `exec` replaces the process image, so the
 * pid survives but the command line becomes the branch command - and the command line is half
 * of the start identity. Every later identity read would mismatch on a group that is very much
 * alive, correctly refuse to signal it, and strand its lease forever with a live process still
 * writing into the tree. The same `exec` would also hand group leadership to the build, which
 * breaks the emptiness proof independently. Forking costs one extra process in the group and
 * buys a leader whose identity is stable from spawn to teardown.
 *
 * **Its argv carries the attempt id.** That is what makes the command-line half unique. The
 * two requirements are one design: the id has to be in the argv, and the argv has to survive.
 *
 * ## Why `-e` and not a file
 *
 * No temp file, and no build-time artifact either. A shim shipped as its own `.mjs` would have
 * to survive `esbuild --bundle` into `dist/`, an Electron package, and a `tsx` dev run, and a
 * path that resolves in two of those three fails at the moment a check runs rather than at
 * build time. In argv it is present wherever the daemon is.
 *
 * Written in plain CommonJS ES5-ish JavaScript because it runs under `node -e` with no loader,
 * and with no backslash escapes at all - it lives inside a template literal, where an escape
 * means something to the OUTER file first.
 */
const SHIM = `
const net = require("node:net");
const cp = require("node:child_process");
const NL = String.fromCharCode(10);
// process.argv[1] is the attempt id. It is never read: it is here so this process's command
// line is unique to one attempt, which is half of its start identity.
const argv = process.argv.slice(2);
const gate = new net.Socket({ fd: 3 });
const report = new net.Socket({ fd: 4 });
gate.on("error", function () {});
report.on("error", function () {});
let released = false;
function say(o) {
  try { report.write(JSON.stringify(o) + NL); } catch (e) {}
}
function bye(code) {
  try { report.end(function () { process.exit(code); }); } catch (e) { process.exit(code); }
}
gate.on("data", function () {
  if (released) return;
  released = true;
  gate.destroy();
  // The marker that let US run as node is not the build's business, and passing it on would
  // make every node the build spawns behave as an Electron-in-node-mode process.
  delete process.env.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    child = cp.spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "inherit", "inherit"],
      shell: false,
    });
  } catch (e) {
    say({ spawnError: { code: e && e.code, message: String((e && e.message) || e) } });
    bye(127);
    return;
  }
  child.on("error", function (e) {
    say({ spawnError: { code: e && e.code, message: String((e && e.message) || e) } });
    bye(127);
  });
  child.on("exit", function (code, signal) {
    say({ exit: code === undefined ? null : code, signal: signal || null });
    bye(code === null || code === undefined ? 128 : code);
  });
});
// The gate closing without a byte means the owner could not be persisted. Exit without ever
// having started branch code, which is what leaves the durable row carrying its sentinel.
gate.on("close", function () { if (!released) process.exit(0); });
report.write("R" + NL);
`;

/** What the shim says back, on the report channel. */
interface ShimReport {
  spawnError?: { code?: string; message?: string };
  exit?: number | null;
  signal?: string | null;
}

/**
 * The runtime that runs the shim.
 *
 * Same problem `mission-mcp.ts` solves for launching the bundled MCP server, and the same
 * answer, minus its `which node` step: that exists because an EXTERNAL agent needs a concrete
 * runtime it can record in a config file, whereas this process only has to launch a child of
 * its own. `process.execPath` is always right and always present; under Electron it is the app
 * binary, which behaves as node when `ELECTRON_RUN_AS_NODE` is set.
 */
function shimRuntime(): { command: string; env: NodeJS.ProcessEnv } {
  if (/^node(\.exe)?$/.test(basename(process.execPath))) {
    return { command: process.execPath, env: {} };
  }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/**
 * The bounded, tail-biased output ring - ONE ring shared by stdout and stderr, so interleaving
 * survives in the order it arrived rather than in the order the two streams happened to be
 * drained.
 *
 * ## It works in bytes, not in decoded text, and that is what makes the count exact
 *
 * The obvious shape is `setEncoding("utf8")` on both streams and a string ring, which is what
 * the model-subprocess precedents do and is right for THEIR problem (one decode, no
 * replacement characters at chunk boundaries). It cannot answer this one. `truncatedBytes` is
 * specified as an exact count of bytes the command wrote and we dropped, and a decoded ring
 * can only count the bytes of its own decoding - so a build that emits one invalid byte
 * (a binary fixture, a terminal escape sequence, a truncated UTF-8 tail) reports a number
 * three times larger than the truth, silently.
 *
 * Counting raw bytes and decoding ONCE at the end gives both properties: the count is exact by
 * construction, and the multi-byte character that straddles a chunk boundary decodes correctly
 * because the boundary is interior to the retained buffer by the time anything decodes it. The
 * only new edge is the FRONT of the retained tail, which a byte-exact cut can land in the
 * middle of a character - handled by advancing past the continuation bytes, and those bytes
 * are then counted as dropped, which they are.
 */
class TailRing {
  private buf = Buffer.alloc(0);
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.maxBytes <= 0) return;
    const joined = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    // Copied rather than kept as a view: a stream chunk is a slice of a pooled 64KB buffer,
    // and holding a view of one pins the whole pool for the life of the check.
    this.buf =
      joined.length <= this.maxBytes
        ? Buffer.from(joined)
        : Buffer.from(joined.subarray(joined.length - this.maxBytes));
  }

  read(): { text: string; truncatedBytes: number } {
    let start = 0;
    if (this.total > this.buf.length) {
      // Only when something WAS dropped. Otherwise a stream whose very first byte is invalid
      // UTF-8 would lose bytes that were never truncated, and the count would stop being exact
      // in the one case it is trivially exact.
      while (start < this.buf.length && (this.buf[start]! & 0xc0) === 0x80) start += 1;
    }
    const kept = this.buf.subarray(start);
    return { text: kept.toString("utf8"), truncatedBytes: this.total - kept.length };
  }
}

function infrastructure(reason: string): CheckExecutionResult {
  return { kind: "infrastructure", reason };
}

/**
 * Run one check command under a gated supervisor and report what it did.
 *
 * The sequence, and every step of it is load-bearing:
 *
 *  1. Spawn the shim `detached: true`, so it is its own process-group leader, with the
 *     configured command HELD.
 *  2. Wait for the shim to say it is ready. Only now is it certain that the process at this
 *     pid is our shim rather than a runtime that failed to start.
 *  3. Read `processStartIdentity(pid)`. Unreadable is fatal to this attempt: we will not start
 *     something we could not later prove is dead.
 *  4. Call `onSupervisorReady` - synchronously, the persist step.
 *  5. Release the gate. Steps 3 to 5 contain no `await`, which is what removes the window in
 *     which branch code could be running with no durable owner.
 *
 * A failure anywhere in 2 to 4 closes the gate and kills the shim. Because the gate was never
 * released, nothing branch-authored ever ran, and `supervisor` comes back null to say so.
 */
export async function spawnCheckProcess(request: CheckSpawnRequest): Promise<CheckSpawnOutcome> {
  const maxOutputBytes = request.maxOutputBytes ?? WORKFLOW_EXECUTION_LIMITS.checkOutput;
  const ring = new TailRing(maxOutputBytes);
  const runtime = shimRuntime();
  const argv = [
    "-e",
    SHIM,
    request.attemptId,
    ...request.command,
  ];

  let child: ChildProcess;
  try {
    child = spawn(runtime.command, argv, {
      cwd: request.cwd,
      env: { ...request.env, ...runtime.env },
      shell: false,
      // Its own process group, which is what makes a single signal reach the descendants a
      // build spawns - and what makes the emptiness proof a question about a group rather
      // than about one process.
      detached: true,
      // stdin is IGNORED rather than piped: a command that blocks on input should fail
      // immediately on a closed stdin instead of hanging until the timeout. fds 3 and 4 are
      // the control channel - 3 is the gate the parent writes one byte to, 4 is how the shim
      // reports readiness and the command's outcome. Two fds rather than one duplex socket so
      // each direction's EOF means exactly one thing.
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    // Thrown rather than emitted: an argv the kernel refuses outright. Nothing ran.
    return {
      result: infrastructure(
        `the check supervisor could not be started: ${err instanceof Error ? err.message : String(err)}`,
      ),
      emptiness: "empty",
      supervisor: null,
    };
  }

  const gate = child.stdio[3] as Socket;
  const report = child.stdio[4] as Socket;
  gate.on("error", () => {});
  report.on("error", () => {});
  child.stdout?.on("data", (chunk: Buffer) => ring.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => ring.push(chunk));

  let supervisor: CheckSupervisorIdentity | null = null;
  let failure: CheckExecutionResult | null = null;
  let shimReport: ShimReport | null = null;
  let teardown: Promise<CheckGroupEmptiness> | null = null;
  let settled = false;
  let resolveSettled: () => void = () => {};
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(readyTimer);
    clearTimeout(runTimer);
    resolveSettled();
  };

  /** The teardown ladder, run exactly once however many paths ask for it. */
  const tearDown = (): Promise<CheckGroupEmptiness> => {
    if (!supervisor) return Promise.resolve<CheckGroupEmptiness>("empty");
    return (teardown ??= terminateCheckGroup(
      supervisor.pid,
      supervisor.identity,
      request.teardown,
    ));
  };

  /**
   * Abandon before the gate was ever released.
   *
   * `child.kill` on the handle rather than a group signal: this pid cannot have been recycled
   * (we hold an unreaped child), and because the gate never opened there is nothing else in
   * the group to reach.
   */
  const abortBeforeRelease = (reason: string): void => {
    failure ??= infrastructure(reason);
    gate.destroy();
    child.kill("SIGKILL");
  };

  const readyTimer = setTimeout(() => {
    abortBeforeRelease(
      `the check supervisor did not start within ${request.readyMs ?? DEFAULT_READY_MS}ms`,
    );
  }, request.readyMs ?? DEFAULT_READY_MS);
  readyTimer.unref?.();

  const runTimer = setTimeout(() => {
    // A timeout is INFRASTRUCTURE, never a fail. The command never reported its own exit, so
    // this says nothing about the submission - the same conclusion `RunResult.outcomeUnknown`
    // draws for the buffered runner.
    failure ??= infrastructure(
      `the check command did not finish within ${request.timeoutMs}ms and its process group was terminated`,
    );
    // Drive the group down now rather than waiting for a close that a hung build will never
    // send. The same promise is awaited below, so the ladder runs once.
    void tearDown().then(settle, settle);
  }, request.timeoutMs);
  runTimer.unref?.();

  child.on("error", (err) => {
    // A spawn failure of the RUNTIME or an unusable cwd - never the configured command, which
    // is spawned by the shim and reports through the channel below. Keeping the two apart is
    // what stops a missing working directory from being reported as a missing executable.
    failure ??= infrastructure(`the check supervisor could not be started: ${err.message}`);
  });

  let pending = "";
  report.setEncoding("utf8");
  report.on("data", (text: string) => {
    pending += text;
    let cut = pending.indexOf("\n");
    while (cut >= 0) {
      const line = pending.slice(0, cut);
      pending = pending.slice(cut + 1);
      onReportLine(line);
      cut = pending.indexOf("\n");
    }
  });

  function onReportLine(line: string): void {
    if (line === "R") {
      onReady();
      return;
    }
    if (!line) return;
    try {
      shimReport = JSON.parse(line) as ShimReport;
    } catch {
      failure ??= infrastructure("the check supervisor sent an unreadable report");
    }
  }

  /**
   * Steps 3 to 5. Synchronous from here to the released byte, on purpose.
   */
  function onReady(): void {
    if (supervisor || settled) return;
    clearTimeout(readyTimer);
    const pid = child.pid;
    if (pid === undefined) {
      abortBeforeRelease("the check supervisor reported ready without a pid");
      return;
    }
    const identity = processStartIdentity(pid);
    if (identity === null) {
      abortBeforeRelease(
        "the check supervisor's process start identity could not be read, so it could not be " +
          "proven dead afterwards and no command was started",
      );
      return;
    }
    const ready: CheckSupervisorIdentity = { pid, identity };
    try {
      request.onSupervisorReady?.(ready);
    } catch (err) {
      abortBeforeRelease(
        "the check supervisor's identity could not be persisted, so no command was started: " +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    // Only now is there a durable owner, and only now may branch code run.
    supervisor = ready;
    watchCheckGroup(pid, identity);
    gate.write("G");
  }

  /**
   * Assemble the outcome.
   *
   * A function rather than inline code because the three values it reads are `let`s assigned
   * from callbacks, and TypeScript's control-flow analysis stops following them at the point
   * they are captured - inline, it would still believe every one of them is its initial
   * `null`. Across a function boundary it uses their declared types, which are the true ones.
   */
  function finish(emptiness: CheckGroupEmptiness): CheckSpawnOutcome {
    if (supervisor) unwatchCheckGroup(supervisor.pid);
    return { result: failure ?? resultFrom(shimReport, ring), emptiness, supervisor };
  }

  child.on("close", settle);
  await settledPromise;
  return finish(await tearDown());
}

function resultFrom(report: ShimReport | null, ring: TailRing): CheckExecutionResult {
  const { text, truncatedBytes } = ring.read();
  if (!report) {
    return infrastructure("the check supervisor exited without reporting the command's outcome");
  }
  if (report.spawnError) {
    const { code, message } = report.spawnError;
    // ENOENT is the ONE thing that produces `unavailable` here, and it is the spawn's own
    // answer rather than a filesystem guess made from the wrong directory. Everything else -
    // EACCES on a file that is not executable, a runtime refusal - is infrastructure, because
    // "unavailable" is a claim about the operator's settings and only a missing executable
    // supports it.
    if (code === "ENOENT") {
      return {
        kind: "unavailable",
        note: "The configured command was not found in this repository or on PATH, so the gate was recorded and passed.",
      };
    }
    return infrastructure(`the check command could not be started: ${message ?? code ?? "unknown"}`);
  }
  if (report.signal) {
    // Killed rather than exited: an out-of-memory kill, an operator's `pkill`, our own
    // teardown. The command never reported its own outcome, so this is never a fail verdict.
    return infrastructure(`the check command was killed by ${report.signal}`);
  }
  if (typeof report.exit !== "number") {
    return infrastructure("the check command ended without an exit code");
  }
  return { kind: "exited", exitCode: report.exit, output: text, truncatedBytes };
}
