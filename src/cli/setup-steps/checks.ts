import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DAEMON_PROTOCOL_CAPABILITIES, daemonHealthCompatibility } from "@shared/daemon-protocol.ts";
import { daemonBaseUrl } from "../../mod/daemon-link.ts";
import { MOD_NAME } from "../../mod/constants.ts";
import allowedCalls from "../../mod/allowed-calls.json" with { type: "json" };
import { findClaude, type ClaudeCli } from "../claude-cli.ts";
import { readModVersion } from "../../server/mod-stage.ts";
import type { SetupDeps } from "./context.ts";
import type { DoctorCheck } from "./types.ts";

/**
 * The checks `mctl doctor` runs and `mctl setup` ends with (spec 7.14, plan 6.5). Every one
 * only reads: it runs `claude` for its listings, asks the daemon for `/api/health`, and reads
 * the staged mod. None changes a setting or spends a model token.
 */

/**
 * Whether `path` (query stripped) is on the allowlist. Written out here rather than imported from
 * `scripts/mod-calls.mjs`, which parses source with the TypeScript compiler and would put it in the
 * `mctl` bundle.
 */
function isAllowedModCall(path: string, allowed: { exact: string[]; prefixes: string[] }): boolean {
  const bare = path.split("?")[0]!;
  return allowed.exact.includes(bare) || allowed.prefixes.some((prefix) => bare.startsWith(prefix));
}

/** `name@marketplace`, as `claude plugin install` takes it. */
export const MOD_PLUGIN_ID = `${MOD_NAME}@${MOD_NAME}`;

