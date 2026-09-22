import type { HostProcessSpec } from "./types.ts";

/** Pure process-name matching for the shared no-auto-launch enumeration gate. */

/** The columns of a process row this matcher needs. `Proc` satisfies it structurally. */
export interface HostProc {
  pid: number;
  ppid: number;
  /** Normalized without the `/dev/` prefix, or null when the process has no controlling tty. */
  tty: string | null;
  /** Full argv as reported by ps. */
  command: string;
}

/**
 * The basename of argv0 - the only part of a command line this module is allowed to read.
 *
 * Deliberately NOT a substring search over the whole line, and the reason is written in
 * blood one axis over: `DetectSpec.background` matched substrings until a dispatched
 * session's argv grew a state-dir path and a ~1.2KB inline prompt, at which point an
 * operator's directory name or a prompt quoting a flag decided the answer. A terminal is
 * recognised by what it IS, never by what some process is talking about.
 */
export function argv0Basename(command: string): string {
  const argv0 = command.trim().split(/\s+/)[0] ?? "";
  const path = argv0.startsWith("-") ? argv0.slice(1) : argv0;
  return path.split("/").pop() ?? "";
}

/** Whether one process is this backend's GUI. */
export function isHostProcess(spec: HostProcessSpec, command: string): boolean {
  const name = argv0Basename(command);
  return name !== "" && spec.commands.includes(name);
}

/**
 * Whether this backend's GUI is running at all.
 *
 * `enumerateTerminals` gates on it, which is what keeps a backend that scripts through Apple
 * Events off the poll tick when nobody is running it. That matters more than it sounds: a
 * `tell application` against an app that is NOT running LAUNCHES it, so an unguarded
 * enumeration would pop a terminal window onto the operator's desktop every 1500ms. The
 * alternative guard - asking System Events whether the process exists - measured ~160ms per
 * tick against ~0ms here, on a process list discovery has already paid for.
 *
 * This is not the "did it work last tick?" memo `binPresent` deliberately refuses to be. It
 * is a fresh reading of the live process table every time, so an operator who opens their
 * terminal is swept on the very next tick.
 */
export function hostIsRunning(spec: HostProcessSpec, procs: readonly HostProc[]): boolean {
  return procs.some((p) => isHostProcess(spec, p.command));
}
