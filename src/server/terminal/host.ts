import type { HostProcessSpec } from "./types.ts";

/**
 * The process-table half of correlation: which backend is hosting a tty, when the backend
 * itself cannot say.
 *
 * Pure, and generic over every backend - this file names no vendor, exactly as
 * `discovery/pane-dialog.ts` holds the menu grammar while a harness supplies its own cursor
 * glyph. An adapter declares what its GUI is CALLED (`HostProcessSpec`); the walking of the
 * process tree is machinery, and machinery that lived in one adapter would be machinery the
 * second one reimplemented slightly differently.
 *
 * It works on a structural subset of `discovery/processes.ts`'s `Proc` rather than importing
 * it, so the terminal layer keeps no dependency on discovery. `Proc` satisfies `HostProc`
 * structurally, so the call site passes its rows straight through.
 */

/** The columns of a process row this matcher needs. `Proc` satisfies it structurally. */
export interface HostProc {
  pid: number;
  ppid: number;
  /** Normalized without the `/dev/` prefix, or null when the process has no controlling tty. */
  tty: string | null;
  /** Full argv as reported by ps. */
  command: string;
}

/** How far up a parent chain to walk before assuming the table is lying to us. */
const MAX_DEPTH = 32;

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

/**
 * Every tty whose process sits, at any depth, under this backend's GUI.
 *
 * The weaker half of the join, and the one that makes a pane with no tty addressable at all.
 * A surface's shell is a child of the emulator process, so ancestry answers "which backend
 * is this tty inside" even when the backend cannot answer "which of my panes is that".
 *
 * Note what it deliberately does NOT catch, because the omission is load-bearing rather than
 * a gap: a multiplexer server is reparented to init, so an agent inside a tmux session
 * hosted in a Ghostty window does not walk up to Ghostty. The multiplexer keeps that pane -
 * which is correct, it is the inner and more specific handle - and the two axes cannot end
 * up fighting over one tty.
 */
export function ttysHostedBy(spec: HostProcessSpec, procs: readonly HostProc[]): Set<string> {
  const byPid = new Map<number, HostProc>();
  for (const p of procs) byPid.set(p.pid, p);

  const hosts = new Set<number>();
  for (const p of procs) if (isHostProcess(spec, p.command)) hosts.add(p.pid);
  if (hosts.size === 0) return new Set();

  const ttys = new Set<string>();
  for (const p of procs) {
    if (!p.tty) continue;
    let cur: HostProc | undefined = p;
    // A bounded walk, because a process table read non-atomically can hand back a pid whose
    // parent has been recycled - and an unbounded loop over `ppid` would then hang the tick.
    for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
      if (hosts.has(cur.pid)) {
        ttys.add(p.tty);
        break;
      }
      if (cur.ppid === cur.pid || cur.ppid <= 1) break;
      cur = byPid.get(cur.ppid);
    }
  }
  return ttys;
}
