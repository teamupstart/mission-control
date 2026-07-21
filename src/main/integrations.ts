// In-app "Install Claude integrations".
//
// This is the packaged-app equivalent of `npm run install-hooks`: it wires the
// status-hook bridge into ~/.claude/settings.json and registers the MCP review
// server, but pointed at the satellites shipped inside the app bundle rather than
// a repo checkout. Claude Code launches these satellites itself, so they must be
// plain files runnable by an external process - we resolve a concrete runtime
// (a real `node` if we can find one, else this app in Node mode) and write an
// absolute command.
//
// The settings.json edit is surgical (jsonc-parser), touching only the hook
// arrays we own, exactly like hooks/install.mjs - the user's other hooks,
// comments, and formatting are preserved.
//
// Scope: hooks and the MCP server, NOT skills. Skills are the daemon's to install and
// remove, and the operator's to decide on, via the panel's master switch - which is the
// durable off-switch because it persists `enabled: false`. Removing links from here
// could not be durable: this process supervises the daemon, whose startup reconcile
// reads a config still saying `enabled: true` and would put every link straight back,
// re-broadcasting a reload to every session. A removal the next launch silently undoes is
// worse than one that never claimed to happen.

import { app } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";
import { writeOtelEnv } from "@shared/claude-settings.ts";
// One definition of the event vocabulary, on the harness that fires it - this file and
// `hooks/install.mjs` each used to hold a copy, hand-kept, with nothing catching drift.
// Imported from the spec's own module rather than through `harness/index.ts`: this file
// is bundled into the Electron main process, which must not pull the daemon (and
// `node:sqlite` behind it) in for the sake of nine strings. `harness/claude/hooks.ts`
// imports nothing but types and pure functions, and is kept that way for this reason.
import { claudeHooks } from "../server/harness/claude/hooks.ts";
import { AGENT_NAMES } from "@shared/agent.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import type { AgentType } from "@shared/types.ts";
import type { McpSpec } from "@shared/harness-capabilities.ts";

/**
 * The harness this installer wires. Named once, as a variable, because everything below
 * is still single-harness by design: the hook arrays live in `~/.claude/settings.json`,
 * and `EVENTS` comes from this same harness's `hooks` spec. Making the MCP half read a
 * capability is what stops the two from silently disagreeing when this becomes a loop.
 *
 * `@shared/harness-capabilities.ts` is pure by contract - the Electron main bundle
 * imports it, and must not pull `node:sqlite` in transitively. Same rule as
 * `@shared/claude-settings.ts` and `harness/claude/hooks.ts` above.
 */
const INTEGRATION_AGENT: AgentType = "claude";

const MARKER = "harness-hook";
const EVENTS = claudeHooks.events;
const MATCHER_EVENTS = new Set(claudeHooks.matcherEvents);

export interface IntegrationResult {
  ok: boolean;
  message: string;
}

/** A runtime that can execute a satellite .mjs, plus any env it needs. */
interface Runtime {
  /** How the runtime + script + args read as a settings.json command string. */
  hookCommand: (script: string, event: string) => string;
  /** argv for `claude mcp add` (command first, then the -e env flags). */
  mcpArgs: (script: string) => { env: string[]; argv: string[] };
  label: string;
}

/**
 * Absolute paths to the shipped satellites. We package with `asar: false`, so the
 * bundle lays the build outputs out as plain files under the app's Resources -
 * which is required anyway, because Claude Code launches these with an EXTERNAL
 * `node` that can't see inside an asar archive. Dev and packaged paths are thus
 * identical (both relative to the app root).
 */
function satellitePaths(): { hook: string; mcp: string } {
  const root = app.getAppPath();
  return {
    hook: join(root, "dist", "satellites", "hook.mjs"),
    mcp: join(root, "dist", "mcp", "server.mjs"),
  };
}

/** Try to locate a real `node` via the login shell; empty string if none. */
function findSystemNode(): string {
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-ilc", "command -v node"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && existsSync(out) ? out : "";
  } catch {
    return "";
  }
}

/**
 * Prefer a real `node` (lowest per-event overhead - the hook fires on every tool
 * use). Fall back to this app in Node mode (ELECTRON_RUN_AS_NODE) so integrations
 * still work with no system `node` installed.
 */
function resolveRuntime(): Runtime {
  const node = findSystemNode();
  if (node) {
    return {
      label: `node (${node})`,
      hookCommand: (script, event) => `"${node}" "${script}" ${event}`,
      mcpArgs: (script) => ({ env: [], argv: [node, script] }),
    };
  }
  const exe = process.execPath; // the Electron app binary
  return {
    label: "this app (ELECTRON_RUN_AS_NODE)",
    hookCommand: (script, event) => `ELECTRON_RUN_AS_NODE=1 "${exe}" "${script}" ${event}`,
    mcpArgs: (script) => ({ env: ["ELECTRON_RUN_AS_NODE=1"], argv: [exe, script] }),
  };
}

const settingsPath = (): string => join(homedir(), ".claude", "settings.json");

/** Our hook group for an event (matcher-first so re-runs are byte-stable). */
function ourGroup(command: string, event: string): unknown {
  const group = { hooks: [{ type: "command", command }] };
  return MATCHER_EVENTS.has(event) ? { matcher: "*", ...group } : group;
}

/** Strip any prior hook groups that reference our satellite. */
function stripOurs(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  return groups
    .map((g) => {
      const grp = g as { hooks?: unknown };
      if (!grp || !Array.isArray(grp.hooks)) return g;
      const hooks = grp.hooks.filter(
        (h) => !(h && typeof (h as { command?: unknown }).command === "string" && (h as { command: string }).command.includes(MARKER)),
      );
      return { ...grp, hooks };
    })
    .filter((g) => {
      const grp = g as { hooks?: unknown };
      return grp && Array.isArray(grp.hooks) && grp.hooks.length > 0;
    });
}

