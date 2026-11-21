import { FIXED_OS_EXECUTABLES } from "./executables/catalog.ts";
import { appleScriptString, appleScriptText } from "./terminal/applescript.ts";
import { run } from "./util/exec.ts";

/**
 * How a dispatched worker receives turn one, and how many bytes that path can carry.
 *
 * Task shaping adds a section to turn one, so the dispatcher budgets it against what the rest
 * of turn one leaves on the path that will carry it. A path with no ceiling budgets nothing
 * and the configured total applies. A path with one never fails a launch that works today:
 * the section is cut to what fits instead, and the record says so.
 *
 * - `driver`: an embedded driver (Claude's stream-json stdin, Codex's app-server JSON-RPC,
 *   Pi in-process). The prompt is a message, not an argument.
 * - `paste`: a terminal pane. tmux and wezterm read the text from stdin, Herdr and cmux from a
 *   socket message, iTerm2 and Ghostty from an AppleScript on macOS, where no single argument
 *   has a limit of its own.
 * - `launch-argument`: Pi's terminal launch, whose turn one is the positional message of its
 *   argv. Bounded per argument by the kernel where one is enforced, and with every other
 *   argument and environment string by the platform's combined limit, `ARG_MAX`.
 */
export type TurnOneDelivery =
  | { path: "driver"; maxBytes: null }
  | { path: "paste"; maxBytes: null }
  | { path: "launch-argument"; maxBytes: number | null };

/** Each runtime's path, declared by the harness entry that owns it. */
export interface TurnOneDeliverySpec {
  sdk: TurnOneDelivery;
  terminal: TurnOneDelivery;
}

/**
 * The largest single argument the kernel accepts, terminator excluded, or null where no
 * per-argument limit exists. Linux enforces `MAX_ARG_STRLEN`, 32 pages of 4 KiB including the
 * terminating NUL; macOS bounds only the combined size.
 */
export function launchArgumentCeiling(platform: NodeJS.Platform = process.platform): number | null {
  return platform === "linux" ? 32 * 4096 - 1 : null;
}

export const DRIVER_TURN_ONE: TurnOneDelivery = Object.freeze({ path: "driver", maxBytes: null });
export const PASTE_TURN_ONE: TurnOneDelivery = Object.freeze({ path: "paste", maxBytes: null });
export function launchArgumentTurnOne(platform: NodeJS.Platform = process.platform): TurnOneDelivery {
  return { path: "launch-argument", maxBytes: launchArgumentCeiling(platform) };
}

/** Bytes kept back for the separator that joins the section to turn one. */
export const SECTION_JOIN_MARGIN = 64;
/**
 * What `execve` charges beyond argv and envp. Linux copies the executable's pathname as a string
 * of its own, and a `#!` entry point (Pi's CLI is a script) has the kernel insert the
 * interpreter, its optional argument and the script path again before exec'ing the interpreter.
 * Each interpreter string is bounded by the 256-byte `#!` line.
 */
const SHEBANG_LINE_BYTES = 256;
/**
 * Room kept for the terminal server's own environment. The agent inherits it, and a reused
 * server can hold variables the daemon never had, which cannot be read before the launch. This
 * is an estimate that keeps ordinary launches from needing the fallback. The guarantee is the
 * launch wrapper's check at exec, under the pane's real environment, which runs the original
 * turn one when the shaped one would not fit (`fittingLaunch` in `agent-subprocess-env.ts`).
 */
export const TERMINAL_ENV_RESERVE = 64 * 1024;
/** Room kept for the AppleScript a pane paste wraps its text in: the tell block and its target. */
const APPLESCRIPT_WRAPPER_RESERVE = 4096;
/** What `execve` charges per argument or environment pointer on a 64-bit platform. */
const POINTER_BYTES = 8;

function utf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** One string as `execve` counts it: its bytes, its terminator and its pointer. */
function execString(value: string): number {
  return utf8(value) + 1 + POINTER_BYTES;
}

export interface LaunchArgumentLaunch {
  /** Every argument of the launch except turn one, the program itself included. */
  otherArgs: readonly string[];
  /** Every environment variable the launched program receives. */
  env: Readonly<Record<string, string | undefined>>;
  /** The platform's combined limit for arguments and environment, or null when unknown. */
  argMax: number | null;
}

export interface TurnOneAllowance {
  /** What the section may add, the join margin already taken off. Never below 0. */
  maxSectionBytes: number;
  /** Why the section has this little room, for the record. */
  reason: string;
}

/**
 * The room a launch leaves for the shaping section, or null when its path has no ceiling.
 *
 * `turnOne` is the larger of the launch's turn-one variants exactly as the path carries it.
 * For a launch argument the allowance is the smaller of two remainders: the per-argument
 * ceiling less turn one, and the combined limit less every other argument, every environment
 * string and turn one itself, each counted with its terminator and pointer.
 */
