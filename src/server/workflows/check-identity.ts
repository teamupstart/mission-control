import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// "This exact process, not a recycled pid" - the one question every signal a check sends has
// to answer first.
//
// A check supervisor's pid is written to a durable row and read back minutes later, possibly
// by a different daemon after a crash. Between those two moments the operating system is free
// to hand that number to somebody else, and a `kill(-pid)` on a recycled pid does not fail
// loudly - it terminates a stranger's process group. Nothing in Node answers this: there is
// no built-in for a process's start time, so it is read per platform, and where it cannot be
// read the honest answer is to refuse to start rather than to start something we could never
// prove was dead.

/**
 * The separator between the halves of the composite - ASCII UNIT SEPARATOR.
 *
 * Built from its code point rather than written as an escape so the source file carries no
 * invisible character. Both halves are normalised to contain no control characters at all,
 * which is what makes the join unambiguous: nothing inside a half can be mistaken for it.
 */
const HALF = String.fromCharCode(0x1f);

/**
 * Collapse every control character and whitespace run to single spaces.
 *
 * Applied to both halves before joining. Linux hands back a NUL-separated argv and macOS's
 * `ps` pads `lstart` to a fixed width; neither difference is information, and flattening both
 * is what lets an identity be compared as one opaque string.
 */
function normalise(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * The command-line half, condensed to a fixed-width digest.
 *
 * The supervisor's command line carries the shim's whole source in `node -e`, which is a few
 * kilobytes - and this string is written to a durable column on a table whose rows are RETAINED
 * for audit. Storing the digest keeps that column small and keeps the shim's source out of the
 * database, at no cost to the property that matters: the only question ever asked of an
 * identity is whether it equals another one, and equal command lines digest equally.
 *
 * Not a security boundary and not trying to be. It is a length-reduction of a string this
 * process produced, compared against itself.
 */
function condense(commandLine: string): string {
  return createHash("sha256").update(commandLine).digest("hex").slice(0, 32);
}

/**
 * An opaque, comparable token for "this exact process", or null when it cannot be read.
 *
 * ## It is a COMPOSITE, and it has to be
 *
 * No shell-reachable start-time field on either platform has the resolution to stand alone.
 * `ps -o lstart=` is whole-SECOND; Linux's `starttime` is clock ticks, typically 10ms. A pid
 * recycled inside that window compares equal, and signalling a stranger's process group is
 * the single thing this function exists to prevent. So the identity is
 * `(start-time field, command line)`, and the supervisor's shim takes the attempt id as an
 * argument specifically so the second half is unique to one attempt. A false match then
 * requires the same pid, started in the same second, running our shim, for an attempt id only
 * one supervisor is ever created for - which is a structural argument rather than a
 * probabilistic one.
 *
 * That is also why the supervisor forks the branch command rather than `exec`ing it. An
 * `exec` would replace the command line, every later read would mismatch on a group that is
 * very much alive, and the lease would be stranded with a live process still writing into it.
 *
 * ## Half an identity is a failure, not a result
 *
 * If either half is unreadable the whole thing is null. A half-identity that compared equal
 * on a timestamp alone is precisely the failure mode the composite exists to remove, so it
 * must never be allowed to look like a successful read.
 *
 * SYNCHRONOUS on purpose, and it costs one `ps` on macOS. The gate that records this must not
 * yield between reading identity and persisting it, and the last-resort `exit` hook cannot
 * await anything at all.
 */
export function processStartIdentity(pid: number): string | null {
  // Only 0 and below are refused, and the bound is deliberately LOOSER than the one guarding
  // the signals in `check-group.ts`. That one refuses `pid <= 1` because `kill(-0)` and
  // `kill(-1)` are wildcards that would signal the daemon's own process group or every process
  // this user owns. Reading pid 1's identity signals nothing and is a perfectly ordinary
  // question - and it is the question the platform preflight asks about the DAEMON, which is
  // pid 1 whenever it runs as a container's entrypoint. Refusing it here reported every
  // containerised Linux daemon as a platform that cannot run checks at all.
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxIdentity(pid);
  if (process.platform === "darwin") return darwinIdentity(pid);
  return null;
}

/**
 * Field 22 of `/proc/<pid>/stat` plus `/proc/<pid>/cmdline`. Two cheap reads, no subprocess.
 *
 * The `comm` field is parenthesised and may itself contain spaces and parentheses, so the
 * split starts after the LAST `)` - the documented way to parse this file. Fields resume at
 * `state` (field 3) from there, which puts `starttime` (field 22) at index 19.
 */
function linuxIdentity(pid: number): string | null {
  let start: string;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    start = tail[19] ?? "";
  } catch {
    return null;
  }
  if (!/^\d+$/.test(start)) return null;
  let cmdline: string;
  try {
    // NUL-separated argv. `normalise` turns the separators into spaces, which is all this
    // needs: the string is compared against itself and never parsed back into arguments.
    cmdline = normalise(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return null;
  }
  if (!cmdline) return null;
  return `${process.platform}${HALF}${start}${HALF}${condense(cmdline)}`;
}

/**
 * `ps -ww -o lstart=,command=` - ONE subprocess for both halves, so the composite costs no
 * more than a single field would have.
 *
 * `-ww` is not optional: without it macOS clips the line to the terminal width, which would
 * silently truncate the command line whose uniqueness the whole scheme rests on. `lstart` is
 * printed to a fixed width and `command` renders control characters as escape TEXT, both of
 * which are deterministic - an identity only ever has to equal itself.
 */
function darwinIdentity(pid: number): string | null {
  let raw: string;
  try {
    raw = execFileSync("ps", ["-ww", "-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      // stderr discarded: a dead pid is an ordinary answer here, not something to print.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // A non-zero exit means no such process, which is a null identity rather than an error.
    return null;
  }
  const line = normalise(raw);
  // `lstart` is five whitespace-separated tokens (`Fri Jul 31 15:15:37 2026`); a line with
  // nothing after them is not a row we understand, and guessing at a half-read one is the
  // exact thing this function must not do.
  const tokens = line.split(" ");
  if (tokens.length < 6) return null;
  const start = tokens.slice(0, 5).join(" ");
  const command = tokens.slice(5).join(" ");
  if (!start || !command) return null;
  return `${process.platform}${HALF}${start}${HALF}${condense(command)}`;
}

export interface CheckRuntimeSupport {
  supported: boolean;
  /** The sentence an unsupported platform reports. Empty when supported. */
  note: string;
}

let cachedSupport: CheckRuntimeSupport | undefined;

/**
 * Whether checks may run on this machine at all, answered once and cached.
 *
 * Two questions, and both have to be yes:
 *
 *  1. Is this a platform with POSIX process groups? Everything downstream signals `-pid`, and
 *     Windows has no such thing.
 *  2. Can we actually read a process start identity - proven by reading our OWN? A platform
 *     string is a guess; a container with no `/proc` mounted, or an image with no `ps`,
 *     answers that guess wrong. Probing the live daemon asks the same question the check will
 *     ask, cheaply, once.
 *
 * **Where the answer is no, checks do not run.** The executor reports `unavailable` with a
 * sentence naming the platform, which routes into the already-tested third passing outcome -
 * "a gate no runtime can serve" - and is the same honest degradation the null executor ships
 * today.
 *
 * This is a deliberate departure from the source plan, which treats unreadable identity as a
 * recovery-time uncertainty to be held open. That is right for a TRANSIENT failure and wrong
 * as a PLATFORM answer: held open forever it would strand a pooled worktree on every crash,
 * permanently, on a machine where identity is never readable. Refusing to start is strictly
 * safer than starting something we could never prove is dead.
 */
export function checkRuntimeSupport(): CheckRuntimeSupport {
  return (cachedSupport ??= computeSupport());
}

/** Test-only: forget the cached probe so a case can vary the platform beneath it. */
export function resetCheckRuntimeSupportCache(): void {
  cachedSupport = undefined;
}

function computeSupport(): CheckRuntimeSupport {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return {
      supported: false,
      note:
        "Check commands run only on Linux and macOS, and this daemon is on " +
        `${process.platform}, so the gate was recorded and passed.`,
    };
  }
  if (processStartIdentity(process.pid) === null) {
    return {
      supported: false,
      note:
        `This daemon cannot read process start identities on ${process.platform}, so a check ` +
        "command could not be proven finished after running and the gate was recorded and passed.",
    };
  }
  return { supported: true, note: "" };
}
