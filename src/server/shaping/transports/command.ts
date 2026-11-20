import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, promises as fsp, realpathSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  MISSION_API_TOKEN_ENV,
  MISSION_API_TOKEN_FILE_ENV,
  SCOUT_SESSION_LOCATOR_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV,
  readToken,
} from "@shared/harness-runtime.mjs";
import { dropPaneIdentityEnv, STATE_HOME_ENV_NAMES } from "../../agent-subprocess-env.ts";
import { executableChildEnv, executableLocator } from "../../executables/locator.ts";
import { credentialShapedName, MAKE_RECURSION_ENV_NAMES } from "../../workflows/check-env.ts";
import type { ShapingTransport, TransportReply } from "./types.ts";

/**
 * The `command` transport: one short-lived local process per call. The request is JSON on
 * stdin and the result is JSON on stdout. argv is spawned without a shell, in its own process
 * group so a timeout takes its descendants down too, with a scrubbed environment plus only the
 * variables the shaper names. A gatherer runs in the repository worktree and a selector in an
 * empty directory of its own.
 *
 * Not `run()` from `util/exec.ts`: that one cannot be aborted, writes no process group and
 * buffers 8 MB. A shaping call has to stop the moment the step's deadline passes.
 */

/** stdout beyond this is not a reply: the process group is killed and the call fails. */
export const COMMAND_OUTPUT_BYTES = 256 * 1024;
const STDERR_TAIL_CHARS = 2_000;
/** How long to wait for the pipes to close after the group was killed. */
const DRAIN_MS = 1_000;

/** Variables a shaper can never receive, even by naming them. */
const NEVER_PASSED = new Set<string>([
  ...STATE_HOME_ENV_NAMES,
  MISSION_API_TOKEN_ENV,
  MISSION_API_TOKEN_FILE_ENV,
  SCOUT_SESSION_LOCATOR_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_ENV,
  SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV,
]);

/**
 * The child environment: the locator's child environment (its PATH snapshot), without what an
 * agent subprocess never inherits, without credential-shaped names and without any value that
 * carries the daemon's token - then exactly the variables the shaper named, from `base`.
 */
export function shaperCommandEnv(
  base: NodeJS.ProcessEnv,
  names: readonly string[],
  daemonToken: string,
): NodeJS.ProcessEnv {
  const token = daemonToken.trim();
  const carriesToken = (value: string) => token.length > 0 && value.includes(token);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(executableChildEnv(base))) {
    if (value === undefined || NEVER_PASSED.has(name)) continue;
    if ((MAKE_RECURSION_ENV_NAMES as readonly string[]).includes(name)) continue;
    if (credentialShapedName(name) || carriesToken(value)) continue;
    env[name] = value;
  }
  dropPaneIdentityEnv(env);
  for (const name of names) {
    const value = base[name];
    if (NEVER_PASSED.has(name) || value === undefined || value === "" || carriesToken(value)) continue;
    env[name] = value;
  }
  return env;
}

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
  }
}

/**
 * Close the daemon's ends of the child's pipes. Killing the process group does not close a pipe
 * that a helper outside the group inherited, so without this a call that settled at the drain
 * timeout would leave its pipes and their listeners open for as long as that helper lives.
 * Harmless after a normal close, when the streams are already ended.
 */
function releaseStdio(child: ChildProcess | undefined): void {
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
    if (!stream) continue;
    stream.removeAllListeners("data");
    stream.destroy();
  }
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/** Below this length a value is redacted only where it stands as a whole token. */
const SHORT_VALUE_CHARS = 4;

/** Every distinct, non-empty value in the environment the child was actually spawned with. */
export function receivedValues(env: NodeJS.ProcessEnv): string[] {
  const values = Object.values(env).filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every start offset of `value` in `text`, overlapping occurrences included: a search that
 * resumed after each match would step over a second copy that begins inside the first.
 */
function occurrences(text: string, value: string, wholeToken: boolean): number[] {
  const starts: number[] = [];
  if (!wholeToken) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) starts.push(at);
    return starts;
  }
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    starts.push(match.index);
    pattern.lastIndex = match.index + 1;
  }
  return starts;
}