/** Rewrite settings.json's hook arrays for our events (install or uninstall). */
function editHooks(uninstall: boolean, hookCommand: (script: string, event: string) => string, hook: string): void {
  const path = settingsPath();
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const errors: unknown[] = [];
  const settings = parse(original || "{}", errors as never[], { allowTrailingComma: true }) as {
    hooks?: Record<string, unknown>;
  };
  if (original.trim() && errors.length > 0) {
    throw new Error(`~/.claude/settings.json is not valid JSON/JSONC - fix it and retry.`);
  }

  const formatting = {
    insertSpaces: !/^\t/m.test(original),
    tabSize: (original.match(/\n( +)\S/) ?? [, "  "])[1]?.length ?? 2,
    eol: (original.includes("\r\n") ? "\r\n" : "\n") as "\n" | "\r\n",
  };
  const apply = (text: string, jsonPath: (string | number)[], value: unknown): string =>
    applyEdits(text, modify(text, jsonPath, value, { formattingOptions: formatting }));

  let text = original.trim() ? original : "{}";
  const current = settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) ? settings.hooks : {};

  for (const event of EVENTS) {
    const existing = current[event];
    const desired = uninstall
      ? stripOurs(existing)
      : [...stripOurs(existing), ourGroup(hookCommand(hook, event), event)];
    if (desired.length > 0) {
      if (JSON.stringify(existing) !== JSON.stringify(desired)) text = apply(text, ["hooks", event], desired);
    } else if (existing !== undefined) {
      text = apply(text, ["hooks", event], undefined);
    }
  }
  // Drop an emptied hooks object after an uninstall.
  const after = parse(text, [], { allowTrailingComma: true }) as { hooks?: Record<string, unknown> };
  if (after?.hooks && typeof after.hooks === "object" && Object.keys(after.hooks).length === 0) {
    text = apply(text, ["hooks"], undefined);
  }

  if (text !== original) {
    mkdirSync(join(homedir(), ".claude"), { recursive: true });
    writeFileSync(path, text);
  }
}

/**
 * Register (or remove) the MCP review server via the harness's own CLI, best-effort.
 *
 * `spec` rather than a literal `"claude"` for the reason the whole capability layer
 * exists: this shells out to a binary and writes into that vendor's config, so a harness
 * with no `mcp` client of its own must not reach here at all. The caller checks the
 * capability; this function is only ever handed one that exists.
 */
function registerMcp(spec: McpSpec, add: boolean, runtime: Runtime, mcp: string): string {
  try {
    if (!add) {
      execFileSync(spec.cli, ["mcp", "remove", "-s", spec.scope, spec.serverName], {
        stdio: "ignore",
        timeout: 15000,
        env: { ...process.env, PATH: process.env.PATH },
      });
      return "MCP server removed.";
    }
    const { env, argv } = runtime.mcpArgs(mcp);
    const envFlags = env.flatMap((e) => ["-e", e]);
    execFileSync(
      spec.cli,
      ["mcp", "add", "-s", spec.scope, spec.serverName, ...envFlags, "--", ...argv],
      { stdio: "ignore", timeout: 15000 },
    );
    return "MCP review server registered.";
  } catch {
    return add
      ? `Hooks installed; the \`${spec.cli}\` CLI wasn't found on PATH, so the MCP review server wasn't registered (run \`${spec.cli} mcp add\` manually).`
      : `Hooks removed; couldn't reach the \`${spec.cli}\` CLI to remove the MCP server.`;
  }
}

/**
 * What to do about MCP for the harness this installer wires, as a sentence.
 *
 * `null` is a real answer and gets said out loud: an installer that silently skipped a
 * harness with no MCP client would report a clean install that did half the work.
 */
function applyMcp(add: boolean, runtime: Runtime, mcp: string): string {
  const spec = capabilitiesFor(INTEGRATION_AGENT).mcp;
  if (!spec) return `${AGENT_NAMES[INTEGRATION_AGENT].label} has no MCP client to register with.`;
  return registerMcp(spec, add, runtime, mcp);
}

/** Wire hooks + MCP for Claude Code. */
export function installIntegrations(): IntegrationResult {
  try {
    const { hook, mcp } = satellitePaths();
    if (!existsSync(hook)) {
      return { ok: false, message: `Satellite not found at ${hook}. Build first (npm run build).` };
    }
    const runtime = resolveRuntime();
    editHooks(false, runtime.hookCommand, hook);
    const mcpMsg = applyMcp(true, runtime, mcp);
    return {
      ok: true,
      message: `Claude integrations installed via ${runtime.label}. ${mcpMsg}\n\nStart a NEW Claude Code session for hooks to take effect.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove our hooks + MCP registration, leaving the user's other settings intact. */
export function removeIntegrations(): IntegrationResult {
  try {
    const { hook, mcp } = satellitePaths();
    const runtime = resolveRuntime();
    editHooks(true, runtime.hookCommand, hook);
    // TEARDOWN, and asymmetric with install on purpose - the same shape as the skill
    // symlinks. Installing telemetry is the Cost settings panel's job, because it edits
    // an `env` block that makes EVERY Claude session on the machine export to us and
    // that is an ask, not a side effect of pressing "Install integrations". Removing it
    // is unconditional, because an env block left pointing at a daemon that is no longer
    // installed makes every session on the machine retry an export forever.
    const telemetry = writeOtelEnv(null);
    const mcpMsg = applyMcp(false, runtime, mcp);
    const telemetryMsg = telemetry === "removed" ? " Cost telemetry env block removed." : "";
    return { ok: true, message: `Claude integrations removed. ${mcpMsg}${telemetryMsg}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