/** `path` as one shell argument: left bare when it is plainly safe, else single-quoted. */
export function shellArg(path: string): string {
  return /^[A-Za-z0-9_/.:@%+=,-]+$/.test(path) ? path : "'" + path.replace(/'/g, "'\\''") + "'";
}

/** The two commands that install the mod by hand, printed whenever setup could not. */
export function recoveryCommands(stateDir: string, claude: string = "claude"): [string, string] {
  return [`${claude} plugin marketplace add ${shellArg(join(stateDir, "mod"))}`, `${claude} plugin install ${MOD_PLUGIN_ID} --scope user`];
}

/** How to spell the discovered claude in a command a person pastes: bare when it came from `PATH`, else its quoted path. */
export function claudeCommand(claude: ClaudeCli): string {
  return claude.source === "PATH" ? "claude" : shellArg(claude.path);
}

export interface InstalledMod {
  version: string;
  scope: string;
  enabled: boolean;
}

/** The mod as `claude plugin list --json` shows it, `null` when absent, or an error string. */
export async function readInstalledMod(claude: ClaudeCli, deps: SetupDeps): Promise<{ mod: InstalledMod | null } | { error: string }> {
  const listing = await deps.exec(claude.path, ["plugin", "list", "--json"], { timeoutMs: 30_000 });
  if (listing.code !== 0) return { error: `\`claude plugin list\` failed: ${listing.stderr.trim() || `exit ${listing.code}`}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(listing.stdout);
  } catch {
    return { error: "`claude plugin list --json` printed something that is not JSON" };
  }
  // A valid JSON value that is not a list (say, an object wrapping one) is a format this check does
  // not understand, not proof that nothing is installed.
  if (!Array.isArray(parsed)) return { error: "`claude plugin list --json` printed JSON that is not a list of plugins" };
  const rows = parsed;
  // The same plugin may be listed at several scopes. Readiness is the user-scope entry, so it is
  // preferred wherever it sits in the list; another scope's entry is only reported when there is none.
  let first: InstalledMod | null = null;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as { id?: unknown; name?: unknown; version?: unknown; scope?: unknown; enabled?: unknown };
    if ((entry.id ?? entry.name) !== MOD_PLUGIN_ID) continue;
    // Readiness is never inferred from a missing field: an entry without its scope or enabled state
    // says nothing about either, so it is reported rather than treated as installed.
    if (typeof entry.version !== "string" || typeof entry.scope !== "string" || typeof entry.enabled !== "boolean") {
      return { error: "`claude plugin list --json` lists " + MOD_PLUGIN_ID + " without its version, scope or enabled state" };
    }
    const mod = { version: entry.version, scope: entry.scope, enabled: entry.enabled };
    if (mod.scope === "user") return { mod };
    first ??= mod;
  }
  return { mod: first };
}

export async function checkClaude(deps: SetupDeps): Promise<{ check: DoctorCheck; claude: ClaudeCli | null }> {
  const found = await findClaude({ env: deps.env, exec: deps.exec, home: deps.home });
  if (found.claude) {
    return { claude: found.claude, check: { name: "claude", status: "ok", message: `claude ${found.claude.version} at ${found.claude.path} (${found.claude.source})` } };
  }
  return {
    claude: null,
    check: {
      name: "claude",
      status: "fail",
      message: found.rejected.length > 0 ? `no usable claude: ${found.rejected.join("; ")}` : "the claude CLI was not found",
      fix: "Install Claude Code, or set MISSION_CLAUDE_BIN to its path, then run `mctl setup` again.",
    },
  };
}

/** What asking the daemon for `/api/health` produced: its body, or what went wrong. */
export interface HealthReading {
  body: unknown;
  /** Why there is no usable body; `null` when there is one. */
  problem: { kind: "unreachable" | "timeout" | "http" | "not-json"; detail: string } | null;
}

const HEALTH_TIMEOUT_MS = 3000;

export async function fetchHealth(deps: SetupDeps): Promise<HealthReading> {
  // One `mctl setup` run reads the daemon from three steps; with a cache they share one answer.
  if (!deps.healthCache) return readHealth(deps);
  return (deps.healthCache.reading ??= readHealth(deps));
}

async function readHealth(deps: SetupDeps): Promise<HealthReading> {
  let reply: Awaited<ReturnType<SetupDeps["fetch"]>>;
  try {
    reply = await deps.fetch(`${daemonBaseUrl(deps.env)}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { body: null, problem: { kind: "timeout", detail: `no answer within ${HEALTH_TIMEOUT_MS / 1000} s` } };
    const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code ?? error.message : String(error);
    return { body: null, problem: { kind: "unreachable", detail: String(cause) } };
  }
  if (!reply.ok) return { body: null, problem: { kind: "http", detail: `HTTP ${reply.status}` } };
  try {
    return { body: await reply.json(), problem: null };
  } catch {
    return { body: null, problem: { kind: "not-json", detail: "the reply was not JSON" } };
  }
}

export function checkDaemon(reading: HealthReading, deps: SetupDeps): DoctorCheck {
  const url = `${daemonBaseUrl(deps.env)}/api/health`;
  const body = reading.body;
  if (typeof body === "object" && body !== null && (body as { service?: unknown }).service === "mission-control") {
    return { name: "daemon", status: "ok", message: `Mission Control answers at ${url}` };
  }
  const problem = reading.problem;
  if (problem === null) {
    return { name: "daemon", status: "fail", message: `${url} answered, but not as Mission Control`, fix: "Another program may be using this port; check MISSION_PORT, then run `mctl doctor` again." };
  }
  if (problem.kind === "unreachable") {
    return { name: "daemon", status: "fail", message: `no Mission Control daemon answered at ${url} (${problem.detail})`, fix: "Start Mission Control (the app, or `npm run dev`), then run `mctl doctor` again." };
  }
  // The daemon is there but unwell: starting it again would not help.
  return { name: "daemon", status: "fail", message: `${url} did not give a usable answer (${problem.detail})`, fix: "Mission Control may be busy or stuck; wait, or restart it, then run `mctl doctor` again." };
}

export function checkFlag(health: unknown): DoctorCheck {
  const verdict = daemonHealthCompatibility(health, DAEMON_PROTOCOL_CAPABILITIES.homeDispatch);
  if (verdict === "compatible") return { name: "flag", status: "ok", message: "the headless-mode preview flag is on" };
  if (verdict === "unreachable") return { name: "flag", status: "fail", message: "the flag cannot be read because the daemon is not answering", fix: "Start Mission Control first." };
  return { name: "flag", status: "fail", message: "the headless-mode preview flag is off", fix: "Turn on `headless-mode` under Settings, Preview features, in Mission Control." };
}

/** `mod-enabled` and `mod-current`, from one listing and the staged `plugin.json`. */
export async function checkInstalled(claude: ClaudeCli, deps: SetupDeps): Promise<DoctorCheck[]> {
  const listed = await readInstalledMod(claude, deps);
  // Replacing an installed build is uninstall then install (a plain install does not replace it), so
  // the by-hand fix for a stale mod starts with the uninstall that `mctl setup` itself runs.
  const bin = claudeCommand(claude);
  const reinstall = [`${bin} plugin uninstall ${MOD_PLUGIN_ID} --scope user`, ...recoveryCommands(deps.stateDir, bin)].join(" && ");
  // Every outcome reports both mod checks, so a person always sees the same six lines and the
  // "X of N" summary counts the whole set; a check that cannot run says so and fails.
  const cannotCheck = (why: string): DoctorCheck => ({ name: "mod-current", status: "fail", message: "cannot be checked: " + why, fix: "Fix the mod-enabled check first." });
  if ("error" in listed) return [{ name: "mod-enabled", status: "fail", message: listed.error, fix: "Run `mctl setup`." }, cannotCheck("the installed mods could not be listed")];
  const mod = listed.mod;
  if (!mod) return [{ name: "mod-enabled", status: "fail", message: `${MOD_PLUGIN_ID} is not installed`, fix: "Run `mctl setup`." }, cannotCheck("the mod is not installed")];
  const checks: DoctorCheck[] = [];
  if (mod.enabled && mod.scope === "user") {
    checks.push({ name: "mod-enabled", status: "ok", message: `${MOD_PLUGIN_ID} is installed and enabled at user scope` });
  } else {
    checks.push({ name: "mod-enabled", status: "fail", message: `${MOD_PLUGIN_ID} is ${mod.enabled ? "enabled" : "disabled"} at ${mod.scope} scope, not enabled at user scope`, fix: "Run `mctl setup` (disabling the mod in /plugin lasts only until then)." });
  }
  let staged: string;
  try {
    staged = await readModVersion(join(deps.stateDir, "mod"));
  } catch {
    return [...checks, { name: "mod-current", status: "fail", message: `no staged mod at ${join(deps.stateDir, "mod")}`, fix: "Run `mctl setup`." }];
  }
  checks.push(
    mod.version === staged
      ? { name: "mod-current", status: "ok", message: `the installed mod is ${mod.version}, the staged build` }
      : { name: "mod-current", status: "fail", message: `the installed mod is ${mod.version} but the staged build is ${staged}`, fix: `Run \`mctl setup\`, or by hand: ${reinstall}` },
  );
  return checks;
}

/** The daemon paths a bundle names: string literals that start a `/api/` or `/dispatch/` route. */
export function calledPaths(bundle: string): string[] {
  const found = new Set<string>();
  for (const match of bundle.matchAll(/["'`](\/(?:api|dispatch)\/[^"'`\s${}]*)/g)) found.add(match[1]!);
  return [...found].sort();
}

/**
 * `mod-calls`: the staged bundle reaches only the daemon paths in `src/mod/allowed-calls.json`,
 * and `claude plugin validate` accepts the plugin.
 */
export async function checkModCalls(claude: ClaudeCli | null, deps: SetupDeps): Promise<DoctorCheck> {
  return checkModCallsAt(claude, deps, join(deps.stateDir, "mod", MOD_NAME));
}

/** The `mod-calls` check for the plugin folder at `pluginDir`: the staged mod, or a copy about to be published. */
export async function checkModCallsAt(claude: ClaudeCli | null, deps: SetupDeps, pluginDir: string): Promise<DoctorCheck> {
  let bundle: string;
  try {
    bundle = await readFile(join(pluginDir, "hooks", "register.js"), "utf8");
  } catch {
    return { name: "mod-calls", status: "fail", message: `no mod bundle at ${pluginDir}`, fix: "Run `mctl setup`." };
  }
  // The literal scan below cannot see a route built at run time, so the build's source-aware check
  // is the proof: the bundle must be exactly the one it passed. Without that record the calls
  // cannot be established, and the check fails rather than pass.
  let record: { checked?: unknown; bundleSha256?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(join(pluginDir, "hooks", "mod-calls.json"), "utf8"));
    // `null`, an array or a scalar parses fine but is no record.
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) record = parsed as typeof record;
  } catch {
    // handled below: no readable record
  }
  const actual = createHash("sha256").update(bundle).digest("hex");
  if (record.checked !== true || record.bundleSha256 !== actual) {
    const why = record.checked === true ? "the staged bundle is not the one the build checked" : "the staged mod has no build-time mod-calls record";
    return { name: "mod-calls", status: "fail", message: why + ", so its daemon calls cannot be established", fix: "Rebuild with `npm run build`, then run `mctl setup`." };
  }
  const paths = calledPaths(bundle);
  const refused = paths.filter((path) => !isAllowedModCall(path, allowedCalls));
  if (refused.length > 0) {
    return { name: "mod-calls", status: "fail", message: `the staged mod calls daemon paths that are not allowed: ${refused.join(", ")}`, fix: "Rebuild with `npm run build`, then run `mctl setup`." };
  }
  if (!claude) {
    return { name: "mod-calls", status: "fail", message: "`claude plugin validate` could not be run because no usable claude was found, so the staged mod was not validated", fix: "Fix the claude check first, then run `mctl doctor` again." };
  }
  {
    const validated = await deps.exec(claude.path, ["plugin", "validate", pluginDir], { timeoutMs: 30_000 });
    if (validated.code !== 0) {
      return { name: "mod-calls", status: "fail", message: `\`claude plugin validate\` refused the staged mod: ${(validated.stderr || validated.stdout).trim()}`, fix: "Rebuild with `npm run build`, then run `mctl setup`." };
    }
  }
  return { name: "mod-calls", status: "ok", message: paths.length > 0 ? `the staged mod calls only these daemon paths, all allowed: ${paths.join(", ")}` : "the staged mod names no daemon paths" };
}

/** Every kept check, in the order `mctl doctor` prints them. */
export async function runChecks(deps: SetupDeps): Promise<DoctorCheck[]> {
  const { check, claude } = await checkClaude(deps);
  const health = await fetchHealth(deps);
  const checks: DoctorCheck[] = [check, checkDaemon(health, deps), checkFlag(health.body)];
  if (claude) checks.push(...(await checkInstalled(claude, deps)));
  else {
    checks.push({ name: "mod-enabled", status: "fail", message: "cannot be checked without claude", fix: "Fix the claude check first." });
    checks.push({ name: "mod-current", status: "fail", message: "cannot be checked without claude", fix: "Fix the claude check first." });
  }
  checks.push(await checkModCalls(claude, deps));
  return checks;
}
