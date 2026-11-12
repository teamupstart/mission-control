import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { matchesGlob } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { WorktreeClaim } from "@shared/protocol.ts";
import { WORKFLOW_EXECUTION_LIMITS } from "@shared/workflow.ts";
import type { WorktreeClaimVariableSource, WorktreeClaimVariableView } from "@shared/worktrees.ts";
import { readToken } from "../../shared/harness-runtime.mjs";
import { cleanupAgentSubprocessEnv } from "../agent-subprocess-env.ts";
import { executableLocator, loginShellVariables } from "../executables/locator.ts";
import { run } from "../util/exec.ts";
import { scrubCheckEnv } from "../workflows/check-env.ts";
import { TailRing } from "../workflows/check-spawn.ts";
import type { GitResult } from "./git.ts";
import { trackOwnWorktreeProcess } from "./own-processes.ts";
import type { WorktreeOwner } from "./manager.ts";

// The dependency claim: a pool's ordered dependency steps, run inside a task or check lease after reset
// or add and setup, and before the final proof, so a leased slot has dependencies for the
// commit it was leased at.
//
// Three things live here, and the manager composes them:
//
//  - the step ENVIRONMENT: the scrubbed check base plus only the variables a step names;
//  - the FINGERPRINT that lets a slot whose dependencies already match skip the steps;
//  - the step RUNNER, with its bounded tail and its process-group timeout, and the registry
//    of claims running right now.
//
// Like a check, a claim step is not sandboxed. It runs operator-authored argv with the daemon's
// own filesystem authority. What the environment rule buys is narrower and stated exactly: a
// credential reaches only the step that names it, and never the setup command or a check by
// accident.

/**
 * `SIGKILL` the child's process group, falling back to the child alone. Never throws. The
 * child was spawned `detached`, so it leads its own group and a negative pid reaches its
 * descendants too.
 */
export function killProcessGroup(child: Pick<ChildProcess, "pid" | "kill">): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child is already gone, which is the state this wanted.
    }
  }
}

/** Grace between SIGTERM and SIGKILL when a step's process group is torn down. */
const KILL_GRACE_MS = 5_000;
/** How long to wait for the pipes to close after SIGKILL, so a stuck pipe cannot hang a claim. */
const DRAIN_MS = 5_000;
/** Bound on the failure text persisted on the slot row and shown to the agent. */
const MAX_FAILURE_BYTES = 6_000;
/** Bound on the failing command as rendered into a prompt or a failure record. */
const MAX_RENDERED_ARGV_BYTES = 512;

/** Every variable name any of the claim's steps lists, once each, sorted. */
export function claimVariableNames(claim: WorktreeClaim | null | undefined): string[] {
  if (!claim) return [];
  return [...new Set(claim.steps.flatMap((step) => step.env))].sort();
}

export interface ClaimEnvironment {
  env: NodeJS.ProcessEnv;
  /** Names that got a value. */
  received: string[];
  /** Names that got none: unset or empty everywhere, or carrying the daemon's own token. */
  missing: string[];
}

/**
 * The environment for one claim step, or for the setup command.
 *
 * `scrubCheckEnv` is the base, exactly as a check gets it: credential-shaped names, the
 * state-home overrides and the daemon token are gone, PATH is the locator's snapshot and the
 * child has its own disposable state home. On top of that base go ONLY the names asked for.
 * Each value comes from the daemon's environment, else from the login shell's.
 *
 * A value that carries the daemon's token is refused even when named, by the same rule
 * `scrubCheckEnv` applies by value. Pure, apart from the disposable home the base mints, which
 * the caller releases with `cleanupAgentSubprocessEnv`.
 */
export function buildClaimEnvironment(input: ClaimVariableSources & {
  names: readonly string[];
}): ClaimEnvironment {
  const env = scrubCheckEnv(input.daemonEnv, input.daemonToken);
  const received: string[] = [];
  const missing: string[] = [];
  for (const name of input.names) {
    const resolved = resolveClaimVariable(name, input);
    if (!resolved) {
      missing.push(name);
      continue;
    }
    env[name] = resolved.value;
    received.push(name);
  }
  return { env, received, missing };
}

/** Where a claim variable's value may come from, in the order they are consulted. */
export interface ClaimVariableSources {
  daemonEnv: NodeJS.ProcessEnv;
  daemonToken: string;
  loginShell: Readonly<Record<string, string>>;
}

/**
 * The one rule for a claim variable's value, shared by the step environment and the settings
 * presence check so the two can never disagree: the daemon's environment, else the login
 * shell's, and nothing when the value is empty or carries the daemon's own token.
 */
function resolveClaimVariable(
  name: string,
  sources: ClaimVariableSources,
): { value: string; source: WorktreeClaimVariableSource } | null {
  const token = sources.daemonToken.trim();
  const daemon = sources.daemonEnv[name] || "";
  const resolved = daemon
    ? { value: daemon, source: "daemon" as const }
    : sources.loginShell[name]
      ? { value: sources.loginShell[name]!, source: "loginShell" as const }
      : null;
  if (!resolved || (token.length > 0 && resolved.value.includes(token))) return null;
  return resolved;
}

/**
 * Whether each name would reach a claim step, and from where. Never the value: this is what
 * Settings shows, and a value must not reach the browser.
 */