export function turnOneAllowance(
  delivery: TurnOneDelivery,
  turnOne: string,
  launch: LaunchArgumentLaunch | null,
): TurnOneAllowance | null {
  if (delivery.path !== "launch-argument") return null;
  const bytes = utf8(turnOne);
  const remainders: Array<{ room: number; reason: string }> = [];
  if (delivery.maxBytes !== null) {
    remainders.push({
      room: delivery.maxBytes - bytes,
      reason: `turn one travels as one launch argument, which this platform caps at ${delivery.maxBytes} bytes`,
    });
  }
  // A launch argument always shares the combined limit with the rest of the launch. When that
  // limit, or the launch around turn one, cannot be measured, there is no safe room to promise:
  // the section is withheld rather than guessed at, so shaping can never turn a launch that
  // works today into an `E2BIG`. Both the per-argument and the combined check need a measure.
  if (launch?.argMax == null) {
    return {
      maxSectionBytes: 0,
      reason: "turn one travels as a launch argument and the platform's combined argument limit could not be measured",
    };
  }
  const others = launch.otherArgs.reduce((sum, arg) => sum + execString(arg), 0);
  remainders.push({
    room: launch.argMax - others - execImageBytes(launch.otherArgs[0] ?? "") - environmentBytes(launch.env)
      - TERMINAL_ENV_RESERVE - execString(turnOne),
    reason: `the launch's arguments and environment share this platform's ${launch.argMax}-byte limit`,
  });
  const tightest = remainders.reduce((a, b) => (b.room < a.room ? b : a));
  return { maxSectionBytes: Math.max(0, tightest.room - SECTION_JOIN_MARGIN), reason: tightest.reason };
}

function environmentBytes(env: Readonly<Record<string, string | undefined>>): number {
  return Object.entries(env).reduce((sum, [name, value]) => value === undefined ? sum : sum + execString(`${name}=${value}`), 0);
}

/** The executable's pathname, and for a `#!` entry point the interpreter's strings (see above). */
function execImageBytes(program: string): number {
  return 2 * execString(program) + 2 * (SHEBANG_LINE_BYTES + 1 + POINTER_BYTES);
}

/** Terminal backends whose paste is an `osascript -e` argument. Both are macOS-only. */
const APPLESCRIPT_PASTE_BACKENDS: ReadonlySet<string> = new Set(["ghostty", "iterm"]);

/**
 * Whether a pane paste on this backend travels as an argument. `null` is an automatic choice,
 * which on macOS may land on either AppleScript backend, so it is treated as one.
 */
export function pasteTravelsAsArgument(backend: string | null, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && (backend === null || APPLESCRIPT_PASTE_BACKENDS.has(backend));
}

/**
 * Whether `turnOne`, pasted through AppleScript, stays under the combined limit with this
 * environment. Measured with both encoders the AppleScript backends use, so whichever one the
 * pane is on, the `osascript -e` argument is no larger than this counts. Null `argMax`: unknown,
 * so it does not fit.
 */
export function appleScriptPasteFits(turnOne: string, env: Readonly<Record<string, string | undefined>>, argMax: number | null): boolean {
  if (argMax == null) return false;
  const encoded = Math.max(utf8(appleScriptString(turnOne)), utf8(appleScriptText(turnOne))) + APPLESCRIPT_WRAPPER_RESERVE;
  const total = execImageBytes(FIXED_OS_EXECUTABLES.osascript) + execString(FIXED_OS_EXECUTABLES.osascript) + execString("-e")
    + encoded + 1 + POINTER_BYTES + environmentBytes(env);
  return total <= argMax;
}

/** How long a failed `getconf` probe is remembered before a later launch asks again. */
const ARG_MAX_RETRY_MS = 60_000;
let argMax: Promise<number | null> | null = null;
let argMaxFailedAt: number | null = null;

/**
 * `ARG_MAX`, read with `getconf` and kept once it has been read. A probe that fails, for example
 * one that timed out under load, is retried by a launch at least a minute later rather than
 * withholding context until the daemon restarts. Null while it cannot be read, and a launch
 * argument then carries no section (see `turnOneAllowance`).
 */
export function platformArgMax(
  probe: () => Promise<number | null> = readArgMax,
  now: () => number = Date.now,
): Promise<number | null> {
  if (argMax && (argMaxFailedAt === null || now() - argMaxFailedAt < ARG_MAX_RETRY_MS)) return argMax;
  argMaxFailedAt = null;
  const pending = probe().catch(() => null).then((value) => {
    if (value === null) argMaxFailedAt = now();
    return value;
  });
  argMax = pending;
  return pending;
}

/** Forget the cached probe, for a test that drives `platformArgMax` from the start. */
export function resetPlatformArgMaxForTests(): void {
  argMax = null;
  argMaxFailedAt = null;
}

async function readArgMax(): Promise<number | null> {
  const result = await run(FIXED_OS_EXECUTABLES.getconf, ["ARG_MAX"], { timeoutMs: 2000 });
  const value = Number.parseInt(result.stdout.trim(), 10);
  return result.code === 0 && Number.isSafeInteger(value) && value > 0 ? value : null;
}
