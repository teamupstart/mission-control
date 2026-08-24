import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { HOST, PORT, envVar, stateDir, tokenPath } from "../shared/harness-runtime.mjs";

/** Runtime coordinates and the `MISSION_`/legacy env resolution live in the shared
 * runtime module so the daemon, the MCP bridge, and the hook can never disagree.
 * Re-exported them here so the rest of the server keeps importing them from config. */
export { HOST, PORT, envVar };


/**
 * Where the daemon keeps its state (db, token, logs).
 *
 * Resolved at module load, which is why the state-dir rename can't live here: this file
 * is imported by most of src/server and therefore by the test suite, so a rename in this
 * body would fire on `npm test` against the developer's real home. It lives in
 * `./migrate-state.ts`, which only the daemon's entry point imports - above this one.
 */
export const STATE_DIR = stateDir();
// The db filename stays "harness.db" so an upgraded install keeps its tasks/reviews.
export const DB_PATH = join(STATE_DIR, "harness.db");
export const TOKEN_PATH = tokenPath();
/** Isolated worktrees the daemon creates for dispatched tasks (git-worktree fallback). */
export const WORKTREES_DIR = join(STATE_DIR, "worktrees");
/** Durable, reusable worktrees allocated by the daemon-owned native provider. */
export const WORKTREE_POOLS_DIR = join(STATE_DIR, "worktree-pools");
/** Disposable isolated worktrees used when native allocation positively declines a check. */
export const CHECK_WORKTREES_DIR = join(STATE_DIR, "check-worktrees");
/** Owner-only logical settings snapshots, beneath the daemon's one configured state home. */
export const SETTINGS_BACKUPS_DIR = join(STATE_DIR, "backups", "settings");

/**
 * The portable archive library: `archives/<producer-id>/<archive-id>/` bundles.
 *
 * Under `STATE_DIR` rather than beside a repository or in a second home resolver, so an
 * isolated or demo daemon keeps its archives beside its own database instead of writing into
 * the operator's real library - the same rule the db already lives by. These two constants
 * are the only library roots in the daemon and `ArchiveLibrary` is the only thing allowed to
 * read them; a second resolver would silently split the catalog.
 *
 * Ordinary directories, so an operator can copy, sync, back up, or hand-inspect a bundle
 * with any filesystem tool. Mission Control provides no network transport for them.
 */
export const ARCHIVES_DIR = join(STATE_DIR, "archives");

/**
 * Where this daemon published archives before they declared a kind. READ, NEVER WRITTEN.
 *
 * Every bundle already on disk stays exactly where it is, under the name it was written
 * with, and goes on being discovered from here for ever. Moving them would rewrite paths
 * that a manifest, a note, or another machine's copy already refers to, for the sake of a
 * tidier directory listing.
 */
export const LEGACY_SCOUTS_DIR = join(STATE_DIR, "scouts");

/**
 * This machine's opaque producer identity, deliberately OUTSIDE every library root.
 *
 * If it lived in a library it would be copied along with the bundles by exactly the sync
 * tools the format exists to support, and two machines would then generate archives into
 * one producer namespace - which is the only way this design produces a key collision.
 * Losing the file costs nothing durable: existing bundles carry their producer in their own
 * path and manifest, and future archives simply open a new namespace.
 *
 * The FILENAME keeps its original spelling on purpose. This id appears inside every manifest
 * this machine has ever written, so a relocation that failed to find the old file would mint
 * a new identity and present this machine's own bundles as a stranger's. There is nothing to
 * gain here that is worth that risk.
 */
export const ARCHIVE_PRODUCER_PATH = join(STATE_DIR, "scout-producer.json");

/** The shipped reconciliation cadence: filesystem watchers drop events, so a scan is the authority. */
const DEFAULT_ARCHIVE_RECONCILE_MS = 60_000;

/**
 * How often the archive library is rescanned, or null when recurring reconciliation is OFF.
 *
 * `MISSION_SCOUT_RECONCILE_MS=0` disables the loop, on `pollIntervalMs`'s convention and for
 * its reason: handed to `setTimeout`, 0 is a ~1ms tick, which turns an off switch into a
 * directory walk in a hot loop. An unparseable value is a typo rather than an instruction and
 * falls back to the shipped cadence.
 *
 * The environment variable keeps its `SCOUT_` spelling because an operator may already have
 * it set; a renamed variable would silently stop being honoured on the machines that used it.
 *
 * Read per call rather than at import so the value is whatever the daemon was started with,
 * and so a focused test can drive the loop at its own speed without a module-load race.
 */
