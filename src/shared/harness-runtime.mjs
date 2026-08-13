// Single source of truth for the daemon's runtime coordinates - port, host, and
// the state-dir/token paths - plus the harness's lease identity and the tiny client
// helpers the hook and the MCP bridge both need to reach the daemon.
//
// This is plain JavaScript (.mjs) on purpose: the Claude hook (hooks/harness-hook.mjs)
// runs under bare `node` at hook-invocation time with no build step, so it cannot
// import the TypeScript config. Every consumer - the daemon (via src/server/config.ts),
// the MCP bridge (src/mcp/server.ts, bundled by esbuild), the hook, the service
// installer, scripts/new-session.mjs, and vite.config.ts - imports this file so the
// port, token path, and lease holder can never drift. A drift here fails silently
// (the hook swallows fetch errors; a mismatched lease holder just stops the reaper
// from ever matching), which is exactly why these must live in one place. A .d.mts
// alongside gives the TS side types.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Read a config env var by its `MISSION_` name, falling back to the names this app
 * used before - `FLEET_` (Fleet Control), then `HARNESS_` (ai-harness) - so an
 * existing install's environment keeps working across both renames. Prefer setting
 * the `MISSION_` names going forward.
 *
 * Oldest-last, and every one kept: these are read by the Claude hook and the MCP
 * bridge, which are installed into `~/.claude/settings.json` ONCE and keep running
 * with whatever environment they were installed with. Dropping a prefix wouldn't
 * fail loudly - the hook swallows its fetch errors - it would just quietly stop
 * reporting until someone reinstalled it.
 */
export function envVar(suffix) {
  return (
    process.env[`MISSION_${suffix}`] ??
    process.env[`FLEET_${suffix}`] ??
    process.env[`HARNESS_${suffix}`]
  );
}

/** Port the daemon binds on (loopback only). */
export const PORT = Number(envVar("PORT") ?? 7317);

/** Loopback host the daemon binds to. */
export const HOST = "127.0.0.1";

/** Base URL clients use to reach the daemon. */
export const BASE_URL = `http://${HOST}:${PORT}`;

/**
 * The holder this app records on every treehouse lease it takes.
 *
 * It lives here, on the shared surface, because the code that TAKES a lease spans
 * the build boundary - `scripts/new-session.mjs` runs under bare `node`, the
 * dispatcher is TypeScript - while the code that decides a lease may be RETURNED
 * (the reap gate in src/server/pool.ts) is a third site again. All three have to
 * agree on this string, and disagreement is silent either way: a lease site that
 * drifts stamps a label the gate reads as a stranger's, so the abandoned leases the
 * sweep exists to collect become permanently uncollectable with no error; a gate
 * that drifts points at leases we never took. One import, no drift.
 */
export const LEASE_HOLDER = "mission-control";

/**
 * Every holder name this app has ever stamped, newest first - what the reap gate
 * matches against, and the reason a rename doesn't strand a pool.
 *
 * A lease records the holder that took it, forever; it is not restamped when the app
 * is renamed. So a gate that only ever matched the CURRENT name would refuse to
 * return every lease taken before the rename, silently and permanently. That isn't a
 * hypothesis: the `ai-harness` -> `fleet-control` rename did exactly this, and the
 * scar is still in the pool - a worktree held by `ai-harness` that no sweep can
 * collect, which the old gate comment wrote off as "a one-time migration, deliberately
 * not encoded here". This is that migration, encoded. At the `fleet-control` ->
 * `mission-control` rename there were six live leases that would have been stranded
 * the same way.
 *
 * Safe because it is exactly the gate's real question. The gate asks "did WE take this
 * lease?", and these names all WERE us - the old comment conceded as much, calling
 * `ai-harness` "the one label that once WAS us". It never widens to a stranger's lease:
 * anything outside this list is still refused.
 *
 * Append here on any future rename; never remove.
 */
export const LEASE_HOLDERS = [LEASE_HOLDER, "fleet-control", "ai-harness"];

/** State dirs this app has used, newest first. See `stateDir` / `migrateStateDir`. */
const STATE_DIRS = [".mission-control", ".fleet-control", ".ai-harness"];

