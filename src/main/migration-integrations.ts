// Migration policy only retargets inventoried Mission-owned paths. Configuration
// formats and publication are owned by the normalized configuration adapter.
import { join } from "node:path";
import { AGENT_TYPES } from "@shared/types.ts";
import { capabilitiesFor, type McpSpec } from "@shared/harness-capabilities.ts";
import { isMissionHookCommand } from "../server/harness/claude/hooks.ts";
import { createMigrationConfigPort, type MigrationConfigPort, type HookEntry, type HookSnapshot, type McpSnapshot, type Registration } from "./migration-integration-config.ts";
import type { MigrationPlan, MigrationRepair, MigrationJournal } from "../../scripts/install-migration.mjs";

interface BundlePath { path: (string | number)[]; suffix: string }
const MCP_BUNDLE_SUFFIXES = ["/Contents/MacOS/Mission Control", "/Contents/Resources/app/dist/mcp/server.mjs"];
interface McpInventory { id: string; revision: string; paths: BundlePath[] }
export interface MigrationIntegrationInventory {
  schema: 3; hooks: HookEntry[]; mcp: McpInventory[]; login: boolean;
}
export interface MigrationIntegrationPorts {
  home: string;
  environment?: NodeJS.ProcessEnv;
  config?: MigrationConfigPort;
  command(spec: McpSpec, args: string[]): string;
  login(): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean };
  retargetLogin(plan: MigrationPlan, openAtLogin: boolean): Promise<void>;
  skills(): Promise<string[]>;
  log(message: string): void;
}

function retargetPath(value: string, plan: MigrationPlan): string {
  return value.startsWith(`${plan.source}/`) ? `${plan.target}${value.slice(plan.source.length)}` : value;
}

function movedRegistration(before: Registration, plan: MigrationPlan): Registration {
  const move = (value: string): string => MCP_BUNDLE_SUFFIXES.some((suffix) => value === `${plan.source}${suffix}`) ? retargetPath(value, plan) : value;
  return {
    command: move(before.command), args: before.args.map(move),
    ...(before.env ? {env: Object.fromEntries(Object.entries(before.env).map(([key, value]) => [key, move(value)]))} : {}),
  };
}

function movedHook(command: string, plan: MigrationPlan): string {
  // The installed hook uses quoted absolute paths. Refuse unsupported shell syntax
  // instead of doing a substring replacement inside an unrelated custom command.
  const oldScript = join(plan.source, "Contents/Resources/app/dist/satellites/hook.mjs");
  if (!isMissionHookCommand(command) || !command.includes(`"${oldScript}"`)) return command;
  const oldExe = join(plan.source, "Contents/MacOS/Mission Control");
  return command.replaceAll(`"${oldScript}"`, `"${retargetPath(oldScript, plan)}"`)
    .replaceAll(`"${oldExe}"`, `"${retargetPath(oldExe, plan)}"`);
}

/** Persist only bundle path locations. Other argv/env values never enter comparison data. */
function bundlePaths(registration: Registration, bundle: string): BundlePath[] {
  const paths: BundlePath[] = [];
  const add = (path: BundlePath["path"], value: string): void => {
    if (MCP_BUNDLE_SUFFIXES.some((suffix) => value === `${bundle}${suffix}`)) paths.push({path, suffix: value.slice(bundle.length)});
  };
  add(["command"], registration.command);
  registration.args.forEach((value, index) => add(["args", index], value));
  for (const key of Object.keys(registration.env ?? {}).sort()) add(["env", key], registration.env![key]!);
  return paths;
}

export function inspectMigrationIntegrations(plan: MigrationPlan, ports: MigrationIntegrationPorts): MigrationIntegrationInventory {
  const config = ports.config ?? createMigrationConfigPort(ports);
  const hooks = config.readHooks().entries.filter((hook) => movedHook(hook.command, plan) !== hook.command);
  const mcp: McpInventory[] = [];
  for (const agent of AGENT_TYPES) {
    const spec = capabilitiesFor(agent).mcp;
    if (!spec) continue;
    const found = config.readMcp(spec);
    if (found.registration?.args.includes(join(plan.source, "Contents/Resources/app/dist/mcp/server.mjs"))) {
      mcp.push({id: `mcp:${agent}`, revision: found.revision, paths: bundlePaths(found.registration, plan.source)});
    }
  }
  return {schema: 3, hooks, mcp, login: ports.login().openAtLogin};
}

function hookEdits(inventory: HookEntry[], current: HookSnapshot, plan: MigrationPlan): {path: (string | number)[]; value: string}[] {
  return inventory.map((item) => {
    const desired = movedHook(item.command, plan);
    const found = current.entries.find((entry) => JSON.stringify(entry.path) === JSON.stringify(item.path))?.command;
    if (found !== item.command && found !== desired) throw new Error("A hook changed after inventory. Your edit was preserved; retarget that hook manually.");
    return {path: item.path, value: desired};
  });
}

