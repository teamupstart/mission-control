import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parse as parseJson } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

import type { SetupStatus } from "@shared/setup-catalog.ts";
import { claudeSettingsPath } from "@shared/claude-settings.ts";
import { publishIntegrationText } from "../../main/migration-integration-file.ts";
import type { TerminalResult } from "../terminal/types.ts";

type TrustAgent = "claude" | "codex";
export const CLAUDE_MCP_ALLOW = "mcp__mission-control__*";
const APPROVAL_KEY = "default_tools_approval_mode";
const ClaudeSettings = z.object({
  permissions: z.object({
    allow: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).passthrough().optional(),
}).passthrough();
const CodexSettings = z.object({
  mcp_servers: z.record(z.object({
    command: z.string().optional(),
    url: z.string().optional(),
    default_tools_approval_mode: z.enum(["auto", "prompt", "writes", "approve"]).optional(),
  }).passthrough()).optional(),
}).passthrough();

export function mcpTrustPath(agent: TrustAgent): string {
  return agent === "claude"
    ? process.env.CLAUDE_SETTINGS_PATH ?? (process.env.CLAUDE_CONFIG_DIR
      ? join(process.env.CLAUDE_CONFIG_DIR, "settings.json") : claudeSettingsPath())
    : join(process.env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

function claudeConfig(text: string) {
  const errors: unknown[] = [];
  const parsed: unknown = parseJson(text.trim() ? text : "{}", errors as never[], { allowTrailingComma: true });
  const result = ClaudeSettings.safeParse(parsed);
  if (errors.length || !result.success) throw new Error("Invalid Claude settings JSON/JSONC or permissions shape. Fix the file and retry.");
  return result.data;
}

function codexConfig(text: string) {
  try { return CodexSettings.parse(parseToml(text)); }
  catch { throw new Error("Invalid Codex TOML or MCP settings shape. Fix the file and retry."); }
}

/** Only the local default is checked; higher priority policies and explicit overrides still win. */
export function hasMcpTrust(agent: TrustAgent, text: string): boolean {
  if (agent === "claude") {
    return claudeConfig(text).permissions?.allow?.includes(CLAUDE_MCP_ALLOW) ?? false;
  }
  const server = codexConfig(text).mcp_servers?.["mission-control"];
  return !!(server?.command || server?.url) && server.default_tools_approval_mode === "approve";
}

/** Preserve comments and unrelated bytes. Refuse TOML layouts we cannot edit surgically. */
export function withMcpTrust(agent: TrustAgent, original: string): string {
  if (hasMcpTrust(agent, original)) return original;
  if (agent === "claude") {
    const settings = claudeConfig(original);
    const source = original.trim() ? original : "{}";
    const formattingOptions = {
      insertSpaces: !/^\t/m.test(source),
      tabSize: /\n( +)\S/.exec(source)?.[1]?.length ?? 2,
      eol: original.includes("\r\n") ? "\r\n" : "\n",
    };
    return applyEdits(source, settings.permissions?.allow
      ? modify(source, ["permissions", "allow", -1], CLAUDE_MCP_ALLOW, { isArrayInsertion: true, formattingOptions })
      : modify(source, ["permissions", "allow"], [CLAUDE_MCP_ALLOW], { formattingOptions }));
  }
  const desired = codexConfig(original);
  const server = desired.mcp_servers?.["mission-control"];
  if (!server || !(server.command || server.url)) {
    throw new Error("Install the Mission Control MCP integration in Codex first, then retry trust setup.");
  }
  server.default_tools_approval_mode = "approve";
  const headers = [...original.matchAll(/^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:mission-control|"mission-control"|'mission-control')[ \t]*\][ \t]*(?:#[^\r\n]*)?(?=\r?$)/gm)];
  if (headers.length !== 1) throw new Error("Use a [mcp_servers.mission-control] table in Codex config.toml, then retry trust setup.");
  const header = headers[0]!;
  const start = header.index! + header[0].length;
  const next = original.slice(start).search(/^[ \t]*\[/m);
  const end = next < 0 ? original.length : start + next;
  const body = original.slice(start, end);
  const key = /^[ \t]*(?:default_tools_approval_mode|"default_tools_approval_mode"|'default_tools_approval_mode')[ \t]*=[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*')/gm;
  const matches = [...body.matchAll(key)];
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const edited = matches.length === 1
    ? body.replace(key, `${APPROVAL_KEY} = "approve"`)
    : `${eol}${APPROVAL_KEY} = "approve"${body || eol}`;
  const result = original.slice(0, start) + edited + original.slice(end);
  // A header-like line inside a multiline string must never be mistaken for a real table.
  // Full parsing also catches duplicate keys and dotted/inline layouts before publication.
  if (!isDeepStrictEqual(codexConfig(result), desired)) {
    throw new Error("Codex MCP settings use a custom TOML layout. Set default_tools_approval_mode = \"approve\" in the Mission Control server table manually.");
  }
  return result;
}

function readConfig(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function mcpTrustStatus(agent: TrustAgent, path = mcpTrustPath(agent)): SetupStatus {
  try {
    return hasMcpTrust(agent, readConfig(path))
      ? { state: "satisfied", evidence: `${path}: Mission Control MCP allowed by default; explicit restrictions still apply.` }
      : { state: "needs-setup", why: "Mission Control MCP is not allowed by default in this agent's user settings.", evidence: path };
  } catch (error) {
    return { state: "unknown", why: error instanceof Error ? error.message : "Could not read MCP trust settings.", evidence: path };
  }
}

export function enableMcpTrust(agent: TrustAgent, path = mcpTrustPath(agent)): TerminalResult {
  try {
    const original = readConfig(path);
    const text = withMcpTrust(agent, original);
    // Reuse integration publication: private recovery copy, concurrent-edit checks and
    // atomic no-replace publication. No backup or rewrite for an already satisfied setting.
    if (text !== original) {
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error("Mission Control cannot update a symlinked settings file. Replace the symlink with a regular file, then retry.");
      }
      publishIntegrationText(path, randomBytes(32).toString("hex"), original, text);
    }
    return { ok: true, outcomeUnknown: false };
  } catch (error) {
    return { ok: false, outcomeUnknown: false, error: error instanceof Error ? error.message : "Could not write MCP trust settings." };
  }
}
