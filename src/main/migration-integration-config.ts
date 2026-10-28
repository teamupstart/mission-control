// Filesystem, JSONC and CLI adapters for migration integration policy.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";
import type { McpSpec } from "@shared/harness-capabilities.ts";
import { publishIntegrationText, verifyIntegrationBackups } from "./migration-integration-file.ts";

export interface Registration { command: string; args: string[]; env?: Record<string, string> }
export interface HookEntry { path: (string | number)[]; command: string }
export interface HookSnapshot { entries: HookEntry[]; revision: string }
export interface McpSnapshot { registration: Registration | null; revision: string; present?: boolean }
export interface MigrationConfigPort {
  readHooks(nonce?: string): HookSnapshot;
  writeHooks(nonce: string, before: HookSnapshot, edits: {path: (string | number)[]; value: string}[]): HookSnapshot;
  readMcp(spec: McpSpec, nonce?: string): McpSnapshot;
  writeMcp(spec: McpSpec, nonce: string, before: McpSnapshot, desired: Registration): McpSnapshot;
}
interface ConfigEnvironment {
  home: string; environment?: NodeJS.ProcessEnv;
  command(spec: McpSpec, args: string[]): string;
}

// OS metadata detects a changed configuration without creating a password verifier.
function fileRevision(path: string): string {
  const stat = lstatSync(path, {bigint: true, throwIfNoEntry: false});
  return stat ? `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}` : "missing";
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

function jsonc(path: string, allowBlank = false): { text: string; value: Record<string, unknown>; revision: string } {
  const revision = fileRevision(path);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  if (fileRevision(path) !== revision) throw new Error("The integration configuration changed while reading it. Retry repair.");
  const errors: unknown[] = [];
  const value: unknown = parse(allowBlank && !text.trim() ? "{}" : text, errors as never[], {allowTrailingComma: true});
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("An integration configuration is invalid JSON/JSONC. Fix it before retrying.");
  return {text, value: value as Record<string, unknown>, revision};
}

/** Compare the full current file before atomic publication, then read it back. */
function editJsonc(path: string, nonce: string, original: string, edits: {path: (string | number)[]; value: unknown}[]): void {
  let text = original;
  for (const edit of edits) text = applyEdits(text, modify(text, edit.path, edit.value, {formattingOptions: {insertSpaces: !/^\t/m.test(original), tabSize: 2, eol: original.includes("\r\n") ? "\r\n" : "\n"}}));
  if (text === original) return;
  publishIntegrationText(path, nonce, original, text);
}

/** Shared surgical writer for installation and relocation, including first creation. */
export function editIntegrationSettings(home: string, nonce: string, transform: (original: string) => string): void {
  const path = integrationFile(home, ".claude/settings.json");
  verifyIntegrationBackups(path, nonce);
  // Installation may initialize an empty file. Retain its original bytes for publication checks.
  const config = jsonc(path, true);
  const original = config.revision === "missing" ? "" : config.text;
  const text = transform(original);
  if (text !== original) publishIntegrationText(path, nonce, original, text);
}

function registration(value: unknown): Registration | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.command !== "string" || !Array.isArray(r.args) || !r.args.every((x) => typeof x === "string")) return null;
  if (r.env !== undefined && r.env !== null && (!r.env || typeof r.env !== "object" || Array.isArray(r.env) || Object.values(r.env).some((x) => typeof x !== "string"))) return null;
  return {command: r.command, args: r.args as string[], ...(r.env ? {env: r.env as Record<string, string>} : {})};
}

function readMcp(spec: McpSpec, ports: ConfigEnvironment): McpSnapshot {
  const path = integrationFile(ports.home, spec.migration.homeFile);
  let revision = fileRevision(path);
  let raw: unknown;
  if (spec.migration.kind === "jsonc") {
    const config = jsonc(integrationFile(ports.home, spec.migration.homeFile));
    revision = config.revision;
    const servers = config.value[spec.migration.key] as Record<string, unknown> | undefined;
    raw = servers?.[spec.serverName];
    if (raw && typeof raw === "object" && "enabled" in raw && raw.enabled === false) return {registration: null, revision, present: true};
  } else {
    const configuredHome = ports.environment?.[spec.migration.homeVariable];
    if (configuredHome && resolve(configuredHome) !== dirname(join(ports.home, spec.migration.homeFile))) throw new Error("MCP uses a custom configuration home. Retarget that registration manually before migrating; its files were preserved.");
    if (!existsSync(integrationFile(ports.home, spec.migration.homeFile))) return {registration: null, revision};
    const output = ports.command(spec, ["mcp", "list", "--json"]);
    let list: unknown;
    try { list = JSON.parse(output); }
    catch { throw new Error("MCP inventory returned invalid JSON. Fix the CLI configuration before retrying."); }
    if (!Array.isArray(list)) throw new Error("MCP inventory returned an invalid registration list.");
    const matches = list.filter((entry) => entry?.name === spec.serverName);
    if (matches.length > 1) throw new Error("MCP inventory found duplicate Mission Control registrations.");
    const entry = matches[0];
    // The file identity binds the CLI snapshot without hashing credential values.
    if (fileRevision(path) !== revision) throw new Error("MCP configuration changed while its CLI was reading it. Retry repair.");
    if (entry?.enabled === false) return {registration: null, revision, present: true};
    return {registration: registration(entry?.transport), revision, ...(entry ? {present: true} : {})};
  }
  return {registration: registration(raw), revision, ...(raw !== undefined ? {present: true} : {})};
}

