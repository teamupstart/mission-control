import { run, type RunResult } from "../util/exec.ts";
import { resolveWeztermBin } from "../config.ts";
import { binEnv, WEZTERM_BIN } from "../terminal/bin.ts";

/**
 * The wezterm commands the terminal migration has not reached yet: focus, spawn and retitle,
 * plus the cwd URL conversion both sides need.
 *
 * Enumeration used to live here too and now belongs to the adapter
 * (`terminal/wezterm.ts`), which is what let discovery stop importing two vendors by name.
 * What is left is called from `actions.ts` as well as from the adapter, so it stays put
 * until that file moves behind the interface - at which point this module goes away
 * entirely.
 */

/**
 * Run a `wezterm cli` subcommand against the live default mux. `--no-auto-start`
 * makes it fail fast when no GUI is running instead of blocking ~2.5s trying to
 * spawn a mux server, so discovery degrades silently as promised.
 *
 * `binEnv` drops the inherited `WEZTERM_UNIX_SOCKET` - see `WEZTERM_BIN.dropEnv`, which is
 * where that rule now lives so tmux could be given the same treatment for the same reason.
 */
function weztermCli(bin: string, args: string[]): Promise<RunResult> {
  return run(bin, ["cli", "--no-auto-start", ...args], { env: binEnv(WEZTERM_BIN) });
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
