import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type { AdvisorEnvironment } from "@shared/protocol.ts";
import { claudeSettingsPath } from "@shared/claude-settings.ts";

// What Claude Code's own configuration says about the advisor, for the Harnesses panel's
// "will this session consult one" line. Read-only: Mission Control never writes
// `advisorModel` into the operator's settings (an advisor choice reaches a launch through
// the session-scoped flag layer instead).
//
// Only the USER settings file and the daemon's environment are read. A project's
// `.claude/settings.json` can name an advisor too, but that differs per checkout, so the
// panel says so rather than guessing which project it is describing.

/** The variable that removes the advisor tool from every session it reaches. */
const DISABLE = "CLAUDE_CODE_DISABLE_ADVISOR_TOOL";
/** Providers the advisor does not run on. */
const PROVIDERS = [
  ["CLAUDE_CODE_USE_BEDROCK", "Amazon Bedrock"],
  ["CLAUDE_CODE_USE_VERTEX", "Google Vertex AI"],
] as const;

/** The user settings file, by the same precedence the MCP trust check reads it. */
function settingsPath(): string {
  if (process.env.CLAUDE_SETTINGS_PATH) return process.env.CLAUDE_SETTINGS_PATH;
  if (process.env.CLAUDE_CONFIG_DIR) return join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
  return claudeSettingsPath();
}

/** A path as the operator would type it: `~/.claude/settings.json`, not the expanded form. */
function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Claude Code's reading of a boolean env value: set, and not an explicit false. */
function truthy(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    // A truncated file can still parse to a partial object that keeps a valid
    // `advisorModel`, so any recorded error means the file is unreadable, not half-read.
    const errors: ParseError[] = [];
    const parsed: unknown = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length > 0) return {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function claudeAdvisorEnvironment(env: NodeJS.ProcessEnv = process.env): AdvisorEnvironment {
  const path = settingsPath();
  const source = displayPath(path);
  const settings = readSettings(path);
  const settingsEnv =
    settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? (settings.env as Record<string, unknown>)
      : {};
  const inherited =
    typeof settings.advisorModel === "string" && settings.advisorModel.trim()
      ? settings.advisorModel.trim()
      : null;
  // Where a switch was found, named so the operator knows which file or process to change.
  const where = (key: string): string | null =>
    truthy(env[key]) ? "Mission Control's environment" : truthy(settingsEnv[key]) ? source : null;
  const disabledIn = where(DISABLE);
  let blocked: string | null = disabledIn ? `${DISABLE} is set in ${disabledIn}.` : null;
  for (const [key, provider] of PROVIDERS) {
    const providerIn = where(key);
    if (!blocked && providerIn) {
      blocked = `Claude Code is set to use ${provider} (${key} in ${providerIn}), and the advisor runs only on the Anthropic API.`;
    }
  }
  return { inherited, source, blocked };
}
