// Migration only edits inventoried Mission-owned paths. The ordinary Install
// integrations action still owns enabling integrations that are absent.
import { publishIntegrationText, verifyIntegrationBackups } from "./migration-integration-file.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";
import { AGENT_TYPES } from "@shared/types.ts";
import { capabilitiesFor, type McpSpec } from "@shared/harness-capabilities.ts";
import { isMissionHookCommand } from "../server/harness/claude/hooks.ts";
import type { MigrationPlan, MigrationRepair, MigrationJournal } from "../../scripts/install-migration.mjs";

interface Registration { command: string; args: string[]; env?: Record<string, string> }
interface McpInventory { id: string; registration: Registration; digest: string }
interface HookInventory { path: (string | number)[]; command: string }
export interface MigrationIntegrationInventory {
  schema: 1; hooks: HookInventory[]; mcp: McpInventory[]; login: boolean;
}
export interface MigrationIntegrationPorts {
  home: string;
  environment?: NodeJS.ProcessEnv;
  command(spec: McpSpec, args: string[]): string;
  login(): { openAtLogin: boolean; executableWillLaunchAtLogin?: boolean };
  retargetLogin(plan: MigrationPlan, openAtLogin: boolean): Promise<void>;
  skills(): Promise<string[]>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function integrationFile(home: string, relative: string): string {
  const path = join(home, relative);
  const file = lstatSync(path, {throwIfNoEntry: false});
  let parent = dirname(path);
  while (!existsSync(parent)) parent = dirname(parent);
  const root = realpathSync(home);
  const resolved = realpathSync(parent);
  if ((resolved !== root && !resolved.startsWith(`${root}/`)) || (file && (!file.isFile() || file.isSymbolicLink() || (process.getuid && file.uid !== process.getuid())))) {
    throw new Error("An integration configuration uses a custom link or ownership. Preserve it and retarget its Mission Control paths manually.");
  }
  return path;
}

function jsonc(path: string): { text: string; value: Record<string, unknown> } {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  const errors: unknown[] = [];
  const value: unknown = parse(text, errors as never[], {allowTrailingComma: true});
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("An integration configuration is invalid JSON/JSONC. Fix it before retrying.");
  return {text, value: value as Record<string, unknown>};
}

/** Compare the full current file before atomic publication, then read it back. */
function editJsonc(path: string, nonce: string, original: string, edits: {path: (string | number)[]; value: unknown}[]): void {
  let text = original;
  for (const edit of edits) text = applyEdits(text, modify(text, edit.path, edit.value, {formattingOptions: {insertSpaces: !/^\t/m.test(original), tabSize: 2, eol: original.includes("\r\n") ? "\r\n" : "\n"}}));
  if (text === original) return;
  publishIntegrationText(path, nonce, original, text);
}

function registration(value: unknown): Registration | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.command !== "string" || !Array.isArray(r.args) || !r.args.every((x) => typeof x === "string")) return null;
  if (r.env !== undefined && r.env !== null && (!r.env || typeof r.env !== "object" || Array.isArray(r.env) || Object.values(r.env).some((x) => typeof x !== "string"))) return null;
  return {command: r.command, args: r.args as string[], ...(r.env ? {env: r.env as Record<string, string>} : {})};
}

function readMcp(spec: McpSpec, ports: MigrationIntegrationPorts): { registration: Registration | null; digest: string } {
  let raw: unknown;
  if (spec.migration.kind === "jsonc") {
    const config = jsonc(integrationFile(ports.home, spec.migration.homeFile));
    const servers = config.value[spec.migration.key] as Record<string, unknown> | undefined;
    raw = servers?.[spec.serverName];
    if (raw && typeof raw === "object" && "enabled" in raw && raw.enabled === false) return {registration: null, digest: digest(raw)};
  } else {
    const configuredHome = ports.environment?.[spec.migration.homeVariable];
    if (configuredHome && resolve(configuredHome) !== dirname(join(ports.home, spec.migration.homeFile))) throw new Error("MCP uses a custom configuration home. Retarget that registration manually before migrating; its files were preserved.");
    if (!existsSync(integrationFile(ports.home, spec.migration.homeFile))) return {registration: null, digest: digest(null)};
    const output = ports.command(spec, ["mcp", "list", "--json"]);
    let list: unknown;
    try { list = JSON.parse(output); }
    catch { throw new Error("MCP inventory returned invalid JSON. Fix the CLI configuration before retrying."); }
    if (!Array.isArray(list)) throw new Error("MCP inventory returned an invalid registration list.");
    const matches = list.filter((entry) => entry?.name === spec.serverName);
    if (matches.length > 1) throw new Error("MCP inventory found duplicate Mission Control registrations.");
    const entry = matches[0];
    // Disabled entries stay disabled. Read the complete object into the comparison
    // digest so transport/options edits made after inventory are also detected.
    if (entry?.enabled === false) return {registration: null, digest: digest(entry)};
    return {registration: registration(entry?.transport), digest: digest(entry ?? null)};
  }
  return {registration: registration(raw), digest: digest(raw ?? null)};
}

