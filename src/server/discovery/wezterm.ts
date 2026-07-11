import { run, type RunResult } from "../util/exec.ts";
import { resolveWeztermBin } from "../config.ts";

/** One pane as reported by `wezterm cli list --format json`. */
export interface WeztermPane {
  paneId: number;
  tabId: number;
  windowId: number;
  tabTitle: string;
  windowTitle: string;
  cwd: string; // wezterm reports a file:// URL
  /** tty normalized without /dev/ (e.g. "ttys012"), or null. */
  tty: string | null;
  isActive: boolean;
}

// Field names in wezterm's JSON are snake_case; this is the subset we use.
interface RawPane {
  window_id: number;
  tab_id: number;
  pane_id: number;
  tab_title?: string;
  window_title?: string;
  cwd?: string;
  tty_name?: string;
  is_active?: boolean;
}

function normTty(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  return t.replace(/^\/dev\//, "");
}

/**
 * Environment for wezterm CLI calls, with `WEZTERM_UNIX_SOCKET` stripped.
 *
 * When the daemon is launched from inside a wezterm pane it inherits that pane's
 * `WEZTERM_UNIX_SOCKET`, which pins the CLI to *that* GUI instance's mux socket.
 * If the pane's GUI later exits/restarts (a new `gui-sock-<pid>`), the inherited
 * socket goes stale and every `wezterm cli` call fails - so all wezterm tabs fall
 * back to `claude <pid>` names and Focus can't raise them. Dropping the var lets
 * wezterm resolve its live default socket, exactly as a plain shell would.
 */
export function weztermEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.WEZTERM_UNIX_SOCKET;
  return env;
}

/**
 * Run a `wezterm cli` subcommand against the live default mux. `--no-auto-start`
 * makes it fail fast when no GUI is running instead of blocking ~2.5s trying to
 * spawn a mux server, so discovery degrades silently as promised.
 */
function weztermCli(bin: string, args: string[]): Promise<RunResult> {
  return run(bin, ["cli", "--no-auto-start", ...args], { env: weztermEnv() });
}

/**
 * List wezterm panes across the mux. Returns [] when wezterm isn't running or
 * the CLI isn't reachable - the harness works fine with tmux-only or bare
 * terminals, so this must degrade silently.
 */
export async function listWeztermPanes(): Promise<WeztermPane[]> {
  const bin = resolveWeztermBin();
  const res = await weztermCli(bin, ["list", "--format", "json"]);
  if (res.code !== 0 || !res.stdout.trim()) return [];
  let raw: RawPane[];
  try {
    raw = JSON.parse(res.stdout) as RawPane[];
  } catch {
    return [];
  }
  return raw.map((p) => ({
    paneId: p.pane_id,
    tabId: p.tab_id,
    windowId: p.window_id,
    tabTitle: (p.tab_title ?? "").trim(),
    windowTitle: (p.window_title ?? "").trim(),
    cwd: p.cwd ?? "",
    tty: normTty(p.tty_name),
    isActive: Boolean(p.is_active),
  }));
}

/** Raise a wezterm tab and pane so it's frontmost. */
export async function activateWeztermPane(tabId: number, paneId: number): Promise<RunResult> {
  const bin = resolveWeztermBin();
  await weztermCli(bin, ["activate-tab", "--tab-id", String(tabId)]);
  return weztermCli(bin, ["activate-pane", "--pane-id", String(paneId)]);
}

/**
 * Open a new wezterm tab running `argv`, give its tab an explicit `title`, and
 * return the new pane id. Returns null when wezterm isn't reachable or the spawn
 * fails, so callers can degrade instead of throwing.
 */
export async function spawnWeztermTab(argv: string[], title: string): Promise<number | null> {
  const bin = resolveWeztermBin();
  const res = await weztermCli(bin, ["spawn", "--", ...argv]);
  if (res.code !== 0) return null;
  const paneId = Number(res.stdout.trim());
  if (!Number.isInteger(paneId)) return null;
  if (title) await weztermCli(bin, ["set-tab-title", "--pane-id", String(paneId), title]);
  return paneId;
}

/**
 * Find the wezterm pane that already hosts a tmux client for `session`, so Focus
 * can raise that tab instead of opening a new one. A wezterm pane running
 * `tmux attach` shares its tty with the tmux client, so we match on that shared
 * tty (tmux reports it as `/dev/ttysNN`, wezterm strips the `/dev/`). Returns
 * the first match (deterministic in input order), or null.
 */
export function findSessionHostPane(
  session: string,
  clients: { tty: string; session: string }[],
  panes: WeztermPane[],
): WeztermPane | null {
  const ttys = new Set(
    clients.filter((c) => c.session === session).map((c) => c.tty.replace(/^\/dev\//, "")),
  );
  for (const p of panes) if (p.tty && ttys.has(p.tty)) return p;
  return null;
}

/** Convert wezterm's `file://host/path` cwd URL to a plain filesystem path. */
export function weztermCwdToPath(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const u = new URL(cwd);
    if (u.protocol === "file:") return decodeURIComponent(u.pathname);
  } catch {
    /* fall through */
  }
  return cwd || null;
}