/**
 * Remove every value the child received from text it printed, before it is recorded. A value of
 * four characters or more is replaced wherever it appears. A shorter one is replaced only as a
 * whole token, between non-alphanumerics: `LANG=C` or `SHLVL=1` matched as substrings would blank
 * every "C" or "1" in the message and leave nothing to diagnose.
 *
 * Every occurrence of every value is marked on the original text, and overlapping or touching
 * marks merge into one span, so two values that overlap are redacted over their combined extent
 * and no part of either survives. The marks go into a difference array, so the work is linear in
 * the text for each value, however many matches it has: up to 256 KiB of shaper output never
 * costs the event loop more than that.
 */
export function redactReceived(text: string, values: readonly string[], dropBefore = 0): string {
  const depth = new Int32Array(text.length + 1);
  let marked = false;
  for (const value of values) {
    for (const start of occurrences(text, value, value.length < SHORT_VALUE_CHARS)) {
      depth[start]! += 1;
      depth[start + value.length]! -= 1;
      marked = true;
    }
  }
  if (!marked && dropBefore <= 0) return text;
  // `dropBefore` discards unmarked text in front of that offset: a value whose start was cut
  // off by a bounded buffer lives there, as a piece no pattern can recognise.
  let out = "";
  let covered = 0;
  let runStart = 0;
  for (let at = 0; at <= text.length; at++) {
    const wasCovered = covered > 0;
    covered += depth[at]!;
    const isCovered = at < text.length && covered > 0;
    if (isCovered === wasCovered) continue;
    if (wasCovered) out += "[redacted]";
    else out += text.slice(Math.max(runStart, dropBefore), Math.max(at, dropBefore));
    runStart = at;
  }
  if (covered <= 0 && runStart < text.length) out += text.slice(Math.max(runStart, dropBefore));
  return out;
}

/** Give the owner back every permission on `dir` and each directory beneath it. Symlinks are never followed. */
async function unlockTree(dir: string): Promise<void> {
  await fsp.chmod(dir, 0o700);
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlockTree(join(dir, entry.name));
  }
}

/**
 * Remove a selector's scratch directory, off the event loop. The call settles first and never
 * waits for this: a selector that left a large tree behind costs disk work in the background,
 * not latency for the dry run or for any other request. It never rejects. A directory the
 * shaper locked is unlocked and removed; one that cannot be removed at all is left behind and
 * logged.
 */
export async function removeScratch(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return;
  } catch {
    // Most often a directory the shaper took its own permissions off. Unlock and retry once.
  }
  try {
    await unlockTree(dir);
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn("[shaping] could not remove a selector's working directory:", dir,
      error instanceof Error ? error.message : String(error));
  }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** A `./` command, resolved against the shaper's own folder and kept inside it. */
function folderCommand(command: string, root: string | null): { path: string } | { problem: string } {
  if (!root) return { problem: `"${command}" is a ./ path, which only a shaper found in the shapers folder may use.` };
  try {
    const folder = realpathSync(root);
    const target = realpathSync(resolve(folder, command));
    if (!target.startsWith(folder + sep)) return { problem: `"${command}" resolves outside the shaper's folder.` };
    return { path: target };
  } catch {
    return { problem: `"${command}" was not found in the shaper's folder.` };
  }
}