function retargetPath(value: string, plan: MigrationPlan): string {
  return value.startsWith(`${plan.source}/`) ? `${plan.target}${value.slice(plan.source.length)}` : value;
}

function movedRegistration(before: Registration, plan: MigrationPlan): Registration {
  return {
    command: retargetPath(before.command, plan), args: before.args.map((arg) => retargetPath(arg, plan)),
    ...(before.env ? {env: Object.fromEntries(Object.entries(before.env).map(([key, value]) => [key, retargetPath(value, plan)]))} : {}),
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

export function inspectMigrationIntegrations(plan: MigrationPlan, ports: MigrationIntegrationPorts): MigrationIntegrationInventory {
  const hooks: HookInventory[] = [];
  const config = jsonc(integrationFile(ports.home, ".claude/settings.json"));
  const events = config.value.hooks;
  if (events && typeof events === "object" && !Array.isArray(events)) {
    for (const [event, groups] of Object.entries(events)) {
      if (!Array.isArray(groups)) continue;
      groups.forEach((group, i) => {
        if (!Array.isArray(group?.hooks)) return;
        group.hooks.forEach((hook: { command?: unknown }, j: number) => {
          if (typeof hook?.command === "string" && movedHook(hook.command, plan) !== hook.command) hooks.push({path: ["hooks", event, i, "hooks", j, "command"], command: hook.command});
        });
      });
    }
  }
  const mcp: McpInventory[] = [];
  for (const agent of AGENT_TYPES) {
    const spec = capabilitiesFor(agent).mcp;
    if (!spec) continue;
    const found = readMcp(spec, ports);
    const ownedScript = join(plan.source, "Contents/Resources/app/dist/mcp/server.mjs");
    if (found.registration?.args.includes(ownedScript)) mcp.push({id: `mcp:${agent}`, registration: found.registration, digest: found.digest});
  }
  return {schema: 1, hooks, mcp, login: ports.login().openAtLogin};
}

function valueAt(value: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string | number, unknown>)[key] : undefined, value);
}

function repairHooks(inventory: MigrationIntegrationInventory, plan: MigrationPlan, ports: MigrationIntegrationPorts): void {
  if (inventory.hooks.length === 0) return;
  const path = integrationFile(ports.home, ".claude/settings.json");
  verifyIntegrationBackups(path, plan.nonce);
  const current = jsonc(path);
  const edits = inventory.hooks.map((item) => {
    const desired = movedHook(item.command, plan);
    const found = valueAt(current.value, item.path);
    if (found !== item.command && found !== desired) throw new Error("A hook changed after inventory. Your edit was preserved; retarget that hook manually.");
    return {path: item.path, value: desired};
  });
  editJsonc(path, plan.nonce, current.text, edits);
}

/** The supported CLI writes ordinary TOML tables. Edit just its named table and env
 * subtable, preserving options/comments. A custom TOML spelling is left for the user. */