export function archiveReconcileMs(raw = envVar("SCOUT_RECONCILE_MS")): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_ARCHIVE_RECONCILE_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return DEFAULT_ARCHIVE_RECONCILE_MS;
  if (ms <= 0) return null;
  return ms;
}

/**
 * The skills catalog (`skills/<id>/SKILL.md`), baked into the repo and shipped with
 * the app - resolved absolutely, so it never depends on the daemon's working
 * directory (unpredictable when Electron spawns it).
 *
 * `../../skills` lands on the repo root under `tsx src/server/index.ts` AND on the app
 * root under `node dist/server/index.mjs`, exactly like index.ts's `MISSION_WEB_DIR`
 * fallback and for the same reason: both entry points sit two levels down.
 *
 * WHICH IS WHY THIS LIVES HERE and not beside its callers in skills/. esbuild bundles
 * the whole server into `dist/server/index.mjs`, so every bundled module's
 * `import.meta.url` becomes that ONE file's - and only a module that already sits two
 * levels down in the source tree resolves the same before and after bundling.
 * `skills/catalog.ts` is three levels down, so the identical expression there is
 * correct packaged and points at a nonexistent `src/skills` in dev.
 *
 * The symlinks this feeds read fine from a packaged build: the app ships `asar: false`
 * (see electron-builder.yml), so these are real directories on disk. That was the
 * plan's one open question, and it was already answered - the satellites need plain
 * files for the same reason. If asar is ever turned back on, the reconciler has to
 * copy and compare a content hash instead; nothing about the symlink path survives it.
 */
export function skillsDir(): string {
  return envVar("SKILLS_DIR") ?? fileURLToPath(new URL("../../skills", import.meta.url));
}

/**
 * The SEED for Foreman's instructions setting: `personas/FOREMAN.md` under the app root.
 *
 * `../../personas/FOREMAN.md` for exactly the reason `skillsDir` documents above, and it has
 * to live in THIS file for the same reason: esbuild collapses the whole server into one
 * bundle, so `import.meta.url` becomes that bundle's, and only a module already two levels
 * down in the source tree resolves the same before and after bundling. The `../../` is what
 * reaches the repo root in dev and the app root when packaged; the directory below it is
 * shipped by name in `electron-builder.yml`, so the two have to move together.
 *
 * A file rather than a string baked into the bundle, because the point of it being markdown
 * is that it can be read and edited without a rebuild - and because there must be exactly one
 * copy of this text, not one in a `.md` for humans and another in a `.ts` for the daemon.
 */
export function foremanInstructionsPath(): string {
  return envVar("FOREMAN_INSTRUCTIONS")
    ?? fileURLToPath(new URL("../../personas/FOREMAN.md", import.meta.url));
}

/**
 * The bundled MCP server (`dist/mcp/server.mjs`) - what a dispatched session is pointed at
 * with `--mcp-config` so `request_input` is guaranteed present in the very session where
 * `AskUserQuestion` has been taken away (see `ask-channel.ts`).
 *
 * `../../dist/mcp/server.mjs` for exactly the reason `skillsDir` documents above, and it has
 * to live in THIS file for the same reason: esbuild collapses the whole server into one
 * bundle, so `import.meta.url` becomes that bundle's, and only a module already two levels
 * down in the source tree resolves the same before and after bundling.
 *
 * Not asserted to exist here - the caller checks, because "the bundle is missing" is the one
 * condition that must disarm the whole ask channel rather than half of it.
 */
export function mcpServerPath(): string {
  return envVar("MCP_SERVER") ?? fileURLToPath(new URL("../../dist/mcp/server.mjs", import.meta.url));
}

/**
 * The bundled Codex hook bridge (`dist/satellites/codex-hook.mjs`) - the command a
 * dispatched Codex session's `-c hooks.*` overrides invoke.
 *
 * Lives HERE, beside `mcpServerPath()`, for the reason that function documents: esbuild
 * collapses the whole server into `dist/server/index.mjs`, so a specifier written from
 * `harness/codex/launch.ts` resolves four levels above the bundle instead of the repo
 * root, `existsSync` fails, and the launch silently degrades to an uninstrumented Codex
 * session - the designed fallback firing for a reason that is not the designed one.
 */
export function codexHookPath(): string {
  return envVar("CODEX_HOOK") ?? fileURLToPath(new URL("../../dist/satellites/codex-hook.mjs", import.meta.url));
}

