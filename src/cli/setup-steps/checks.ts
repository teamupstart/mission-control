import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isAllowedModCall } from "../../../scripts/mod-calls.mjs";
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

/** `name@marketplace`, as `claude plugin install` takes it. */
export const MOD_PLUGIN_ID = `${MOD_NAME}@${MOD_NAME}`;

/** The two commands that install the mod by hand, printed whenever setup could not. */
export function recoveryCommands(stateDir: string): [string, string] {
  return [`claude plugin marketplace add ${join(stateDir, "mod")}`, `claude plugin install ${MOD_PLUGIN_ID} --scope user`];
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
  const rows = Array.isArray(parsed) ? parsed : [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const entry = row as { id?: unknown; name?: unknown; version?: unknown; scope?: unknown; enabled?: unknown };
    if ((entry.id ?? entry.name) !== MOD_PLUGIN_ID) continue;
    return { mod: { version: String(entry.version ?? ""), scope: String(entry.scope ?? "user"), enabled: entry.enabled !== false } };
  }
  return { mod: null };
}

export async function checkClaude(deps: SetupDeps): Promise<{ check: DoctorCheck; claude: ClaudeCli | null }> {
  const found = await findClaude({ env: deps.env, exec: deps.exec });
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

export async function fetchHealth(deps: SetupDeps): Promise<unknown> {
  try {
    const reply = await deps.fetch(`${daemonBaseUrl(deps.env)}/api/health`, { signal: AbortSignal.timeout(3000) });
    return reply.ok ? await reply.json() : null;
  } catch {
    return null;
  }
}

export function checkDaemon(health: unknown, deps: SetupDeps): DoctorCheck {
  const url = daemonBaseUrl(deps.env);
  if (typeof health === "object" && health !== null && (health as { service?: unknown }).service === "mission-control") {
    return { name: "daemon", status: "ok", message: `Mission Control answers at ${url}/api/health` };
  }
  return { name: "daemon", status: "fail", message: `no Mission Control daemon answered at ${url}/api/health`, fix: "Start Mission Control (the app, or `npm run dev`), then run `mctl doctor` again." };
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
  const reinstall = recoveryCommands(deps.stateDir).join(" && ");
  if ("error" in listed) return [{ name: "mod-enabled", status: "fail", message: listed.error, fix: "Run `mctl setup`." }];
  const mod = listed.mod;
  if (!mod) return [{ name: "mod-enabled", status: "fail", message: `${MOD_PLUGIN_ID} is not installed`, fix: "Run `mctl setup`." }];
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
  const pluginDir = join(deps.stateDir, "mod", MOD_NAME);
  let bundle: string;
  try {
    bundle = await readFile(join(pluginDir, "hooks", "register.js"), "utf8");
  } catch {
    return { name: "mod-calls", status: "fail", message: `no staged mod bundle at ${pluginDir}`, fix: "Run `mctl setup`." };
  }
  const refused = calledPaths(bundle).filter((path) => !isAllowedModCall(path, allowedCalls));
  if (refused.length > 0) {
    return { name: "mod-calls", status: "fail", message: `the staged mod calls daemon paths that are not allowed: ${refused.join(", ")}`, fix: "Rebuild with `npm run build`, then run `mctl setup`." };
  }
  if (claude) {
    const validated = await deps.exec(claude.path, ["plugin", "validate", pluginDir], { timeoutMs: 30_000 });
    if (validated.code !== 0) {
      return { name: "mod-calls", status: "fail", message: `\`claude plugin validate\` refused the staged mod: ${(validated.stderr || validated.stdout).trim()}`, fix: "Rebuild with `npm run build`, then run `mctl setup`." };
    }
  }
  return { name: "mod-calls", status: "ok", message: "the staged mod calls only /api/health and /dispatch/*" };
}

/** Every kept check, in the order `mctl doctor` prints them. */
export async function runChecks(deps: SetupDeps): Promise<DoctorCheck[]> {
  const { check, claude } = await checkClaude(deps);
  const health = await fetchHealth(deps);
  const checks: DoctorCheck[] = [check, checkDaemon(health, deps), checkFlag(health)];
  if (claude) checks.push(...(await checkInstalled(claude, deps)));
  else checks.push({ name: "mod-enabled", status: "fail", message: "cannot be checked without claude", fix: "Fix the claude check first." });
  checks.push(await checkModCalls(claude, deps));
  return checks;
}
