import { FIXED_OS_EXECUTABLES } from "./executables/catalog.ts";
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
  if (launch?.argMax != null) {
    const others = launch.otherArgs.reduce((sum, arg) => sum + execString(arg), 0);
    const environment = Object.entries(launch.env)
      .reduce((sum, [name, value]) => value === undefined ? sum : sum + execString(`${name}=${value}`), 0);
    remainders.push({
      room: launch.argMax - others - environment - execString(turnOne),
      reason: `the launch's arguments and environment share this platform's ${launch.argMax}-byte limit`,
    });
  }
  if (remainders.length === 0) return null;
  const tightest = remainders.reduce((a, b) => (b.room < a.room ? b : a));
  return { maxSectionBytes: Math.max(0, tightest.room - SECTION_JOIN_MARGIN), reason: tightest.reason };
}

let argMax: Promise<number | null> | null = null;

/** `ARG_MAX`, read once with `getconf`. Null when it cannot be read, which budgets nothing extra. */
export function platformArgMax(): Promise<number | null> {
  argMax ??= run(FIXED_OS_EXECUTABLES.getconf, ["ARG_MAX"], { timeoutMs: 2000 })
    .then((result) => {
      const value = Number.parseInt(result.stdout.trim(), 10);
      return result.code === 0 && Number.isSafeInteger(value) && value > 0 ? value : null;
    })
    .catch(() => null);
  return argMax;
}