export function describeClaimVariables(
  input: ClaimVariableSources & { names: readonly string[] },
): WorktreeClaimVariableView[] {
  return input.names.map((name) => {
    const source = resolveClaimVariable(name, input)?.source ?? null;
    return { name, present: source !== null, source };
  });
}

/** The login shell's values for the names the daemon's own environment does not have. */
async function loginShellFor(names: readonly string[]): Promise<Record<string, string>> {
  const absent = names.filter((name) => !process.env[name]);
  return absent.length > 0 ? await loginShellVariables(absent) : {};
}

/**
 * The production environment source. The login shell is asked only for names the daemon's own
 * environment does not have, so a daemon started from a shell that exported them never forces
 * a probe.
 */
export async function claimEnvironment(names: readonly string[]): Promise<ClaimEnvironment> {
  return buildClaimEnvironment({
    names,
    daemonEnv: process.env,
    daemonToken: readToken(),
    loginShell: await loginShellFor(names),
  });
}

/**
 * The production presence check, from the same sources a claim step would receive. A login
 * shell that cannot be read reports every name it was asked for as missing, which is what a
 * step would get.
 */
export async function claimVariablePresence(names: readonly string[]): Promise<WorktreeClaimVariableView[]> {
  let loginShell: Record<string, string> = {};
  try {
    loginShell = await loginShellFor(names);
  } catch {
    loginShell = {};
  }
  return describeClaimVariables({ names, daemonEnv: process.env, daemonToken: readToken(), loginShell });
}

export interface TreeBlob {
  path: string;
  /** The object id the tree records at that path. */
  object: string;
}

/**
 * Every blob (and gitlink) recorded at `sha`, read from objects with `ls-tree`, never from the
 * checkout. A step that rewrote a lockfile in the tree therefore cannot change the fingerprint
 * of the commit it was leased at.
 */
