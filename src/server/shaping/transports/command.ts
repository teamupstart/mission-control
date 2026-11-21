import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, promises as fsp, realpathSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { readToken } from "@shared/harness-runtime.mjs";
import { trimUrlText } from "@shared/shaping.ts";
import { dropPaneIdentityEnv } from "../../agent-subprocess-env.ts";
import { executableChildEnv, executableLocator } from "../../executables/locator.ts";
import { credentialShapedName, MAKE_RECURSION_ENV_NAMES } from "../../workflows/check-env.ts";
import { redactSpans } from "../redaction.ts";
import {
  holdsResolvedValue, JSON_ESCAPE_LEVELS, NEVER_PASSED_ENV_NAMES, resolvedMarker, scrubResolved, variantSpans, type ResolvedValue,
} from "../references.ts";
import { carriedEnvName, withCarriedEnv } from "./carriers.ts";
import type { ShapingTraceContext, ShapingTransport, TransportReply } from "./types.ts";

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
/** After the shaper exits, how long its pipes get to deliver the rest of its output. */
const EXIT_DRAIN_MS = 500;
/** How far before the call's deadline a drain ends, so its reply still counts as on time. */
const EXIT_DEADLINE_MARGIN_MS = 50;

/** Variables a shaper can never receive, even by naming them. No reference resolves them either. */
const NEVER_PASSED = NEVER_PASSED_ENV_NAMES;
// `carriedEnvName`: `TRACEPARENT`, `TRACESTATE` and `WORK_UNIT_ID` in any spelling. Only the
// launch's own values are ever sent, and none of them is ever redacted.

/**
 * The child environment: the locator's child environment (its PATH snapshot), without what an
 * agent subprocess never inherits, without credential-shaped names and without any value that
 * carries the daemon's token - then exactly the variables the shaper named, from `base`.
 *
 * Then the launch's trace context, through the one carrier agents use, and the run's work unit
 * id as `WORK_UNIT_ID`: a `TRACEPARENT`, `TRACESTATE` or `WORK_UNIT_ID` inherited from the daemon
 * or named by the shaper, in any case, is removed first, and the launch's own are set exactly
 * when it has them.
 */
export function shaperCommandEnv(
  base: NodeJS.ProcessEnv,
  names: readonly string[],
  daemonToken: string,
  trace: ShapingTraceContext | null = null,
  workUnitId: string | null = null,
): NodeJS.ProcessEnv {
  const token = daemonToken.trim();
  const carriesToken = (value: string) => token.length > 0 && value.includes(token);
  // Built from entries, never by assignment: a variable named `__proto__` is then an own
  // property the child receives, not a write to the object's prototype.
  const inherited: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(executableChildEnv(base)).filter(([name, value]) =>
    value !== undefined && !NEVER_PASSED.has(name) && !(MAKE_RECURSION_ENV_NAMES as readonly string[]).includes(name)
    && !credentialShapedName(name) && !carriesToken(value) && !carriedEnvName(name)));
  dropPaneIdentityEnv(inherited);
  const env = new Map(Object.entries(inherited));
  for (const name of names) {
    // The environment's own string only: `constructor` must not read an inherited property.
    const value = Object.hasOwn(base, name) && typeof base[name] === "string" ? base[name] : undefined;
    if (NEVER_PASSED.has(name) || carriedEnvName(name) || value === undefined || value === "" || carriesToken(value)) continue;
    env.set(name, value);
  }
  return withCarriedEnv(Object.fromEntries(env), trace, workUnitId);
}