async function withTimeout<T>(pending: Promise<T>, ms: number, signal: AbortSignal): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<"late">((done) => {
        timer = setTimeout(() => done("late"), Math.max(0, ms));
        onAbort = () => done("late");
        if (signal.aborted) done("late");
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export const callCommand: ShapingTransport<"command"> = async (request, shaper, ctx) => {
  const started = Date.now();
  const transport = shaper.transport;
  const env = shaperCommandEnv(process.env, transport.env, readToken());

  let cwd: string;
  let scratch: string | null = null;
  if (request.stage === "gather") {
    if (!request.repo.path || !isDirectory(request.repo.path)) {
      return { kind: "unavailable", reason: "The repository's worktree is not available on this machine." };
    }
    cwd = request.repo.path;
  } else {
    try {
      scratch = mkdtempSync(join(tmpdir(), "mission-shaper-"));
    } catch (error) {
      return { kind: "failed", reason: `Could not create the selector's working directory: ${error instanceof Error ? error.message : String(error)}` };
    }
    cwd = scratch;
  }
  // Fire and forget: removal runs in the background and the call never waits for it.
  const cleanup = () => { if (scratch) void removeScratch(scratch); };

  let command = transport.command;
  if (command.startsWith("./")) {
    const located = folderCommand(command, ctx.root);
    if ("problem" in located) { cleanup(); return { kind: "unavailable", reason: located.problem }; }
    command = located.path;
  }
  // Resolution can wait on a login-shell probe, and that wait spends this call's budget.
  const executable = await withTimeout(
    executableLocator.resolveCommand(command, { env, cwd }).catch(() => null),
    ctx.timeoutMs,
    ctx.signal,
  );
  if (executable === "late") { cleanup(); return { kind: "timed_out", reason: `Timed out after ${seconds(ctx.timeoutMs)} while locating "${transport.command}".` }; }
  if (!executable) { cleanup(); return { kind: "unavailable", reason: `The command "${transport.command}" was not found.` }; }
  const remaining = ctx.timeoutMs - (Date.now() - started);
  if (remaining <= 0 || ctx.signal.aborted) {
    cleanup();
    return { kind: "timed_out", reason: `Timed out after ${seconds(ctx.timeoutMs)}.` };
  }

  // What the child is spawned with, which is what its output may repeat.
  const received = receivedValues(executable.env);
  const longestValue = received[0]?.length ?? 0;
  return await new Promise<TransportReply>((settle) => {
    const out: Buffer[] = [];
    let outBytes = 0;
    // Kept a value's length beyond the recorded tail, so a value cut at the front of the buffer
    // is dropped with that margin instead of surviving as an unredacted fragment.
    let stderr = "";
    let stderrDropped = false;
    const stderrDecoder = new StringDecoder("utf8");
    let ending: "timed_out" | "overflow" | null = null;
    let settled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let child: ChildProcess;
    const finish = (reply: TransportReply): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      releaseStdio(child as ChildProcess | undefined);
      settle(reply);
      cleanup();
    };
    const stderrTail = (): string => {
      // Once the front was cut, the first `longestValue` characters may hold the tail end of a
      // value. They are dropped in the original text's positions, not after replacement.
      return redactReceived(stderr, received, stderrDropped ? longestValue : 0).slice(-STDERR_TAIL_CHARS).trim();
    };
    const end = (why: "timed_out" | "overflow"): void => {
      if (ending || settled) return;
      ending = why;
      killGroup(child);
      timers.push(setTimeout(() => finish(why === "timed_out"
        ? { kind: "timed_out", reason: `Timed out after ${seconds(ctx.timeoutMs)}.` }
        : { kind: "failed", reason: `The command printed more than ${COMMAND_OUTPUT_BYTES / 1024} KiB.` }), DRAIN_MS));
    };
    const onAbort = (): void => end("timed_out");
    try {
      child = spawn(executable.path, transport.args, {
        detached: true,
        cwd,
        env: executable.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({ kind: "unavailable", reason: `The command could not start: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (ending) return;
      outBytes += chunk.length;
      if (outBytes > COMMAND_OUTPUT_BYTES) end("overflow");
      else out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Decoded as a stream: a character split across two chunks is kept whole, so a non-ASCII
      // value the child received still matches exactly when it is redacted.
      const joined = stderr + stderrDecoder.write(chunk);
      const keep = STDERR_TAIL_CHARS + longestValue;
      if (joined.length > keep) stderrDropped = true;
      stderr = joined.slice(-keep);
    });
    // A shaper that exits without reading its request closes the pipe under us. That is its
    // business, not a failure of the call.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
    child.once("error", (error) => {
      if (child.pid === undefined) finish({ kind: "unavailable", reason: `The command could not start: ${error.message}` });
    });
    child.once("close", (code, signal) => {
      if (ending === "timed_out") return finish({ kind: "timed_out", reason: `Timed out after ${seconds(ctx.timeoutMs)}.` });
      if (ending === "overflow") return finish({ kind: "failed", reason: `The command printed more than ${COMMAND_OUTPUT_BYTES / 1024} KiB.` });
      if (code === 0) {
        return finish({
          kind: "data",
          data: Buffer.concat(out).toString("utf8"),
          // The reply is the shaper's own text too: reasons built from it are scrubbed the same way.
          redact: (text) => redactReceived(text, received),
        });
      }
      // Only the child's own text is redacted, never the sentence Mission Control wraps it in.
      stderr += stderrDecoder.end();
      const tail = stderrTail();
      const detail = tail ? `: ${tail}` : "";
      finish({ kind: "failed", reason: signal ? `The command was killed by ${signal}${detail}` : `The command exited with code ${code}${detail}` });
    });
    timers.push(setTimeout(() => end("timed_out"), remaining));
    if (ctx.signal.aborted) end("timed_out");
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
};
