import { run } from "../util/exec.ts";

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

function normTty(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  return t.replace(/^\/dev\//, "");
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