/** The supported CLI writes ordinary TOML tables. Edit just its named table and env
 * subtable, preserving options/comments. A custom TOML spelling is left for the user. */
function retargetMcpToml(path: string, nonce: string, name: string, before: Registration, desired: Registration, revision: string): void {
  const original = readFileSync(path, "utf8");
  if (fileRevision(path) !== revision) throw new Error("The MCP registration changed during repair. Your edit was preserved.");
  const names = new Set([name, JSON.stringify(name), "'" + name + "'"]);
  let tableKind: "main" | "env" | null = null;
  const candidates: [string, {before: unknown; after: unknown}][] = [
    ["main:command", {before: before.command, after: desired.command}],
    ["main:args", {before: before.args, after: desired.args}],
    ...Object.entries(before.env ?? {}).map(([key, value]): [string, {before: unknown; after: unknown}] => [`env:${key}`, {before: value, after: desired.env![key]}]),
  ];
  const changes = new Map(candidates.filter(([, change]) => JSON.stringify(change.before) !== JSON.stringify(change.after)));
  const addedEnv = Object.entries(desired.env ?? {}).filter(([key]) => before.env?.[key] === undefined);
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
    if (tableKind === "main" && addedEnv.length && /^\s*(?:env|"env"|'env')\s*=/.test(line)) {
      throw new Error("This MCP registration uses custom inline TOML environment syntax. Retarget it manually; its settings were preserved.");
    }
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
    if (JSON.stringify(value) !== JSON.stringify(change.before) || changed.has(key)) throw new Error("The MCP file differs from its CLI inventory. Its settings were preserved.");
    changed.add(key);
    return `${entry[1]}${JSON.stringify(change.after)}${entry[4]}`;
  });
  if (addedEnv.length) {
    const envHeaders = lines.flatMap((line, index) => [...names].some(n =>
      new RegExp(`^\\s*\\[mcp_servers\\.${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.env\\]\\s*(?:#.*)?(?:\\r?\\n)?$`).test(line)) ? [index] : []);
    if (envHeaders.length > 1) throw new Error("Duplicate MCP environment tables require manual reconciliation.");
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const added = addedEnv.map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}${eol}`).join("");
    if (envHeaders.length) {
      const header = envHeaders[0]!;
      if (!lines[header]!.endsWith("\n")) lines[header] += eol;
      lines.splice(header + 1, 0, added);
    }
    else lines.push(`${eol}[mcp_servers.${JSON.stringify(name)}.env]${eol}${added}`);
  }
  const text = lines.join("");
  if (changed.size !== changes.size || text === original) throw new Error("This MCP registration uses custom TOML syntax. Retarget its Mission Control paths manually; its settings were preserved.");
  publishIntegrationText(path, nonce, original, text);
}


export function createMigrationConfigPort(ports: ConfigEnvironment): MigrationConfigPort {
  const hookPath = (): string => integrationFile(ports.home, ".claude/settings.json");
  const readHooks = (nonce?: string): HookSnapshot => {
    const path = hookPath();
    if (nonce) verifyIntegrationBackups(path, nonce);
    const config = jsonc(path);
    const entries: HookEntry[] = [];
    const events = config.value.hooks;
    if (events && typeof events === "object" && !Array.isArray(events)) {
      for (const [event, groups] of Object.entries(events)) {
        if (!Array.isArray(groups)) continue;
        groups.forEach((group, i) => {
          if (!Array.isArray(group?.hooks)) return;
          group.hooks.forEach((hook: {command?: unknown}, j: number) => {
            if (typeof hook?.command === "string") entries.push({path: ["hooks", event, i, "hooks", j, "command"], command: hook.command});
          });
        });
      }
    }
    return {entries, revision: config.revision};
  };
  return {
    readHooks,
    writeHooks(nonce, before, edits) {
      const path = hookPath();
      const config = jsonc(path);
      if (config.revision !== before.revision) throw new Error("Hooks changed during repair. Your edit was preserved.");
      editJsonc(path, nonce, config.text, edits);
      return readHooks();
    },
    readMcp(spec, nonce) {
      if (nonce) verifyIntegrationBackups(integrationFile(ports.home, spec.migration.homeFile), nonce);
      return readMcp(spec, ports);
    },
    writeMcp(spec, nonce, before, desired) {
      const path = integrationFile(ports.home, spec.migration.homeFile);
      if (!before.registration || fileRevision(path) !== before.revision) throw new Error("The MCP registration changed during repair. Your edit was preserved.");
      if (spec.migration.kind === "jsonc") {
        const config = jsonc(path);
        if (config.revision !== before.revision) throw new Error("The MCP registration changed during repair. Your edit was preserved.");
        const base = [spec.migration.key, spec.serverName];
        editJsonc(path, nonce, config.text, [
          {path: [...base, "command"], value: desired.command},
          {path: [...base, "args"], value: desired.args},
          ...Object.entries(desired.env ?? {}).map(([key, value]) => ({path: [...base, "env", key], value})),
        ]);
      } else {
        retargetMcpToml(path, nonce, spec.serverName, before.registration, desired, before.revision);
      }
      return readMcp(spec, ports);
    },
  };
}