/**
 * Where the daemon keeps its state (db, token, logs). `~/.mission-control` for a fresh
 * install, but an existing dir from an older name (token + db already there) is used
 * where it lies, so merely READING this never orphans a running install. `migrateStateDir`
 * is what actually moves an old dir onto the new name, once, under the daemon's control.
 *
 * Resolution is newest-first and never creates anything: this is called by the hook and
 * the MCP bridge as well as the daemon, and a path resolver that had side effects would
 * have several processes racing to invent a state dir.
 */
export function stateDir() {
  const override = envVar("HOME");
  if (override) return override;
  for (const name of STATE_DIRS) {
    const p = join(homedir(), name);
    if (existsSync(p)) return p;
  }
  return join(homedir(), STATE_DIRS[0]);
}

/**
 * Move a state dir left behind by an older name onto the current one. Returns the
 * `{ from, to }` it moved, or null when there was nothing to do.
 *
 * Called once at daemon startup, BEFORE the db is opened - which is the only safe
 * moment for it. Doing it here rather than in `stateDir` is deliberate: `stateDir` is
 * a resolver that the hook and MCP bridge call constantly, and a rename racing an open
 * sqlite handle is how a database gets lost.
 *
 * Moves the newest old dir that exists - the same one `stateDir` would have resolved to,
 * i.e. the live install - and leaves any older ones untouched (this machine has both a
 * `.fleet-control` and a stale `.ai-harness`). Never runs when the new dir already
 * exists, so it can't merge two installs' state or overwrite a real dir.
 *
 * `renameSync` is atomic within a filesystem, so this either moves or it doesn't - and
 * the daemon carries on either way, because a state dir under its old name still works
 * (see `stateDir`). Tidiness, not a dependency.
 */
export function migrateStateDir() {
  if (envVar("HOME")) return null; // an explicit override owns its own path
  const to = join(homedir(), STATE_DIRS[0]);
  if (existsSync(to)) return null;
  for (const name of STATE_DIRS.slice(1)) {
    const from = join(homedir(), name);
    if (!existsSync(from)) continue;
    try {
      renameSync(from, to);
      return { from, to };
    } catch {
      return null; // in use, cross-device, permissions - the old dir still works
    }
  }
  return null;
}

/** Path to the shared auth token the daemon writes and clients present. */
export function tokenPath() {
  return join(stateDir(), "token");
}

/** Read the daemon auth token, or "" when it isn't present yet. */
export function readToken() {
  try {
    return readFileSync(tokenPath(), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The daemon auth token, minting one if the file does not exist yet.
 *
 * Lives here rather than only in the daemon because the installer needs it too, and
 * needs the SAME value: it bakes the token into `~/.claude/settings.json` as an OTLP
 * header, and `npm run setup` runs before the daemon has ever booted. `readToken()`
 * answers "" there, which would write an empty header, get every export answered 401,
 * and show up nowhere - the panel would read exactly like a fresh install waiting for
 * its first session. One minter, so the two can never disagree about the value.
 */
export function ensureToken() {
  const existing = readToken();
  if (existing) return existing;
  const path = tokenPath();
  mkdirSync(dirname(path), { recursive: true });
  const minted = randomBytes(24).toString("hex");
  writeFileSync(path, minted + "\n", { mode: 0o600 });
  return minted;
}

/** The scoped bearer the Mission MCP bridge adds only to scout submission requests. */
export const SCOUT_SUBMISSION_CREDENTIAL_HEADER = "x-mission-scout-credential";

/**
 * Where the daemon leaves the opaque credential for the one checkout an MCP process is in.
 *
 * The digest is a filename, never authentication. It keeps an absolute checkout path out of
 * the state-directory layout; the signed credential inside is what the daemon authenticates.
 */
export function scoutSubmissionCredentialPath(cwd) {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex");
  return join(stateDir(), "scout-submission-credentials", key);
}

/** Read this checkout's daemon-issued credential, or "" when none was provisioned. */
export function readScoutSubmissionCredential(cwd) {
  try {
    return readFileSync(scoutSubmissionCredentialPath(cwd), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Capture the terminal env the daemon uses to bind an event to a discovered
 * session (tmux/wezterm pane ids). Values are `undefined` when unset so they
 * drop out of JSON rather than serializing as empty strings.
 */
export function captureTerminalEnv() {
  return {
    tmuxPane: process.env.TMUX_PANE || undefined,
    weztermPane: process.env.WEZTERM_PANE || undefined,
    termProgram: process.env.TERM_PROGRAM || undefined,
  };
}
