import { run, type RunResult } from "../util/exec.ts";
import { normTty } from "./tty.ts";

/** One pane as reported by `tmux list-panes -a`. */
export interface TmuxPane {
  session: string;
  windowIndex: number;
  windowName: string;
  paneId: string; // e.g. "%3"
  panePid: number; // the pane's root process (usually the shell)
  /** tty normalized without /dev/, or null. */
  tty: string | null;
  currentCommand: string;
  currentPath: string;
}

const FMT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_tty}",
  "#{pane_current_command}",
  "#{pane_current_path}",
].join("\x1f"); // unit separator: safe against spaces in names/paths

const MODE_FMT = ["#{pane_in_mode}", "#{pane_mode}"].join("\x1f");

/**
 * The tmux mode a pane is sitting in (`copy-mode`, `view-mode`, ...), or null when it
 * is in none and keystrokes reach the child normally.
 *
 * This exists for the writers in `actions.ts`, which cannot tell the difference on
 * their own: a pane in a mode routes every key to tmux's OWN key table, so `send-keys`
 * and `paste-buffer` still exit 0 while the child receives nothing.
 *
 * Null is also the answer when the question can't be asked - no tmux, no such pane, or
 * a tmux too old to know these formats. That direction is deliberate. A probe that
 * cannot see a mode is not evidence of one, and treating an unrecognized probe as
 * "blocked" would refuse every write on such a system - a far worse failure than the
 * swallowed keystroke this exists to catch. Only an explicit `1` blocks.
 */
export async function readTmuxPaneMode(
  paneId: string,
  exec: (bin: string, args: string[]) => Promise<RunResult> = run,
): Promise<string | null> {
  const res = await exec("tmux", ["display-message", "-p", "-t", paneId, MODE_FMT]);
  if (res.code !== 0) return null;
  const [inMode, mode] = res.stdout.trim().split("\x1f");
  if (inMode?.trim() !== "1") return null;
  // `pane_mode` is empty on tmux versions that predate it. The pane is still in a mode,
  // so the flag alone has to be enough to block; naming it copy-mode is a guess, but it
  // is the one a person can act on (and the one it nearly always is) where "unknown mode"
  // would leave them nothing to clear.
  return mode?.trim() || "copy-mode";
}

/** One attached tmux client as reported by `tmux list-clients`. */
export interface TmuxClient {
  /** Client tty, e.g. "/dev/ttys028". Shared with the wezterm pane hosting it. */
  tty: string;
  /** Session the client is currently displaying. */
  session: string;
}

const CLIENT_FMT = ["#{client_tty}", "#{client_session}"].join("\x1f");

/**
 * List attached tmux clients across every session. Returns [] when tmux isn't
 * running or nothing is attached.
 */
export async function listTmuxClients(): Promise<TmuxClient[]> {
  const res = await run("tmux", ["list-clients", "-F", CLIENT_FMT]);
  if (res.code !== 0 || !res.stdout.trim()) return [];
  const clients: TmuxClient[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\x1f");
    if (f.length < 2) continue;
    const tty = f[0] ?? "";
    if (!tty) continue;
    clients.push({ tty, session: f[1] ?? "" });
  }
  return clients;
}

/**
 * List all tmux panes across every session. Returns [] when tmux isn't running
 * (no server / no sessions), which is the common case on a fresh machine.
 */
export async function listTmuxPanes(): Promise<TmuxPane[]> {
  const res = await run("tmux", ["list-panes", "-a", "-F", FMT]);
  if (res.code !== 0 || !res.stdout.trim()) return [];
  const panes: TmuxPane[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\x1f");
    if (f.length < 8) continue;
    panes.push({
      session: f[0] ?? "",
      windowIndex: Number(f[1] ?? 0),
      windowName: f[2] ?? "",
      paneId: f[3] ?? "",
      panePid: Number(f[4] ?? 0),
      tty: normTty(f[5] ?? ""),
      currentCommand: f[6] ?? "",
      currentPath: f[7] ?? "",
    });
  }
  return panes;
}
