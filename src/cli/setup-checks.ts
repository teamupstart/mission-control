import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isAllowedModCall, pathLiterals } from "../../scripts/mod-calls.mjs";
import { DAEMON_PROTOCOL_CAPABILITIES, daemonHealthCompatibility } from "../shared/daemon-protocol.ts";
import { FeatureFlagsConfigSchema, resolveFeatureFlag } from "../shared/feature-flags.ts";
import { stagedModVersion } from "../server/mod-stage.ts";
import type { ClaudeCli } from "./claude-cli.ts";
import { installedMod, modMarketplace, MOD_ID, readAllowedModCalls, type SetupContext } from "./setup-context.ts";

export interface DoctorCheck { id: string; ok: boolean; message: string }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function checkDaemon(context: SetupContext): Promise<DoctorCheck> {
  try {
    const health = await context.request("/api/health");
    if (daemonHealthCompatibility(health, DAEMON_PROTOCOL_CAPABILITIES.homeDispatch) === "unreachable") throw new Error("Not a Mission Control daemon");
    return { id: "daemon", ok: true, message: "Mission Control reachable" };
  } catch (error) {
    return { id: "daemon", ok: false, message: `${message(error)}. Open the Mission Control app or start the built daemon; service installation is not available in this build.` };
  }
}

export async function checkFlag(context: SetupContext, change: boolean): Promise<DoctorCheck> {
  try {
    const parse = (value: unknown) => z.object({ config: FeatureFlagsConfigSchema }).parse(value).config;
    let config = parse(await context.request("/api/feature-flags"));
    const wanted = !context.off;
    if (change && resolveFeatureFlag("headless-mode", config) !== wanted) {
      config = parse(await context.request("/api/feature-flags", { kind: "flag", id: "headless-mode", enabled: wanted }));
    }
    const ok = resolveFeatureFlag("headless-mode", config) === wanted;
    return { id: "flag", ok, message: ok ? `headless-mode ${wanted ? "on" : "off"}` : "headless-mode off. Run mctl setup." };
  } catch (error) { return { id: "flag", ok: false, message: message(error) }; }
}

/** A token-free, read-only report. Failure of one probe cannot suppress the rest. */
export async function doctorChecks(context: SetupContext): Promise<DoctorCheck[]> {
  const checks = [await checkDaemon(context), await checkFlag(context, false)];
  try {
    const health = await context.request("/api/health");
    const ok = daemonHealthCompatibility(health, DAEMON_PROTOCOL_CAPABILITIES.homeDispatch) === "compatible";
    checks.push({ id: "home-dispatch-v1", ok, message: ok ? "home-dispatch-v1 available" : "Enable headless-mode with mctl setup, or update the daemon." });
  } catch (error) { checks.push({ id: "home-dispatch-v1", ok: false, message: message(error) }); }
  let cli: ClaudeCli | null = null;
  let detectionError = "";
  try { cli = await context.detectClaude(); }
  catch (error) { detectionError = `${message(error)}. `; }
  checks.push({ id: "claude", ok: Boolean(cli), message: cli ? `${cli.path} (${cli.version})` : `${detectionError}Claude Code with plugin marketplace support was not found. Install Claude Code, then run mctl setup.` });
  if (!cli) {
    for (const id of ["mod-enabled", "mod-current", "mod-calls"]) checks.push({ id, ok: false, message: "Cannot check without Claude Code. Install it, then run mctl setup." });
    return checks;
  }
  const root = join(context.stateHome, "mod");
  try {
    const plugin = await installedMod(cli);
    const loadErrors = plugin?.errors ?? [];
    checks.push({ id: "mod-enabled", ok: plugin?.enabled === true && loadErrors.length === 0, message: plugin?.enabled && loadErrors.length
      ? `${MOD_ID} failed to load: ${loadErrors.join("; ")}. Run mctl setup.`
      : plugin?.enabled ? `${MOD_ID} enabled at user scope` : `${MOD_ID} missing or disabled at user scope. Run mctl setup.` });
    const version = await stagedModVersion(root);
    const marketplace = await modMarketplace(cli);
    const sourceMatches = marketplace?.source === "directory" && marketplace.path === root;
    const ok = plugin?.version === version && sourceMatches;
    checks.push({ id: "mod-current", ok, message: ok ? `Installed and staged version ${version}; source ${root}` : `Installed ${plugin?.version ?? "none"}; staged ${version}; ${sourceMatches ? "source matches" : "marketplace source missing or different"}. Run mctl setup.` });
  } catch (error) {
    if (!checks.some((check) => check.id === "mod-enabled")) checks.push({ id: "mod-enabled", ok: false, message: `${message(error)}. Run mctl setup.` });
    checks.push({ id: "mod-current", ok: false, message: `${message(error)}. Build the mod and run mctl setup.` });
  }
  try {
    const allowed = await readAllowedModCalls(root);
    const source = await readFile(join(root, "mission-control/hooks/register.js"), "utf8");
    const refused = pathLiterals(source, "register.js").filter((path) => (path.startsWith("/api") || path.startsWith("/dispatch")) && !isAllowedModCall(path, allowed));
    if (refused.length) throw new Error(`Disallowed daemon calls: ${[...new Set(refused)].join(", ")}`);
    await cli.run(["plugin", "validate", join(root, "mission-control")]);
    checks.push({ id: "mod-calls", ok: true, message: "Staged plugin validates and its daemon paths match allowed-calls.json" });
  } catch (error) { checks.push({ id: "mod-calls", ok: false, message: `${message(error)}. Rebuild the mod and run mctl setup.` }); }
  return checks;
}

export function formatChecks(checks: readonly DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? "ok" : "FAIL"} ${check.id}: ${check.message}\n`).join("");
}