// Which binary each harness launches moved to the harness registry as `BinSpec`
// (`harness/types.ts`), with `resolveAgentBin` in `harness/index.ts`. It was a
// `Record<AgentType, AgentBin>` here, which forced the decision but left the resolution
// in a file the harnesses know nothing about - and `claude-cli.ts` quietly kept a second
// chain of its own beside it.

/** How often the passive pollers sweep, absent an override. */
const DEFAULT_POLL_MS = 1500;

/**
 * The passive-polling interval, or null when passive polling is switched OFF.
 *
 * `MISSION_POLL_MS=0` is how anyone would try to disable a periodic job, and it has to
 * actually disable it - handed to `setTimeout`, 0 is a ~1ms tick, which turns the off
 * switch into a hot loop of `ps` over every process on the machine. Same for any negative
 * value. An unparseable value is a typo rather than an instruction, so it falls back to
 * the default instead of into that spin. Recurring maintenance settings use the same `=0`
 * convention so operators get one spelling of "off".
 *
 * The off switch is not only a test affordance, though a browser-level suite is what forced
 * it. Terminal discovery walks EVERY process on the machine and cards anything that looks
 * like an agent, which is correct on an operator's laptop and wrong everywhere else: a
 * daemon in a container or on CI has no terminal sessions to find, and one booted beside a
 * developer's real sessions adopts them - including the Kill and Reset controls that act on
 * them. `e2e/` sets this to 0 for exactly that reason.
 *
 * Read per call, not at import, so the value is whatever the daemon was started with rather
 * than whatever won the module-load race. `raw` is injected the way `resolveSettleMs` takes
 * it - the string, not an env object - so a test states the input it means without having to
 * restate `envVar`'s prefix chain, which has its own coverage.
 */
export function pollIntervalMs(raw = envVar("POLL_MS")): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_POLL_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return DEFAULT_POLL_MS;
  if (ms <= 0) return null;
  return ms;
}

/**
 * How often the PR poller asks `gh` whether each feature-branch session has an
 * open PR. PR creation and merge are rare relative to the process sweep, so this
 * runs far slower to keep `gh` calls negligible.
 */
export const PR_POLL_MS = Number(envVar("PR_POLL_MS") ?? 20_000);

/**
 * The `gh` binary. THE seam every gh subprocess in this codebase goes through - the PR
 * poller, the Inspector, and the GitHub task source all resolve it here.
 *
 * One seam rather than three, because the value of an override is proportional to how
 * little of the system escapes it: a fake that catches the task source but not the PR
 * poller means a test process still shells out to the operator's real, authenticated
 * `gh`, against whatever repo the cwd resolves to. `MISSION_GH_BIN` is what the
 * browser-level suite points at a recording fake, and what an operator can point at a
 * wrapper script.
 *
 * Read per call, not at import, so the value is whatever the daemon was started with
 * rather than whatever won the module-load race - the same reason `pollIntervalMs` is a
 * function. An empty string counts as unset: `MISSION_GH_BIN=` is somebody clearing the
 * override, not asking us to spawn "".
 */
export function ghBin(): string {
  return envVar("GH_BIN") || "gh";
}

export const DEFAULT_PRODUCT_ISSUES_REPO = "mancej/mission-controller-control-issues";

export type ProductIssuesRepoConfig =
  | { ok: true; repo: string }
  | { ok: false; repo: null; error: string };

/**
 * The one public repository product reports may target.
 *
 * The environment override exists for downstream forks and isolated tests, never per
 * request. Exact `owner/name` parsing is what keeps this feature from becoming an arbitrary
 * issue writer through a crafted body.
 */
export function productIssuesRepo(
  raw: string | undefined = envVar("PRODUCT_ISSUES_REPO"),
): ProductIssuesRepoConfig {
  const repo = raw === undefined || raw === "" ? DEFAULT_PRODUCT_ISSUES_REPO : raw;
  const [owner, name, extra] = repo.split("/");
  const ownerOk =
    !!owner &&
    owner.length <= 39 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner);
  const nameOk =
    !!name &&
    name.length <= 100 &&
    name !== "." &&
    name !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(name);
  if (extra !== undefined || !ownerOk || !nameOk) {
    return {
      ok: false,
      repo: null,
      error: "MISSION_PRODUCT_ISSUES_REPO must be an exact GitHub owner/name repository",
    };
  }
  return { ok: true, repo };
}