export async function readTreeBlobs(cwd: string, sha: string): Promise<GitResult<TreeBlob[]>> {
  const result = await trackOwnWorktreeProcess((onSpawn) =>
    run("git", ["-C", cwd, "ls-tree", "-r", "-z", "--full-tree", sha], {
      timeoutMs: 60_000,
      maxBuffer: 256 * 1024 * 1024,
      onSpawn,
    }),
  );
  if (result.code !== 0 || result.outcomeUnknown || result.overflowed) {
    return {
      ok: false,
      reason: `git ls-tree failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      outcomeUnknown: result.outcomeUnknown,
    };
  }
  return { ok: true, value: parseTreeBlobs(result.stdout) };
}

/** `<mode> SP <type> SP <object> TAB <path>`, NUL-terminated. Trees never appear with `-r`. */
export function parseTreeBlobs(stdout: string): TreeBlob[] {
  const blobs: TreeBlob[] = [];
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, object] = record.slice(0, tab).split(" ");
    if ((type === "blob" || type === "commit") && object) {
      blobs.push({ path: record.slice(tab + 1), object });
    }
  }
  return blobs;
}

/**
 * The slot's dependency fingerprint, or null when the claim lists no fingerprint paths (which
 * means it always runs).
 *
 * A hash over the object ids of every path matching `fingerprintPaths`, every step's argv and
 * every step's variable names. Globs are `path.matchesGlob` globs over repository-relative
 * paths; as there, a wildcard does not match a segment that starts with a dot, so a dotfile
 * directory is named literally (`.yarn/releases/**`).
 */
export function claimFingerprint(claim: WorktreeClaim, blobs: readonly TreeBlob[]): string | null {
  if (claim.fingerprintPaths.length === 0) return null;
  const matched = blobs
    .filter((blob) => claim.fingerprintPaths.some((glob) => matchesGlob(blob.path, glob)))
    .map((blob) => [blob.path, blob.object] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        paths: matched,
        steps: claim.steps.map((step) => ({ argv: step.argv, env: step.env })),
      }),
    )
    .digest("hex");
}

/**
 * The paths matching `fingerprintPaths` whose blob differs between two commits' trees: changed,
 * added on one side, or removed on the other. Sorted. Empty when the globs match nothing that
 * differs, including when there are no globs at all.
 *
 * The same globs and the same matching as `claimFingerprint`, so "this change touched the
 * claim's inputs" and "this commit's fingerprint differs" can never disagree about a path.
 */
export function changedFingerprintInputs(
  fingerprintPaths: readonly string[],
  head: readonly TreeBlob[],
  base: readonly TreeBlob[],
): string[] {
  if (fingerprintPaths.length === 0) return [];
  const matching = (blobs: readonly TreeBlob[]): Map<string, string> => new Map(
    blobs
      .filter((blob) => fingerprintPaths.some((glob) => matchesGlob(blob.path, glob)))
      .map((blob) => [blob.path, blob.object]),
  );
  const headInputs = matching(head);
  const baseInputs = matching(base);
  const changed = new Set<string>();
  for (const [path, object] of headInputs) if (baseInputs.get(path) !== object) changed.add(path);
  for (const path of baseInputs.keys()) if (!headInputs.has(path)) changed.add(path);
  return [...changed].sort();
}

export interface ClaimStepRequest {
  argv: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  /**
   * Told each piece of the step's output as it arrives, decoded on character boundaries, for a
   * view that follows a step live (a Warm's tail and log). The step's bounded tail is kept
   * either way. Unredacted: `runClaimSteps` removes claim variable values before passing it on.
   *
   * Returning a promise is backpressure: both pipes are paused until it settles, so a step that
   * prints faster than its reader keeps up blocks on its own pipe instead of the daemon
   * buffering its output. The step's time limit keeps running meanwhile.
   *
   * `stream` names the pipe each piece came from. The two pipes interleave arbitrarily, so a
   * reader that must see each stream's text contiguously, as redaction does, keeps them apart.
   */
  onOutput?: (text: string, stream: ClaimOutputStream) => void | Promise<void>;
}

/** Which of a step's pipes a piece of its output came from. */
export type ClaimOutputStream = "stdout" | "stderr";

export type ClaimStepResult =
  | { outcome: "exited"; code: number | null; signal: string | null; tail: string; truncatedBytes: number }
  | { outcome: "timedOut" | "stopped"; tail: string; truncatedBytes: number }
  | { outcome: "spawnFailed"; reason: string };

/**
 * Run one step: argv through the executable locator, stdin closed, stdout and stderr into one
 * 4,000-byte tail (the same `TailRing` and bound as a check), in its own process group.
 *
 * Output size never fails a step: the ring drops the front and counts what it dropped. A
 * timeout or a Stop sends SIGTERM to the group, SIGKILL after a grace, and reports which.
 */
export async function runClaimStep(
  request: ClaimStepRequest,
  deps: {
    /** Defaults to the one locator. A cold or refreshing locator may probe the login shell. */
    resolveCommand?: (
      command: string,
      options: { env: NodeJS.ProcessEnv; cwd: string },
    ) => Promise<{ path: string; env: NodeJS.ProcessEnv } | null>;
    now?: () => number;
  } = {},
): Promise<ClaimStepResult> {
  const now = deps.now ?? Date.now;
  // The step's budget starts here, before the executable is resolved: resolution can wait on a
  // login-shell probe, and that wait belongs to the claim's deadline like everything else.
  const deadline = now() + Math.max(0, request.timeoutMs);
  const command = request.argv[0];
  if (!command) return { outcome: "spawnFailed", reason: "the step has no command" };
  const resolveCommand = deps.resolveCommand ??
    ((name, options) => executableLocator.resolveCommand(name, options));
  const resolved = await withinDeadline(
    resolveCommand(command, { env: request.env, cwd: request.cwd }),
    Math.max(0, request.timeoutMs),
    request.signal,
  );
  // Nothing has started, so there is no output and no process group to tear down. A resolution
  // that lands after this point is ignored: no process is ever launched for it.
  if (resolved.kind === "failed") return { outcome: "spawnFailed", reason: resolved.reason };
  if (resolved.kind !== "built") return { outcome: resolved.kind, tail: "", truncatedBytes: 0 };
  const executable = resolved.value;
  const remainingMs = deadline - now();
  if (remainingMs <= 0) return { outcome: "timedOut", tail: "", truncatedBytes: 0 };
  if (request.signal.aborted) return { outcome: "stopped", tail: "", truncatedBytes: 0 };
  if (!executable) {
    return {
      outcome: "spawnFailed",
      reason: `executable "${command}" was not found in the executable environment`,
    };
  }
  const ring = new TailRing(WORKFLOW_EXECUTION_LIMITS.checkOutput);
  return await new Promise<ClaimStepResult>((resolve) => {
    let settled = false;
    let ending: "timedOut" | "stopped" | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let child: ChildProcess;
    const finish = (result: ClaimStepResult): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const tail = () => ring.read();
    const terminate = (why: "timedOut" | "stopped"): void => {
      if (ending || settled) return;
      ending = why;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone; the close below settles it.
      }
      timers.push(setTimeout(() => {
        killProcessGroup(child);
        timers.push(setTimeout(() => {
          const { text, truncatedBytes } = tail();
          finish({ outcome: why, tail: text, truncatedBytes });
        }, DRAIN_MS));
      }, KILL_GRACE_MS));
    };
    const onAbort = (): void => terminate("stopped");
    try {
      child = spawn(executable.path, request.argv.slice(1), {
        detached: true,
        cwd: request.cwd,
        env: executable.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ outcome: "spawnFailed", reason: error instanceof Error ? error.message : String(error) });
      return;
    }
    // One decoder per stream, so a character split across two chunks of one stream is never
    // joined with bytes from the other.
    const decoders = request.onOutput ? [new StringDecoder("utf8"), new StringDecoder("utf8")] as const : null;
    // How many of the reader's waits are outstanding; the pipes flow again once none are.
    let waiting = 0;
    const pipes = () => [child.stdout, child.stderr];
    // A live view of the step is never part of the step, so its failures are only reported.
    const listenerFailed = (error: unknown): void => {
      console.warn(`[worktrees] claim output listener failed: ${error instanceof Error ? error.message : String(error)}`);
    };
    const forward = (text: string, stream: ClaimOutputStream): void => {
      if (!text) return;
      let wait: void | Promise<void>;
      try {
        wait = request.onOutput?.(text, stream);
      } catch (error) {
        listenerFailed(error);
        return;
      }
      if (!wait || settled) return;
      waiting += 1;
      if (waiting === 1) for (const pipe of pipes()) pipe?.pause();
      const resume = (): void => {
        waiting -= 1;
        if (waiting === 0) for (const pipe of pipes()) pipe?.resume();
      };
      wait.then(resume, (error: unknown) => {
        listenerFailed(error);
        resume();
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      ring.push(chunk);
      if (decoders) forward(decoders[0].write(chunk), "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      ring.push(chunk);
      if (decoders) forward(decoders[1].write(chunk), "stderr");
    });
    child.once("error", (error) => {
      if (child.pid === undefined) finish({ outcome: "spawnFailed", reason: error.message });
    });
    child.once("close", (code, signal) => {
      if (decoders) {
        forward(decoders[0].end(), "stdout");
        forward(decoders[1].end(), "stderr");
      }
      const { text, truncatedBytes } = tail();
      finish(ending
        ? { outcome: ending, tail: text, truncatedBytes }
        : { outcome: "exited", code, signal, tail: text, truncatedBytes });
    });
    timers.push(setTimeout(() => terminate("timedOut"), remainingMs));
    if (request.signal.aborted) terminate("stopped");
    else request.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** What a failed claim tells the slot row, the task and the agent. */
export interface WorktreeClaimWarning {
  /** 1-based, of `stepCount`. */
  step: number;
  stepCount: number;
  argv: string[];
  reason: string;
  tail: string;
  truncatedBytes: number;
}

export type ClaimStepsOutcome =
  | { ok: true }
  | { ok: false; stopped: boolean; warning: WorktreeClaimWarning };

/**
 * Wait for `pending` for at most `ms`, or until the claim is stopped. `onLate` receives a value
 * that arrives after the wait gave up, so whatever it holds is released rather than leaked.
 */
async function withinDeadline<T>(
  pending: Promise<T>,
  ms: number,
  signal: AbortSignal,
  onLate: (value: T) => void = () => {},
): Promise<
  | { kind: "built"; value: T }
  | { kind: "failed"; reason: string }
  | { kind: "timedOut" | "stopped" }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let abandoned = false;
  const settled = pending.then(
    (value) => {
      if (abandoned) onLate(value);
      return { kind: "built" as const, value };
    },
    (error: unknown) => ({
      kind: "failed" as const,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  // `abandoned` is set in the same callback that gives up, so whichever of the two settles
  // first decides both the race and who releases the late value.
  const gaveUp = new Promise<{ kind: "timedOut" | "stopped" }>((resolve) => {
    timer = setTimeout(() => {
      abandoned = true;
      resolve({ kind: "timedOut" });
    }, ms);
    onAbort = () => {
      abandoned = true;
      resolve({ kind: "stopped" });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([settled, gaveUp]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Run every step in order under one deadline. Any failing step fails the claim and the rest
 * do not run. Each step's environment is built for it alone and released afterwards.
 */
export async function runClaimSteps(input: {
  claim: WorktreeClaim;
  cwd: string;
  signal: AbortSignal;
  environment: (names: readonly string[]) => Promise<ClaimEnvironment>;
  runStep: (request: ClaimStepRequest) => Promise<ClaimStepResult>;
  now: () => number;
  /**
   * When the claim's time runs out. Defaults to the claim's limit from now; a claim that seeded
   * first passes the deadline it started with, so the seed and the steps share one limit.
   */
  deadline?: number;
  /** Told as each step begins, before its environment is built, so a view can say which runs. */
  onStep?: (step: RunningClaimStep) => void;
  /**
   * Told each step's command as it begins, then its output as it arrives, with every value the
   * step received already removed, then how it ended. For a view that follows the claim live.
   * A promise it returns for a step's output is backpressure, as for `ClaimStepRequest`.
   */
  onOutput?: (text: string) => void | Promise<void>;
}): Promise<ClaimStepsOutcome> {
  const failed = (error: unknown): void => {
    console.warn(`[worktrees] claim output listener failed: ${error instanceof Error ? error.message : String(error)}`);
  };
  // The header, the final flushes and the failure summary drop what this returns, so a
  // rejection is handled here; the handled promise still carries backpressure.
  const say = (text: string): void | Promise<void> => {
    let wait: void | Promise<void>;
    try {
      wait = input.onOutput?.(text);
    } catch (error) {
      failed(error);
      return undefined;
    }
    return wait ? wait.catch(failed) : undefined;
  };
  const outcome = await runClaimStepsInner(input, input.onOutput ? say : null);
  if (input.onOutput && !outcome.ok) {
    const { warning } = outcome;
    say(`\nStep ${warning.step} of ${warning.stepCount} ${warning.reason}.\n`);
  }
  return outcome;
}

async function runClaimStepsInner(
  input: Parameters<typeof runClaimSteps>[0],
  say: ((text: string) => void | Promise<void>) | null,
): Promise<ClaimStepsOutcome> {
  const limitMs = input.claim.timeoutMinutes * 60_000;
  const deadline = input.deadline ?? input.now() + limitMs;
  const stepCount = input.claim.steps.length;
  const timedOut = `timed out at the claim's ${input.claim.timeoutMinutes}-minute limit`;
  for (const [index, step] of input.claim.steps.entries()) {
    const fail = (
      reason: string,
      tail = "",
      truncatedBytes = 0,
      stopped = false,
    ): ClaimStepsOutcome => ({
      ok: false,
      stopped,
      warning: { step: index + 1, stepCount, argv: [...step.argv], reason, tail, truncatedBytes },
    });
    if (input.signal.aborted) return fail("stopped before it started", "", 0, true);
    const beforeEnvironment = deadline - input.now();
    if (beforeEnvironment <= 0) return fail(timedOut);
    input.onStep?.({ step: index + 1, stepCount, argv: [...step.argv], startedAt: input.now() });
    // Building the environment can probe the login shell, so it spends the same deadline.
    const prepared = await withinDeadline(
      input.environment(step.env),
      beforeEnvironment,
      input.signal,
      (late) => cleanupAgentSubprocessEnv(late.env),
    );
    if (prepared.kind === "failed") return fail(`its environment could not be built: ${prepared.reason}`);
    if (prepared.kind !== "built") {
      return prepared.kind === "stopped" ? fail("was stopped", "", 0, true) : fail(timedOut);
    }
    const built = prepared.value;
    // Taken before the step runs: whatever it prints of these is removed before the failure
    // reaches the slot row, Settings or the agent's prompt.
    const secrets = built.received.map((name) => ({ name, value: String(built.env[name] ?? "") }));
    const clean = (text: string): string => redactClaimValues(text, secrets);
    // Recomputed after the environment, so the step gets only what is truly left.
    const remaining = deadline - input.now();
    if (remaining <= 0) {
      cleanupAgentSubprocessEnv(built.env);
      return fail(timedOut);
    }
    // The command is the operator's own argv, never a value; what the step prints goes through
    // the same redaction as its stored tail before anything outside the step sees it.
    say?.(`${index > 0 ? "\n" : ""}$ ${renderClaimArgv(step.argv)}\n`);
    // One redactor per pipe, both feeding the same view. The pipes interleave arbitrarily, so a
    // value one stream splits across two writes can have the other stream's output land between
    // its halves; only a stream's own text, kept contiguous, still shows the whole value.
    const live = say
      ? { stdout: new RedactedOutput(secrets, say), stderr: new RedactedOutput(secrets, say) }
      : null;
    let result: ClaimStepResult;
    try {
      result = await input.runStep({
        argv: step.argv,
        cwd: input.cwd,
        env: built.env,
        timeoutMs: remaining,
        signal: input.signal,
        ...(live ? { onOutput: (text: string, stream: ClaimOutputStream) => live[stream].push(text) } : {}),
      });
    } catch (error) {
      result = { outcome: "spawnFailed", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      live?.stdout.flush();
      live?.stderr.flush();
      cleanupAgentSubprocessEnv(built.env);
    }
    const missing = built.missing.length > 0 ? ` (no value for ${built.missing.join(", ")})` : "";
    switch (result.outcome) {
      case "exited":
        if (result.code === 0) continue;
        return fail(
          (result.signal ? `was killed by ${result.signal}` : `exited with code ${result.code}`) + missing,
          clean(result.tail),
          result.truncatedBytes,
        );
      case "timedOut":
        return fail(timedOut, clean(result.tail), result.truncatedBytes);
      case "stopped":
        return fail("was stopped", clean(result.tail), result.truncatedBytes, true);
      case "spawnFailed":
        return fail(`could not start: ${clean(result.reason)}`);
    }
  }
  return { ok: true };
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^�+/, "");
}

/**
 * The failing step's command as text, cut to a fixed byte bound. A valid step may hold 32
 * arguments of 4,096 bytes each, and the agent needs to recognize the command, not read all of
 * it; the cut is deterministic and says how much it dropped.
 */
export function renderClaimArgv(argv: readonly string[]): string {
  const full = argv.join(" ");
  const bytes = Buffer.from(full, "utf8");
  if (bytes.length <= MAX_RENDERED_ARGV_BYTES) return full;
  const kept = bytes.subarray(0, MAX_RENDERED_ARGV_BYTES).toString("utf8").replace(/�+$/, "");
  return `${kept}... (${bytes.length - Buffer.byteLength(kept, "utf8")} more bytes)`;
}

/** The failing step's one-line summary with its tail, for the daemon's own log. */
export function describeClaimFailure(warning: WorktreeClaimWarning): string {
  const head = `step ${warning.step} of ${warning.stepCount} (${renderClaimArgv(warning.argv)}) ${warning.reason}`;
  return boundedText(warning.tail ? `${head}\n${warning.tail}` : head, MAX_FAILURE_BYTES);
}

/**
 * A failed claim as the slot row keeps it (`deps_last_error`) and Settings shows it. Stored as
 * a versioned JSON record so nothing downstream has to parse prose back into its parts.
 * `step`, `stepCount` and `command` are null only for a row an earlier build wrote as text.
 */
export interface ClaimFailureRecord {
  step: number | null;
  stepCount: number | null;
  command: string | null;
  reason: string;
  tail: string;
  /** Output bytes the tail ring dropped from the front. */
  truncatedBytes: number;
  /**
   * True when an earlier build stored output for this failure that is not shown: it predates
   * redaction, so it is withheld rather than trusted.
   */
  tailWithheld: boolean;
}

const FAILURE_RECORD_VERSION = 1;
const MAX_FAILURE_REASON_BYTES = 1_024;
/** The tail ring already holds at most 4,000 bytes; this bounds a record whatever wrote it. */
const MAX_FAILURE_TAIL_BYTES = 4_096;

/** The first `maxBytes` of `value`, cut on a character boundary. */
function boundedHead(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

/** The record persisted on the slot row for a failed claim. */
export function encodeClaimFailure(warning: WorktreeClaimWarning): string {
  return JSON.stringify({
    version: FAILURE_RECORD_VERSION,
    step: warning.step,
    stepCount: warning.stepCount,
    command: renderClaimArgv(warning.argv),
    reason: boundedHead(warning.reason, MAX_FAILURE_REASON_BYTES),
    tail: boundedText(warning.tail, MAX_FAILURE_TAIL_BYTES),
    truncatedBytes: warning.truncatedBytes,
  });
}

/**
 * Read a slot row's failure back. A record this build wrote decodes field for field. Anything
 * else is text an earlier build wrote (`describeClaimFailure`'s shape), and fails closed: its
 * first line, the operator's own command and the reason, becomes the reason, and the step's
 * output is withheld. That output was stored before redaction existed, so it may hold a value
 * the step printed, and a value since rotated cannot be recognized to redact it now.
 */
export function decodeClaimFailure(stored: string): ClaimFailureRecord {
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    if (
      parsed && typeof parsed === "object" &&
      parsed.version === FAILURE_RECORD_VERSION &&
      Number.isSafeInteger(parsed.step) &&
      Number.isSafeInteger(parsed.stepCount) &&
      typeof parsed.command === "string" &&
      typeof parsed.reason === "string" &&
      typeof parsed.tail === "string" &&
      Number.isSafeInteger(parsed.truncatedBytes)
    ) {
      return {
        step: parsed.step as number,
        stepCount: parsed.stepCount as number,
        command: boundedHead(parsed.command, MAX_RENDERED_ARGV_BYTES * 2),
        reason: boundedHead(parsed.reason, MAX_FAILURE_REASON_BYTES),
        tail: boundedText(parsed.tail, MAX_FAILURE_TAIL_BYTES),
        truncatedBytes: parsed.truncatedBytes as number,
        tailWithheld: false,
      };
    }
  } catch {
    // Not a record: an earlier build's text.
  }
  const newline = stored.indexOf("\n");
  const head = newline < 0 ? stored : stored.slice(0, newline);
  return {
    step: null,
    stepCount: null,
    command: null,
    reason: boundedHead(head, MAX_FAILURE_REASON_BYTES),
    tail: "",
    truncatedBytes: 0,
    tailWithheld: newline >= 0 && stored.slice(newline + 1).length > 0,
  };
}

/** The shortest trailing piece of a value that counts as that value when a tail starts with it. */
const MIN_REDACTED_FRAGMENT = 4;

/**
 * Remove every value a step received from text that step produced. A step is free to print its
 * own environment, and its output goes to the slot row, Settings and the agent's prompt, none
 * of which may carry a claim variable's value. Each whole occurrence becomes `[NAME redacted]`.
 * The tail ring drops output from the front, so a tail can also START partway through a value:
 * a leading piece of at least four characters that ends a value is redacted too.
 *
 * Every match is found in the ORIGINAL text before anything is replaced, so no replacement can
 * hide another value's match: one value's suffix overlapping the start of another value, a
 * value inside another, and overlapping occurrences are all covered. Overlapping and touching
 * spans merge into one marker naming every variable they cover.
 */
export function redactClaimValues(
  text: string,
  secrets: ReadonlyArray<{ name: string; value: string }>,
  options: {
    /**
     * Whether the text may start partway through a value, as a tail the ring cut does. Output
     * streamed from its first byte never does, so `RedactedOutput` turns this off.
     */
    leadingFragments?: boolean;
  } = {},
): string {
  return applyRedaction(text, redactionSpans(text, secrets, options));
}

interface RedactionSpan {
  start: number;
  end: number;
  names: string[];
}

/** Every range of `text` a value covers, overlapping and adjacent occurrences merged, in order. */
function redactionSpans(
  text: string,
  secrets: ReadonlyArray<{ name: string; value: string }>,
  options: { leadingFragments?: boolean },
  covered: RedactionSpan | null = null,
): RedactionSpan[] {
  const spans: Array<{ start: number; end: number; name: string }> = [];
  if (covered) for (const name of covered.names) spans.push({ start: covered.start, end: covered.end, name });
  for (const { name, value } of secrets) {
    if (value.length === 0) continue;
    // Every complete occurrence, overlapping ones included.
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
      spans.push({ start: at, end: at + value.length, name });
    }
    if (options.leadingFragments === false) continue;
    // The longest leading piece of the text that ends this value, as the ring's cut leaves it.
    for (let length = value.length - 1; length >= MIN_REDACTED_FRAGMENT; length -= 1) {
      if (text.startsWith(value.slice(-length))) {
        spans.push({ start: 0, end: length, name });
        break;
      }
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: RedactionSpan[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      if (!last.names.includes(span.name)) last.names.push(span.name);
    } else {
      merged.push({ start: span.start, end: span.end, names: [span.name] });
    }
  }
  return merged;
}

/** `text` with each span replaced by its marker; a span past the end of `text` is clipped. */
function applyRedaction(text: string, spans: readonly RedactionSpan[]): string {
  let redacted = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start >= text.length) break;
    redacted += `${text.slice(cursor, span.start)}[${span.names.join(", ")} redacted]`;
    cursor = Math.min(span.end, text.length);
  }
  return redacted + text.slice(cursor);
}

/** How long an unterminated line may grow in a redactor before it streams anyway. */
const MAX_OPEN_LINE = 4_096;

/**
 * A step's output, streamed with every value the step received removed, however the pipe cut
 * it. A value can arrive split across two pieces, so the stream holds back the last
 * `longest value - 1` characters it has seen, the most an unfinished value can occupy. A cut
 * that would split a complete value, or a run of overlapping ones, moves back to the run's
 * start. A run that already starts the held text cannot move back without holding it forever
 * (a value such as `00` in a stream of zeroes), so the cut stays, the part before it is
 * released redacted, and the rest is carried as covered into the next release. Either way no
 * character of a value is released, and `flush` releases the rest when the step ends.
 *
 * It releases whole lines where it can: a value with no newline cannot span a line end, so
 * every complete line is safe, and a step's stdout and stderr, each with a redactor of its own,
 * then interleave at line boundaries. A line still open past `MAX_OPEN_LINE` characters streams
 * at the value-safe cut instead. The live view therefore lags the step by at most one line.
 *
 * One redactor reads one stream. Two streams' text concatenated can put one stream's output
 * between the halves of a value the other split, and then neither half matches.
 */
export class RedactedOutput {
  private pending = "";
  /** The front of `pending` that a run released at the last cut still covers. */
  private covered: RedactionSpan | null = null;
  private readonly hold: number;
  private readonly secrets: ReadonlyArray<{ name: string; value: string }>;
  /** No value holds a newline, so no value can span a line end and a whole line is safe. */
  private readonly lineSafe: boolean;

  /** `sink` may return a promise as backpressure; `push` and `flush` hand it back. */
  constructor(
    secrets: ReadonlyArray<{ name: string; value: string }>,
    private readonly sink: (text: string) => void | Promise<void>,
  ) {
    this.secrets = secrets.filter((secret) => secret.value.length > 0);
    this.hold = Math.max(0, ...this.secrets.map((secret) => secret.value.length - 1));
    this.lineSafe = this.secrets.every((secret) => !/[\r\n]/.test(secret.value));
  }

  push(text: string): void | Promise<void> {
    if (this.secrets.length === 0) {
      return text ? this.sink(text) : undefined;
    }
    this.pending += text;
    // Whole lines first: a step's two pipes each have a redactor, and releasing complete lines
    // keeps their interleaving at line boundaries instead of mid-word. A line still open past
    // MAX_OPEN_LINE characters streams anyway, up to the value-safe cut.
    const lineEnd = this.lineSafe ? this.pending.lastIndexOf("\n") + 1 : 0;
    const open = this.pending.length - lineEnd;
    let cut = open > MAX_OPEN_LINE ? Math.max(lineEnd, this.pending.length - this.hold) : lineEnd;
    if (cut <= 0) return undefined;
    // A value that starts before `cut` is complete in `pending` (it is at most `hold + 1`
    // long), so the only way to split one is to cut through its merged span.
    const spans = redactionSpans(this.pending, this.secrets, { leadingFragments: false }, this.covered);
    const crossing = spans.find((span) => span.start < cut && span.end > cut);
    let covered: RedactionSpan | null = null;
    if (crossing && crossing.start > 0) cut = crossing.start;
    else if (crossing) covered = { start: 0, end: crossing.end - cut, names: crossing.names };
    const ready = applyRedaction(this.pending.slice(0, cut), spans);
    this.pending = this.pending.slice(cut);
    this.covered = covered;
    return this.sink(ready);
  }

  flush(): void | Promise<void> {
    if (!this.pending) return undefined;
    const rest = applyRedaction(this.pending, redactionSpans(this.pending, this.secrets, { leadingFragments: false }, this.covered));
    this.pending = "";
    this.covered = null;
    return this.sink(rest);
  }
}

/** A backtick run longer than any in `text`, at least `minimum` long, so `text` cannot close it. */
function fenceFor(text: string, minimum = 3): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(minimum, longest + 1));
}

/** Inline Markdown code that a backtick inside the command cannot end early. */
function inlineCode(text: string): string {
  const fence = fenceFor(text, 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * The note an agent's launch prompt carries when a claim failed in one of its worktrees: the
 * failing step and its output tail, and what that means for the work. Empty when nothing failed.
 */
export function claimWarningsBlock(
  warnings: ReadonlyArray<{ path: string; warning: WorktreeClaimWarning }>,
): string {
  if (warnings.length === 0) return "";
  const lines = ["## Dependency install warning", ""];
  for (const { path, warning } of warnings) {
    lines.push(
      `Mission Control's dependency claim for ${path} failed, so the installed dependencies in`,
      "that worktree may not match its commit.",
      "",
      `Failing step ${warning.step} of ${warning.stepCount}: ${inlineCode(renderClaimArgv(warning.argv))} ${warning.reason}.`,
    );
    if (warning.tail) {
      const fence = fenceFor(warning.tail);
      const dropped = warning.truncatedBytes > 0
        ? ` (the last part; ${warning.truncatedBytes} earlier bytes were dropped)`
        : "";
      lines.push("", `Its output${dropped}:`, "", fence, warning.tail.replace(/\n+$/, ""), fence);
    }
    lines.push("");
  }
  lines.push(
    "Install or repair the dependencies yourself before you build or test, and say in your",
    "result if a failure you hit came from them rather than from your change.",
    "",
    "---",
    "",
  );
  return lines.join("\n");
}

/** The step a running claim is on. */
export interface RunningClaimStep {
  /** 1-based, of `stepCount`. */
  step: number;
  stepCount: number;
  argv: string[];
  startedAt: number;
}

export interface RunningClaim {
  /**
   * This claim's own identity. A slot runs one claim at a time, but a Stop aimed at the claim
   * an operator saw must never land on the next lease's claim in the same slot.
   */
  id: string;
  slotId: string;
  owner: WorktreeOwner;
  startedAt: number;
  /** Null until the first step begins: the fingerprint is still being read. */
  step: RunningClaimStep | null;
}

/**
 * The claims running right now, keyed by slot. In memory by design: a claim cannot outlive the
 * daemon that runs it, and what a crash leaves behind is the durable `deps_state` write-ahead,
 * which startup reconciliation reads instead.
 *
 * Maintenance asks it which slots to skip rather than wait on; Stop, task cancel and shutdown
 * all find the claims they stop through it.
 */
function snapshot({ id, slotId, owner, startedAt, step }: RunningClaim): RunningClaim {
  return { id, slotId, owner: { ...owner }, startedAt, step: step ? { ...step, argv: [...step.argv] } : null };
}

/** Told whenever a claim starts, moves to its next step, or ends. */
export type ClaimChangeListener = (claim: RunningClaim) => void;

export class ClaimRegistry {
  private readonly running = new Map<string, RunningClaim & { controller: AbortController }>();
  private readonly listeners = new Set<ClaimChangeListener>();
  private stoppingValue = false;

  constructor(private readonly newId: () => string = randomUUID) {}

  /** Null once shutdown has begun: no new claim starts while the daemon stops. */
  register(slotId: string, owner: WorktreeOwner, now: number): AbortController | null {
    if (this.stoppingValue) return null;
    const controller = new AbortController();
    const claim = { id: this.newId(), slotId, owner: { ...owner }, startedAt: now, step: null, controller };
    this.running.set(slotId, claim);
    this.notify(claim);
    return controller;
  }

  /** Record the step this claim is on. A claim that is no longer registered is left alone. */
  progress(slotId: string, controller: AbortController, step: RunningClaimStep): void {
    const running = this.running.get(slotId);
    if (running?.controller !== controller) return;
    running.step = { ...step, argv: [...step.argv] };
    this.notify(running);
  }

  /** The running claim on this slot, or null. */
  get(slotId: string): RunningClaim | null {
    const running = this.running.get(slotId);
    return running ? snapshot(running) : null;
  }

  unregister(slotId: string, controller: AbortController): void {
    const running = this.running.get(slotId);
    if (running?.controller !== controller) return;
    this.running.delete(slotId);
    this.notify(running);
  }

  has(slotId: string): boolean {
    return this.running.has(slotId);
  }

  get stopping(): boolean {
    return this.stoppingValue;
  }

  list(): RunningClaim[] {
    return [...this.running.values()].map(snapshot);
  }

  /**
   * Stop the one claim with this id on this slot, and report what was stopped. Null when that
   * claim is no longer running, which includes a slot that has since started another claim.
   *
   * Stopping kills the running step's process group and fails the claim, so the lease is
   * granted with a warning exactly as for any failed claim. The registry entry stays until the
   * claim's own acquire unregisters it.
   */
  stop(slotId: string, claimId: string): RunningClaim | null {
    const running = this.running.get(slotId);
    if (!running || running.id !== claimId) return null;
    running.controller.abort("stopped");
    return snapshot(running);
  }

  /** Stop every running claim whose owner matches, and report each one stopped. */
  stopOwned(matches: (owner: WorktreeOwner) => boolean): RunningClaim[] {
    const stopped: RunningClaim[] = [];
    for (const running of this.running.values()) {
      if (!matches(running.owner)) continue;
      running.controller.abort("stopped");
      stopped.push(snapshot(running));
    }
    return stopped;
  }

  /** Listen for claim changes. Returns the unsubscribe. */
  subscribe(listener: ClaimChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(claim: RunningClaim): void {
    if (this.listeners.size === 0) return;
    const view = snapshot(claim);
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch (error) {
        // A listener is a view of the claim, never a part of it: a failing projection must not
        // fail the acquire that runs the claim.
        console.error("[worktrees] claim change listener failed:", error);
      }
    }
  }

  /** Shutdown: refuse new claims and stop every running one. */
  stopAll(): void {
    this.stoppingValue = true;
    for (const claim of this.running.values()) claim.controller.abort("shutdown");
  }

  /** Re-arm after `stopAll`, for a manager restarted in the same process (tests). */
  resume(): void {
    this.stoppingValue = false;
  }
}
