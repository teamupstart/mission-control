import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { BinSpec } from "./types.ts";

/**
 * Reaching a backend's CLI, once: which binary, in what environment, and whether it is
 * installed at all.
 *
 * `resolveBin` is `resolveWeztermBin`'s body with the vendor taken out. It is separate from
 * the adapters so `config.ts` can keep its own exported helper while there is exactly one
 * implementation of the rule, rather than a fifth copy landing in the same change that
 * exists to stop copies multiplying.
 *
 * Nothing here is cached: an operator installing wezterm, or exporting `WEZTERM_BIN`, should
 * not have to restart the daemon, and the cost is a handful of `existsSync` calls on paths
 * that are almost always the first hit.
 */
export function resolveBin(spec: BinSpec): string {
  const override = spec.env ? process.env[spec.env] : undefined;
  if (override) return override;
  for (const c of spec.candidates) {
    // The bare name (no separator) cannot be tested with existsSync - it is resolved by
    // the OS against PATH at spawn time, which is what makes it the fallback.
    if (!c.includes("/")) continue;
    if (existsSync(c)) return c;
  }
  return spec.candidates[spec.candidates.length - 1] ?? "";
}

/**
 * The environment this backend's CLI should run in: the caller's, minus the vars that would
 * pin it to a server instance the daemon merely happens to have been launched inside.
 *
 * See `BinSpec.dropEnv` for why both shipped backends have one. Returns a copy, so a caller
 * merging its own vars in cannot mutate `process.env`.
 */
export function binEnv(spec: BinSpec, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of spec.dropEnv) delete env[key];
  return env;
}

/**
 * Whether this backend is installed at all - answered from the FILESYSTEM, never by running
 * anything.
 *
 * Discovery sweeps every registered backend on a 1500ms tick, and the cost of one that is
 * not installed has to stay near zero: a `fork` + `execve` that fails with ENOENT is ~1-3ms
 * and scales with the number of registered adapters, which is precisely the per-tick tax a
 * registry must not levy for merely knowing Ghostty exists. Walking PATH with `existsSync`
 * answers the same question for a few microseconds.
 *
 * A `true` is not a promise the CLI will succeed - wezterm installed with no GUI running
 * still fails, fast, by design (`--no-auto-start`). This only skips the backends that could
 * not possibly answer.
 */
export function binPresent(spec: BinSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  const bin = resolveBin(spec);
  if (!bin) return false;
  // An absolute or relative path either exists or does not; an env override is taken on
  // trust in `resolveBin`, so re-testing it here is what catches a stale `WEZTERM_BIN`.
  if (bin.includes("/")) return existsSync(bin);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return true;
  }
  return false;
}

/**
 * The specs live here, and not beside their adapters, for one reason: `config.ts` still
 * exports `resolveWeztermBin` for the call sites the migration has not reached, and this
 * module is the only home it can read the spec from without an import cycle
 * (`discovery/wezterm.ts` imports `config.ts`). One list of candidates, one resolver.
 */

/**
 * No env override, deliberately: tmux has no `TMUX_BIN` convention, so nothing invents one.
 * The bare name is the only candidate, which is what every inline `run("tmux", …)` call site
 * already assumes - this spec is where a real path goes if one is ever needed.
 *
 * **`dropEnv` is empty on purpose, and the temptation is `TMUX`.** It looks like the exact
 * counterpart of `WEZTERM_UNIX_SOCKET`: tmux reads it as `socket_path,pid,session_id` and
 * pins every client to that socket, so a daemon launched inside `tmux -L work` reaches only
 * that server. Verified against tmux 3.6b with two servers up - the same `tmux list-sessions`
 * answers differently depending on this one variable. Dropping it is still wrong, for two
 * reasons the wezterm case does not have:
 *
 *   - **wezterm's pin goes STALE; tmux's does not.** `gui-sock-<pid>` dies with the GUI that
 *     minted it, so the inherited value stops resolving and dropping it recovers the live
 *     default. A `TMUX` socket is alive by construction - the daemon is running inside it.
 *     Dropping it does not restore reachability, it just picks a DIFFERENT live server, and
 *     "every session on the machine" is not on offer either way: a tmux client talks to
 *     exactly one socket.
 *   - **Enumeration and actuation have to agree.** The ~19 inline `run("tmux", …)` writes in
 *     `actions.ts`, `dispatcher.ts` and `pane-capture.ts` inherit `TMUX` and this migration
 *     item does not reach them. Scrubbing it here alone splits the two: cards would be built
 *     from one server's pane ids while `send-keys -t %3` and `kill-session -t <name>` landed
 *     on another server's `%3`. `tmuxSendKeys` is the sharpest version - it would probe
 *     copy-mode on one server and write to another, so the guard reads "no such pane", fails
 *     open, and silently stops guarding.
 *
 * So an empty list is a DECLARATION, like a null capability: this backend has nothing to
 * scrub. If `TMUX` is ever dropped it belongs in the same commit that routes those writes
 * through this spec, not ahead of it.
 */
export const TMUX_BIN: BinSpec = {
  env: null,
  candidates: ["tmux"],
  dropEnv: [],
};

/**
 * `WEZTERM_UNIX_SOCKET` is dropped because a daemon launched from inside a wezterm pane
 * inherits that pane's socket, pinned to one GUI instance's mux. If that GUI later exits or
 * restarts (a new `gui-sock-<pid>`), the inherited socket goes stale and every `wezterm cli`
 * call fails - so all wezterm tabs fall back to `claude <pid>` names and Focus cannot raise
 * them. Dropping it lets wezterm resolve its live default socket, exactly as a plain shell
 * would.
 */
export const WEZTERM_BIN: BinSpec = {
  env: "WEZTERM_BIN",
  candidates: ["/Applications/WezTerm.app/Contents/MacOS/wezterm", "wezterm"],
  dropEnv: ["WEZTERM_UNIX_SOCKET"],
};
