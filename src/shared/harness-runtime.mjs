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
import { homedir, tmpdir } from "node:os";
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
 * State dirs this app has used, newest first - the directory NAMES, relative to `homedir()`.
 * See `stateDir` / `migrateStateDir`.
 *
 * Exported because `db.ts`'s test-runner refusal has to recognise the operator's real state
 * dir under every name it has ever had, and a second hand-written copy of this list is a
 * guard that silently stops covering the name added next. Append here on a rename; never
 * remove, because persisted state can still live under an older name.
 */
export const STATE_DIRS = [".mission-control", ".fleet-control", ".ai-harness"];

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

/** Direct loopback credential for a child that must not learn the daemon's state path. */
export const MISSION_API_TOKEN_ENV = "MISSION_API_TOKEN";

/** Restrictive token file supplied to an isolated child without putting the bearer in argv. */
export const MISSION_API_TOKEN_FILE_ENV = "MISSION_API_TOKEN_FILE";

/** Read the daemon auth token, or "" when it isn't present yet. */
export function readToken() {
  try {
    return readFileSync(tokenPath(), "utf8").trim();
  } catch {
    return "";
  }
}

/** Read a client credential supplied directly to an isolated child, then the normal file. */
export function readClientToken() {
  const supplied = process.env[MISSION_API_TOKEN_ENV]?.trim();
  if (supplied) return supplied;
  const suppliedFile = process.env[MISSION_API_TOKEN_FILE_ENV]?.trim();
  if (suppliedFile) {
    try {
      return readFileSync(suppliedFile, "utf8").trim();
    } catch {
      return "";
    }
  }
  return readToken();
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

/** Direct scout capability for an isolated MCP child. */
export const SCOUT_SUBMISSION_CREDENTIAL_ENV = "MISSION_SCOUT_SUBMISSION_CREDENTIAL";

/** Rotatable scout capability file for an isolated MCP child. */
export const SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV = "MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE";

/** Daemon-issued identity that binds a launch-scoped MCP process to its SDK session. */
export const MISSION_SESSION_ID_ENV = "MISSION_SESSION_ID";

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

/**
 * State-independent capability path handed to isolated MCP children.
 *
 * A running MCP child can outlive several task assignments. The daemon replaces this file
 * at each assignment so the child reads the current credential without learning the
 * operator's state directory or inheriting any of its home overrides.
 */
export function isolatedScoutSubmissionCredentialPath(cwd) {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex");
  return join(tmpdir(), "mission-control-agent-capabilities", key);
}

/** Read this checkout's daemon-issued credential, or "" when none was provisioned. */
export function readScoutSubmissionCredential(cwd) {
  const supplied = process.env[SCOUT_SUBMISSION_CREDENTIAL_ENV]?.trim();
  if (supplied) return supplied;
  const suppliedFile = process.env[SCOUT_SUBMISSION_CREDENTIAL_FILE_ENV]?.trim();
  if (suppliedFile) {
    try {
      return readFileSync(suppliedFile, "utf8").trim();
    } catch {
      return "";
    }
  }
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