export function killGroup(child: ChildProcess): void {
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
export function releaseStdio(child: ChildProcess | undefined): void {
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

/**
 * Inherited values that carry a credential although nobody named them: a URL with userinfo, as an
 * authenticated proxy setting such as `HTTPS_PROXY=http://user:pass@proxy:8080` is. Each one is
 * reported under its variable's name as the whole URL, its `user:password` part and the
 * password, each as written and percent-decoded, so a shaper echoing any of them is caught.
 */
/** `text` percent-decoded, or as written when it is not valid percent-encoding. */
function decoded(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

export function credentialBearingValues(env: NodeJS.ProcessEnv): ResolvedValue[] {
  const out: ResolvedValue[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || carriedEnvName(name)) continue;
    const trimmed = trimUrlText(value);
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)) continue;
    let url: URL;
    try { url = new URL(trimmed); } catch { continue; }
    if (!url.username && !url.password) continue;
    // The userinfo as written runs to the authority's LAST "@", which is where the URL parser
    // ends it, so an unescaped "@" inside the password does not cut it short.
    const authority = trimmed.slice(trimmed.indexOf("//") + 2).split(/[/?#]/, 1)[0]!;
    const written = authority.slice(0, authority.lastIndexOf("@"));
    const writtenPassword = written.includes(":") ? written.slice(written.indexOf(":") + 1) : "";
    // Each form a tool might print: as written, as the parser normalised it, and decoded.
    const forms = [value, trimmed, written, writtenPassword, url.password, `${url.username}:${url.password}`,
      decoded(written), decoded(writtenPassword), decoded(url.password), decoded(`${url.username}:${url.password}`)];
    for (const form of new Set(forms)) {
      if (form.length > 0 && form !== ":") out.push({ name, value: form });
    }
  }
  return out;
}

/** What a child's output is redacted against: every value it received, and which were named. */
export interface ReceivedValues {
  /** Every distinct, non-empty value in the environment the child was spawned with, longest first. */
  values: readonly string[];
  /**
   * The values of the variables the operator named in the shaper's `env`. Those are the
   * credentials it was configured to hand over, so they are redacted wherever they appear,
   * however short, rather than only as whole tokens.
   */
  named: ReadonlySet<string>;
}

/** Every distinct, non-empty value in the environment the child was actually spawned with. */
export function receivedValues(env: NodeJS.ProcessEnv, namedVariables: readonly string[] = []): ReceivedValues {
  // The trace context and the work unit id are neither credentials nor references, so neither is ever redacted.
  const values = Object.entries(env).filter(([name]) => !carriedEnvName(name)).map(([, value]) => value)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const named = namedVariables.filter((name) => !carriedEnvName(name) && Object.hasOwn(env, name)).map((name) => env[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return { values: [...new Set(values)].sort((a, b) => b.length - a.length), named: new Set(named) };
}

/**
 * The most characters one character of a named value can take in a spelling the scrub decodes: a
 * JSON `\u` escape is six, and each further level of nested JSON text it decodes can escape every
 * character of the level beneath it again, so `JSON_ESCAPE_LEVELS` levels multiply it.
 */
const SPELLING_EXPANSION = 6 ** JSON_ESCAPE_LEVELS;

/** The most of a child's stderr kept beyond the recorded tail, however long its values are. */
const STDERR_MARGIN_CAP = 1 << 20;

/** How much stderr is kept beyond the recorded tail, and whether that covers every spelling. */
export interface StderrMargin {
  chars: number;
  /** False when the margin a spelling needs is over the cap: a cut stderr is then not quoted. */
  covers: boolean;
}

/**
 * How much of a child's stderr is kept beyond the tail a diagnostic records, and dropped from its
 * front once it was cut. An inherited value is matched only as written, so its own length is
 * enough; a named value is matched in every spelling the scrub decodes, the longest of which is
 * `SPELLING_EXPANSION` characters for each of its own. A value cut at the front in any such
 * spelling then falls wholly inside the dropped margin, and no fragment survives unrecognised.
 * A margin that would pass `STDERR_MARGIN_CAP` is held at the cap and does not cover: a buffer
 * cut with it is not quoted at all, rather than quoted with a fragment the margin missed.
 */
export function stderrMargin(received: ReceivedValues, named: readonly ResolvedValue[]): StderrMargin {
  const longestNamed = named.reduce((longest, { value }) => Math.max(longest, value.length), 0);
  const needed = Math.max(received.values[0]?.length ?? 0, longestNamed * SPELLING_EXPANSION);
  return needed <= STDERR_MARGIN_CAP ? { chars: needed, covers: true } : { chars: STDERR_MARGIN_CAP, covers: false };
}

/**
 * Remove every value the child received from text it printed, before it is recorded. A value of
 * four characters or more is replaced wherever it appears. A shorter inherited one is replaced
 * only as a whole token, between non-alphanumerics: `LANG=C` or `SHLVL=1` matched as substrings
 * would blank every "C" or "1" in the message and leave nothing to diagnose. A value the operator
 * named is a credential it chose to pass, so it is replaced wherever it appears whatever its
 * length: `tokenab1` must not keep a three-character `ab1` just because letters surround it.
 *
 * Every occurrence of every value is found on the original text and overlapping or touching
 * matches merge into one span (`redactSpans`), so two values that overlap are redacted over their
 * combined extent and no part of either survives. Each value is found in linear time, however
 * many matches it has: up to 256 KiB of shaper output never stalls the event loop.
 */
export function redactReceived(text: string, received: ReceivedValues, dropBefore = 0): string {
  return redactSpans(text, receivedTargets(received), () => "[redacted]", dropBefore);
}

/** Every value a child received as a redaction target, unlabelled: each is written `[redacted]`. */
function receivedTargets(received: ReceivedValues) {
  return received.values.map((value) => ({
    value, wholeToken: value.length < SHORT_VALUE_CHARS && !received.named.has(value), label: "",
  }));
}

/**
 * `text` with every value the child received, and each named value in any spelling (as written,
 * JSON-escaped, or with its whitespace changed), removed in one pass. Every match of every kind is
 * found on the original text and overlapping ones merge before anything is replaced: replacing an
 * inherited value first could break up a spelling of a named one that runs across it, and leave
 * the rest of that spelling to no later search. A span covering a received value is written
 * `[redacted]`, as `redactReceived` writes it; one covering only a spelling of a named value
 * names it, as `redactResolved` does.
 *
 * `dropBefore` is the margin of a buffer whose front was cut, dropped in the original text's
 * positions: a spelling that runs across it is removed whole. That needs `stderrMargin`, wide
 * enough to hold any spelling cut at the very front.
 */
export function redactChildText(text: string, received: ReceivedValues, named: readonly ResolvedValue[], dropBefore = 0): string {
  const values = named.filter(({ value }) => value !== "");
  if (values.length === 0) return redactReceived(text, received, dropBefore);
  const marker = resolvedMarker(values);
  return redactSpans(
    text,
    [...receivedTargets(received), ...values.map(({ name, value }) => ({ value, wholeToken: false, label: name }))],
    (labels) => (labels.includes("") ? "[redacted]" : marker(labels)),
    dropBefore,
    Number.POSITIVE_INFINITY,
    variantSpans(text, values),
  );
}

/**
 * A child's diagnostic output scrubbed for a record (`redactChildText`), then collapsed and
 * scrubbed again, because collapsing whitespace can turn a spacing variant into the value itself.
 */
export function scrubChildOutput(text: string, received: ReceivedValues, named: readonly ResolvedValue[], dropBefore = 0): string {
  const scrubbed = redactChildText(text, received, named, dropBefore);
  return redactChildText(scrubbed.replace(/\s+/g, " "), received, named).trim();
}

/**
 * Remove a selector's scratch directory, off the event loop. The call settles first and never
 * waits for this: a selector that left a large tree behind costs disk work in the background,
 * not latency for the dry run or for any other request. It never rejects.
 *
 * It never changes a permission. A directory the shaper locked is left behind and logged,
 * rather than unlocked: a path inside the scratch tree can be swapped for a symlink between a
 * read and a `chmod`, and Node has no `openat` to refuse that at the point of use, so an
 * unlock could change permissions outside the tree. Removal itself does not follow symlinks.
 */
export async function removeScratch(dir: string, scrub: (text: string) => string = (text) => text): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (error) {
    // A path inside the tree is named by the shaper and can repeat a value it was handed, so
    // the diagnostic goes through the call's redactor before it reaches the daemon's log.
    console.warn("[shaping] could not remove a selector's working directory:", scrub(dir),
      scrub(error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Stop whatever is left of the shaper's process group. Runs on every settle, success included:
 * a shaper can start a helper in its group with stdio of its own, answer, and exit, and nothing
 * else would ever stop that helper. Never throws; an empty group is the common case.
 */
function reapGroup(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* Nothing left in the group. */ }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** A `./` command, resolved against the shaper's own folder and kept inside it. */
export function folderCommand(command: string, root: string | null): { path: string } | { problem: string } {
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

export async function withTimeout<T>(pending: Promise<T>, ms: number, signal: AbortSignal): Promise<T | "late"> {
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
  // Monotonic, like the engine's budget: a wall-clock correction must not end a call early.
  const started = performance.now();
  const transport = shaper.transport;
  const env = shaperCommandEnv(process.env, transport.env, readToken(), ctx.trace, ctx.workUnitId);

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
  const cleanup = (scrub?: (text: string) => string) => { if (scratch) void removeScratch(scratch, scrub); };

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
  const remaining = ctx.timeoutMs - (performance.now() - started);
  if (remaining <= 0 || ctx.signal.aborted) {
    cleanup();
    return { kind: "timed_out", reason: `Timed out after ${seconds(ctx.timeoutMs)}.` };
  }

  // What the child is spawned with, which is what its output may repeat.
  // Values that carry a credential although nobody named them, such as an authenticated proxy
  // URL, count as named: removed from diagnostics wherever they appear, and from the reply's content.
  const credentials = credentialBearingValues(executable.env);
  const inheritedReceived = receivedValues(executable.env, transport.env);
  const received: ReceivedValues = {
    values: [...new Set([...inheritedReceived.values, ...credentials.map(({ value }) => value)])].sort((a, b) => b.length - a.length),
    named: new Set([...inheritedReceived.named, ...credentials.map(({ value }) => value)]),
  };
  // The named variables' values, each under its own name, for the reply's content.
  const namedValues: ResolvedValue[] = [
    ...transport.env
      .filter((name) => !carriedEnvName(name))
      // The child environment's own string only: an unset `constructor` must not read the
      // inherited function, which the reply's redactor would then treat as a string.
      .flatMap((name) => {
        const value = Object.hasOwn(executable.env, name) ? executable.env[name] : undefined;
        return typeof value === "string" && value !== "" ? [{ name, value }] : [];
      }),
    ...credentials,
  ];
  // The margin kept beyond the recorded stderr tail, and dropped from its front once it is cut,
  // wide enough for the longest spelling of any named value (`stderrMargin`).
  const margin = stderrMargin(received, namedValues);
  // For identifiers: everything but the short inherited values only whole-token rules apply to.
  const identifierValues: ReceivedValues = {
    values: received.values.filter((value) => value.length >= SHORT_VALUE_CHARS || received.named.has(value)),
    named: received.named,
  };
  return await new Promise<TransportReply>((settle) => {
    const out: Buffer[] = [];
    let outBytes = 0;
    // Kept a value's length beyond the recorded tail, so a value cut at the front of the buffer
    // is dropped with that margin instead of surviving as an unredacted fragment.
    let stderr = "";
    let stderrDropped = false;
    const stderrDecoder = new StringDecoder("utf8");
    let ending: "timed_out" | "overflow" | null = null;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let settled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let child: ChildProcess;
    const finish = (reply: TransportReply): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      releaseStdio(child as ChildProcess | undefined);
      reapGroup(child as ChildProcess | undefined);
      settle(reply);
      cleanup((text) => redactReceived(text, received));
    };
    const stderrTail = (): string => {
      // A named value with inner whitespace can be spelled with any amount of whitespace there,
      // so once the front was cut no margin bounds a spelling cut there: nothing is quoted.
      // So is one whose longest spelling needs more margin than is kept.
      if (stderrDropped && (!margin.covers || namedValues.some(({ value }) => /\s/.test(value)))) {
        return "its stderr is not quoted: it was too long to scrub safely";
      }
      // Once the front was cut, the first `margin.chars` characters may hold the tail end of a
      // value, in any spelling: they are dropped in the original text's positions.
      return scrubChildOutput(stderr, received, namedValues, stderrDropped ? margin.chars : 0).slice(-STDERR_TAIL_CHARS).trim();
    };
    const end = (why: "timed_out" | "overflow"): void => {
      if (ending || settled) return;
      // The shaper already exited inside its budget: its reply is complete, so a timer that
      // fires during the drain answers with it rather than turning it into a timeout.
      if (why === "timed_out" && exited) return complete(exited.code, exited.signal);
      ending = why;
      killGroup(child);
      // Both outcomes are known the moment they happen, and nothing more the pipes could deliver
      // changes either, so each settles at once. `finish` closes the daemon's ends of the pipes and
      // reaps the group, whoever holds them, so a timed-out call frees its process and pipes before
      // the engine hands its slot to the next call, and an overflow is never recorded as a timeout.
      finish(why === "timed_out"
        ? { kind: "timed_out", reason: `Timed out after ${seconds(ctx.timeoutMs)}.` }
        : { kind: "failed", reason: `The command printed more than ${COMMAND_OUTPUT_BYTES / 1024} KiB.` });
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
      const keep = STDERR_TAIL_CHARS + margin.chars;
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
    // Runs from child-process callbacks, where a throw would escape every handler and could stop
    // the daemon: whatever goes wrong while building the answer settles the call as failed.
    const complete = (code: number | null, signal: NodeJS.Signals | null): void => {
      // The drain may already have answered; the pipes' `close` that follows must not parse and
      // redact the reply a second time.
      if (settled) return;
      try {
        answer(code, signal);
      } catch (error) {
        finish({ kind: "failed", reason: `The reply could not be processed: ${error instanceof Error ? error.name : "error"}.` });
      }
    };
    const answer = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (ending === "timed_out") return finish({ kind: "timed_out", reason: `Timed out after ${seconds(ctx.timeoutMs)}.` });
      if (ending === "overflow") return finish({ kind: "failed", reason: `The command printed more than ${COMMAND_OUTPUT_BYTES / 1024} KiB.` });
      if (code === 0) {
        const text = Buffer.concat(out).toString("utf8");
        // A value the operator named in `env` is a credential the shaper may echo. It is removed
        // from the reply's own content, entries and facts included, before the engine sees it.
        let decoded: unknown = text;
        try { decoded = JSON.parse(text); } catch { /* The engine refuses it without its text. */ }
        const scrubbed = scrubResolved(decoded, namedValues);
        return finish({
          kind: "data",
          // The bytes as written when nothing was removed. Otherwise the scrubbed reply as the
          // decoded value it already is: serialising it again could throw on deep nesting, and
          // the engine validates a decoded value just as it does text.
          data: scrubbed.redacted ? scrubbed.data : text,
          ...(scrubbed.redacted ? { redacted: true } : {}),
          ...(scrubbed.notes.length > 0 ? { redactionNotes: scrubbed.notes } : {}),
          // The reply is the shaper's own text too: reasons built from it are scrubbed the same way.
          // A named value in any spelling, as its content was scrubbed, so the engine's reasons agree.
          redact: (text, options) => redactChildText(text, options?.identifier ? identifierValues : received, namedValues),
          holdsNamed: (text) => holdsResolvedValue(text, namedValues),
        });
      }
      // Only the child's own text is redacted, never the sentence Mission Control wraps it in.
      stderr += stderrDecoder.end();
      const tail = stderrTail();
      const detail = tail ? `: ${tail}` : "";
      const named = holdsResolvedValue(stderr, namedValues) || holdsResolvedValue(stderr.replace(/\s+/g, " "), namedValues);
      finish({
        kind: "failed", reason: signal ? `The command was killed by ${signal}${detail}` : `The command exited with code ${code}${detail}`,
        ...(named ? { redacted: true } : {}),
      });
    };
    // The shaper itself has exited. A helper still in its group could hold the pipes open, and
    // `close` would then wait for it until the timeout discarded a perfectly good reply. So the
    // group is stopped now, which normally lets `close` follow at once, and a bounded drain
    // answers with what was read if something outside the group still holds a pipe.
    child.once("exit", (code, signal) => {
      if (ending || settled) return;
      exited = { code, signal };
      reapGroup(child);
      // The drain never outlasts the call: a reply that arrived on time is returned on time,
      // with a margin so it reaches the engine before the deadline it enforces.
      const left = started + ctx.timeoutMs - performance.now() - EXIT_DEADLINE_MARGIN_MS;
      timers.push(setTimeout(() => complete(code, signal), Math.max(0, Math.min(EXIT_DRAIN_MS, left))));
    });
    child.once("close", (code, signal) => complete(code, signal));
    timers.push(setTimeout(() => end("timed_out"), remaining));
    if (ctx.signal.aborted) end("timed_out");
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
};