function retargetMcpToml(path: string, nonce: string, name: string, before: Registration, desired: Registration): void {
  const original = readFileSync(path, "utf8");
  const names = new Set([name, JSON.stringify(name), "'" + name + "'"]);
  let tableKind: "main" | "env" | null = null;
  const candidates: [string, {before: unknown; after: unknown}][] = [
    ["main:command", {before: before.command, after: desired.command}],
    ["main:args", {before: before.args, after: desired.args}],
    ...Object.entries(before.env ?? {}).map(([key, value]): [string, {before: unknown; after: unknown}] => [`env:${key}`, {before: value, after: desired.env![key]}]),
  ];
  const changes = new Map(candidates.filter(([, change]) => digest(change.before) !== digest(change.after)));
  const changed = new Set<string>();
  const lines = original.split(/(?<=\n)/).map((line) => {
    const table = /^\s*\[([^\]\n]+)\]\s*(?:#.*)?(?:\r?\n)?$/.exec(line);
    if (table) {
      const key = table[1]!;
      tableKind = [...names].some((n) => key === `mcp_servers.${n}`) ? "main"
        : [...names].some((n) => key === `mcp_servers.${n}.env`) ? "env" : null;
      return line;
    }
    if (!tableKind) return line;
    // Accept the CLI's ordinary one-line strings/arrays. Unsupported TOML is left
    // untouched instead of replacing path-shaped text in comments or custom options.
    const entry = /^(\s*([\w-]+|"[^"\n]+"|'[^'\n]+')\s*=\s*)("(?:[^"\\]|\\.)*"|'[^'\n]*'|\[(?:[^\]"\n]|"(?:[^"\\]|\\.)*")*\])(\s*(?:#.*)?(?:\r?\n)?)$/.exec(line);
    if (!entry) return line;
    const key = `${tableKind}:${entry[2]!.replace(/^["']|["']$/g, "")}`;
    const change = changes.get(key);
    if (!change) return line;
    const raw = entry[3]!;
    let value: unknown;
    try { value = raw.startsWith("'") ? raw.slice(1, -1) : JSON.parse(raw.replace(/,\s*\]$/, "]")); }
    catch { return line; }
    if (digest(value) !== digest(change.before) || changed.has(key)) throw new Error("The MCP file differs from its CLI inventory. Its settings were preserved.");
    changed.add(key);
    return `${entry[1]}${JSON.stringify(change.after)}${entry[4]}`;
  });
  const text = lines.join("");
  if (changed.size !== changes.size || text === original) throw new Error("This MCP registration uses custom TOML syntax. Retarget its Mission Control paths manually; its settings were preserved.");
  publishIntegrationText(path, nonce, original, text);
}

function repairMcp(item: McpInventory, plan: MigrationPlan, ports: MigrationIntegrationPorts): void {
  const agent = AGENT_TYPES.find((agent) => item.id === `mcp:${agent}`);
  const spec = agent ? capabilitiesFor(agent).mcp : null;
  if (!spec || !registration(item.registration)) throw new Error("The inventoried MCP registration is no longer supported.");
  const path = integrationFile(ports.home, spec.migration.homeFile);
  verifyIntegrationBackups(path, plan.nonce);
  const desired = movedRegistration(item.registration, plan);
  const found = readMcp(spec, ports);
  if (digest(found.registration) === digest(desired)) return;
  if (found.digest !== item.digest) throw new Error("The MCP registration changed after inventory. Your edit was preserved; retarget it manually.");
  if (spec.migration.kind === "jsonc") {
    const config = jsonc(path);
    const servers = config.value[spec.migration.key] as Record<string, unknown> | undefined;
    if (digest(servers?.[spec.serverName]) !== item.digest) throw new Error("The MCP registration changed during repair. Your edit was preserved.");
    // Update only paths, preserving all other registration fields, including env.
    const base = [spec.migration.key, spec.serverName];
    editJsonc(path, plan.nonce, config.text, Object.entries(desired).map(([key, value]) => ({path: [...base, key], value})));
  } else {
    retargetMcpToml(path, plan.nonce, spec.serverName, item.registration, desired);
  }
  if (digest(readMcp(spec, ports).registration) !== digest(desired)) throw new Error("MCP replacement could not be verified. Retry repair.");
}

export async function repairMigrationIntegrations(journal: MigrationJournal, ports: MigrationIntegrationPorts): Promise<MigrationRepair[]> {
  const inventory = journal.inventory as MigrationIntegrationInventory;
  if (inventory?.schema !== 1 || !Array.isArray(inventory.hooks) || inventory.hooks.length > 512 || !Array.isArray(inventory.mcp) || inventory.mcp.length > AGENT_TYPES.length || typeof inventory.login !== "boolean" ||
    inventory.hooks.some((item) => !item || typeof item.command !== "string" || !Array.isArray(item.path) || item.path.length !== 6 || item.path[0] !== "hooks" || typeof item.path[1] !== "string" || !Number.isInteger(item.path[2]) || Number(item.path[2]) < 0 || item.path[3] !== "hooks" || !Number.isInteger(item.path[4]) || Number(item.path[4]) < 0 || item.path[5] !== "command" || movedHook(item.command, journal.plan) === item.command) ||
    inventory.mcp.some((item) => !item || typeof item.id !== "string" || typeof item.digest !== "string" || !registration(item.registration))) throw new Error("The integration inventory is invalid. Recover the personal installation manually.");
  const results: MigrationRepair[] = [];
  const run = async (id: string, action: () => void | Promise<void>): Promise<void> => {
    try { await action(); results.push({id, status: "complete", message: `${id}: verified`}); }
    catch (error) { results.push({id, status: "pending", message: `${id}: ${error instanceof Error ? error.message.slice(0, 300) : "repair failed"}`}); }
  };
  await run("hooks", () => repairHooks(inventory, journal.plan, ports));
  for (const item of inventory.mcp) await run(item.id, () => repairMcp(item, journal.plan, ports));
  await run("skills", async () => {
    const problems = await ports.skills();
    if (problems.length) throw new Error("Enabled skill links need attention in Settings > Skills. Resolve their conflicts, then retry.");
  });
  await run("login", () => ports.retargetLogin(journal.plan, inventory.login));
  return results;
}