function repairHooks(inventory: MigrationIntegrationInventory, plan: MigrationPlan, config: MigrationConfigPort): void {
  if (inventory.hooks.length === 0) return;
  const current = config.readHooks(plan.nonce);
  const edits = hookEdits(inventory.hooks, current, plan);
  const after = config.writeHooks(plan.nonce, current, edits);
  if (edits.some((edit) => !after.entries.some((entry) => JSON.stringify(entry.path) === JSON.stringify(edit.path) && entry.command === edit.value))) throw new Error("Hook replacement could not be verified. Retry repair.");
}

function mcpRepair(item: McpInventory, found: McpSnapshot, plan: MigrationPlan): Registration | null {
  const registration = found.registration;
  if (registration && bundlePaths(registration, plan.source).length === 0 && JSON.stringify(bundlePaths(registration, plan.target)) === JSON.stringify(item.paths)) return null;
  if (!registration || found.revision !== item.revision || JSON.stringify(bundlePaths(registration, plan.source)) !== JSON.stringify(item.paths)) throw new Error("The MCP registration changed after inventory. Your edit was preserved; retarget it manually.");
  return movedRegistration(registration, plan);
}

function repairMcp(item: McpInventory, plan: MigrationPlan, config: MigrationConfigPort): void {
  const agent = AGENT_TYPES.find((agent) => item.id === `mcp:${agent}`);
  const spec = agent ? capabilitiesFor(agent).mcp : null;
  if (!spec) throw new Error("The inventoried MCP registration is no longer supported.");
  const found = config.readMcp(spec, plan.nonce);
  const desired = mcpRepair(item, found, plan);
  if (!desired) return;
  const after = config.writeMcp(spec, plan.nonce, found, desired);
  if (JSON.stringify(after.registration) !== JSON.stringify(desired)) throw new Error("MCP replacement could not be verified. Retry repair.");
}

function validBundlePath(item: BundlePath): boolean {
  if (!item || !Array.isArray(item.path) || !MCP_BUNDLE_SUFFIXES.includes(item.suffix)) return false;
  return (item.path.length === 1 && item.path[0] === "command") || (item.path.length === 2 && ((item.path[0] === "args" && Number.isInteger(item.path[1]) && Number(item.path[1]) >= 0) || (item.path[0] === "env" && typeof item.path[1] === "string")));
}

export async function repairMigrationIntegrations(journal: MigrationJournal, ports: MigrationIntegrationPorts): Promise<MigrationRepair[]> {
  const inventory = journal.inventory as MigrationIntegrationInventory;
  if (inventory?.schema !== 3 || !Array.isArray(inventory.hooks) || inventory.hooks.length > 512 || !Array.isArray(inventory.mcp) || inventory.mcp.length > AGENT_TYPES.length || typeof inventory.login !== "boolean" ||
    inventory.hooks.some((item) => !item || typeof item.command !== "string" || !Array.isArray(item.path) || item.path.length !== 6 || item.path[0] !== "hooks" || typeof item.path[1] !== "string" || !Number.isInteger(item.path[2]) || Number(item.path[2]) < 0 || item.path[3] !== "hooks" || !Number.isInteger(item.path[4]) || Number(item.path[4]) < 0 || item.path[5] !== "command" || movedHook(item.command, journal.plan) === item.command) ||
    inventory.mcp.some((item) => !item || typeof item.id !== "string" || typeof item.revision !== "string" || !/^\d+(?::\d+){4}$/.test(item.revision) || !Array.isArray(item.paths) || item.paths.length === 0 || item.paths.length > 1024 || item.paths.some((path) => !validBundlePath(path)) || !item.paths.some((path) => path.path[0] === "args" && path.suffix === "/Contents/Resources/app/dist/mcp/server.mjs"))) throw new Error("The integration inventory is invalid or unsupported. Recover the personal installation manually.");
  const config = ports.config ?? createMigrationConfigPort(ports);
  const results: MigrationRepair[] = [];
  const run = async (id: string, action: () => void | Promise<void>, safeMessage: string): Promise<void> => {
    try { await action(); results.push({id, status: "complete", message: `${id}: verified`}); }
    catch (error) {
      ports.log(`migration integration ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      results.push({id, status: "pending", message: safeMessage});
    }
  };
  await run("hooks", () => repairHooks(inventory, journal.plan, config), "Hook repair could not be verified. Retarget existing Mission Control hooks manually, then retry.");
  for (const item of inventory.mcp) await run(item.id, () => repairMcp(item, journal.plan, config), "MCP repair could not be verified. Retarget the existing Mission Control registration manually, then retry.");
  await run("skills", async () => {
    const problems = await ports.skills();
    if (problems.length) throw new Error("Enabled skill links need attention in Settings > Skills. Resolve their conflicts, then retry.");
  }, "Enabled skill links need attention in Settings > Skills. Resolve their conflicts, then retry.");
  await run("login", () => ports.retargetLogin(journal.plan, inventory.login), "Login startup could not be verified. Check the personal app's Open at Login setting, then retry.");
  return results;
}
