import { run, type RunResult } from "../util/exec.ts";
import { resolveWeztermBin } from "../config.ts";
import { normTty } from "./tty.ts";

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
 * Open a new wezterm tab running `argv`, give its tab an explicit `title`, and report both
 * the new pane id and the spawn's own `RunResult`.
 *
 * The two answers are separate because a null pane id has three causes that call for
 * different recoveries: wezterm refused, wezterm never answered (the CLI was killed after
 * the compositor may already have opened the tab - see `RunResult.outcomeUnknown`), or the
 * tab opened and its id was unreadable. Collapsing them into one null is how a caller comes
 * to treat "we never found out" as positive evidence that no tab exists and opens a second.
 */
export async function spawnWeztermTabResult(
  argv: string[],
  title: string,
): Promise<{ paneId: number | null; result: RunResult }> {
  const bin = resolveWeztermBin();
  const result = await weztermCli(bin, ["spawn", "--", ...argv]);
  if (result.code !== 0) return { paneId: null, result };
  const paneId = Number(result.stdout.trim());
  if (!Number.isInteger(paneId)) return { paneId: null, result };
  if (title) await setWeztermTabTitle(paneId, title);
  return { paneId, result };
}

/**
 * The new pane id only. Returns null when wezterm isn't reachable or the spawn fails, so
 * callers can degrade instead of throwing. Callers that must tell a refusal from a silence
 * want `spawnWeztermTabResult`.
 */
export async function spawnWeztermTab(argv: string[], title: string): Promise<number | null> {
  return (await spawnWeztermTabResult(argv, title)).paneId;
}

/**
 * Rename the tab a pane lives in by setting its explicit tab title, the value
 * `wezterm cli list` reports back as `tab_title` and discovery reads as the card
 * name. This is the same override `spawnWeztermTab` applies to a fresh tab.
 *
 * `--` ends flag parsing so a title like "-wip" is read as the title rather than
 * as a flag bundle.
 */
export async function setWeztermTabTitle(paneId: number, title: string): Promise<RunResult> {
  const bin = resolveWeztermBin();
  return weztermCli(bin, ["set-tab-title", "--pane-id", String(paneId), "--", title]);
}

/**
 * Find every wezterm pane hosting a tmux client for `session`. A wezterm pane
 * running `tmux attach` shares its tty with the tmux client, so we match on that
 * shared tty (tmux reports it as `/dev/ttysNN`, wezterm strips the `/dev/`).
 *
 * This tty join is the ONLY link between a tmux session and the tab showing it:
 * the agent inside tmux sits on a tmux *pane* tty while the tab sits on the
 * *client* tty, so `correlate` - which keys off the agent's tty - never gives a
 * tmux-hosted session a `wezterm` handle. Anything that needs the visible tab
 * (Focus raising it, Rename retitling it) has to come through here.
 *
 * Returns matches in input order, so callers wanting just one get a
 * deterministic pick.
 */
export function findSessionHostPanes(
  session: string,
  clients: { tty: string; session: string }[],
  panes: WeztermPane[],
): WeztermPane[] {
  const ttys = new Set(
    clients.filter((c) => c.session === session).map((c) => c.tty.replace(/^\/dev\//, "")),
  );
  return panes.filter((p) => p.tty && ttys.has(p.tty));
}

/**
 * The first wezterm pane hosting a tmux client for `session`, so Focus can raise
 * that tab instead of opening a new one. Null when no tab hosts it.
 */
export function findSessionHostPane(
  session: string,
  clients: { tty: string; session: string }[],
  panes: WeztermPane[],
): WeztermPane | null {
  return findSessionHostPanes(session, clients, panes)[0] ?? null;
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
