// In-app "Install Claude integrations".
//
// This is the packaged-app equivalent of `npm run install-hooks`: it wires the
// status-hook bridge into ~/.claude/settings.json and registers the MCP review
// server, but pointed at the satellites shipped inside the app bundle rather than
// a repo checkout. Claude Code launches these satellites itself, so they must be
// plain files runnable by an external process - we resolve a concrete runtime
// (this app in Node mode) and write an
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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";
import { writeOtelEnv } from "@shared/claude-settings.ts";
import { locateCommandSync } from "../server/executables/locator.ts";
// One definition of the event vocabulary, on the harness that fires it - this file and
// `hooks/install.mjs` each used to hold a copy, hand-kept, with nothing catching drift.
// Imported from the spec's own module rather than through `harness/index.ts`: this file
// is bundled into the Electron main process, which must not pull the daemon (and
// `node:sqlite` behind it) in for the sake of nine strings. `harness/claude/hooks.ts`
// imports nothing but types and pure functions, and is kept that way for this reason.
import { claudeHooks, isMissionHookCommand } from "../server/harness/claude/hooks.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { AGENT_TYPES } from "@shared/types.ts";
import { capabilitiesFor } from "@shared/harness-capabilities.ts";
import type { McpSpec } from "@shared/harness-capabilities.ts";
import { stateDir } from "@shared/harness-runtime.mjs";
import { integrationRuntime, ownedHook, ownedStatusline, repairOwnedMcp, sameRegistration, INTEGRATION_REPAIR_NONCE } from "./integration-runtime.ts";
import { createMigrationConfigPort, editIntegrationSettings } from "./migration-integration-config.ts";
import { createMigrationIntegrationPorts } from "./migration-integration-ports.ts";
import { type MigrationIntegrationPorts } from "./migration-integrations.ts";

export function migrationIntegrationPorts(): MigrationIntegrationPorts {
  return createMigrationIntegrationPorts(app);
}

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
const EVENTS = claudeHooks.events;
const MATCHER_EVENTS = new Set(claudeHooks.matcherEvents);

export interface IntegrationResult {
  ok: boolean;
  message: string;
}

type Runtime = ReturnType<typeof integrationRuntime>;

/**
 * Absolute paths to the shipped satellites. We package with `asar: false`, so the
 * bundle lays the build outputs out as plain files under the app's Resources -
 * required because other processes launch these scripts through the app runtime. Dev and packaged paths are thus
 * identical (both relative to the app root).
 */
function satellitePaths(): { hook: string; mcp: string; statusline: string } {
  const root = app.getAppPath();
  return {
    hook: join(root, "dist", "satellites", "hook.mjs"),
    mcp: join(root, "dist", "mcp", "server.mjs"),
    statusline: join(root, "dist", "satellites", "harness-statusline.mjs"),
  };
}

/** Electron main knows its runtime; never ask the external executable locator. */
function resolveRuntime(): Runtime {
  return integrationRuntime(process.execPath, "electron");
}

/** Our hook group for an event (matcher-first so re-runs are byte-stable). */
function ourGroup(command: string, event: string): unknown {
  const group = { hooks: [{ type: "command", command }] };
  return MATCHER_EVENTS.has(event) ? { matcher: "*", ...group } : group;
}

/** Rewrite settings.json's hook arrays for our events (install or uninstall). */
function editHooks(uninstall: boolean, runtime: Runtime, hook: string, statusline: string): void {
  if ((process.env.CLAUDE_SETTINGS_PATH && resolve(process.env.CLAUDE_SETTINGS_PATH) !== join(homedir(), ".claude/settings.json"))
    || (process.env.CLAUDE_CONFIG_DIR && resolve(process.env.CLAUDE_CONFIG_DIR) !== join(homedir(), ".claude"))) {
    throw new Error("Claude uses a custom settings path. Retarget its Mission commands manually; its settings were preserved.");
  }
  editIntegrationSettings(homedir(), INTEGRATION_REPAIR_NONCE, (original) => {
    const errors: unknown[] = [];
    const settings = parse(original.trim() ? original : "{}", errors as never[], { allowTrailingComma: true }) as {
      hooks?: Record<string, unknown>;
      statusLine?: { command?: string };
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
      const groups = current[event];
      let found = false;
      if (Array.isArray(groups)) {
        const ownedGroups: {index: number; hooks: number[]; total: number}[] = [];
        for (let i = 0; i < groups.length; i++) {
          const hooks = groups[i]?.hooks;
          if (!Array.isArray(hooks)) continue;
          const owned: number[] = [];
          for (let j = 0; j < hooks.length; j++) {
            const command = hooks[j]?.command;
            if (typeof command !== "string") continue;
            if (ownedHook(command)) owned.push(j);
            else if (isMissionHookCommand(command)) throw new Error("A Mission hook uses a custom command. Retarget it manually; its settings were preserved.");
          }
          if (owned.length) ownedGroups.push({index: i, hooks: owned, total: hooks.length});
        }
        found = ownedGroups.length > 0;
        // Earlier installers appended duplicates. Keep the first owned hook's
        // matcher, timeout and disabled flags; remove only later owned entries.
        const keeper = uninstall ? undefined : ownedGroups[0];
        // Reverse deletion order keeps JSON paths stable and preserves unrelated entries.
        for (const group of ownedGroups.reverse()) {
          const keep = group === keeper ? group.hooks[0] : undefined;
          if (keep === undefined && group.hooks.length === group.total) {
            text = apply(text, ["hooks", event, group.index], undefined);
          } else for (const j of group.hooks.reverse()) {
            text = j === keep
              ? apply(text, ["hooks", event, group.index, "hooks", j, "command"], runtime.hookCommand(hook, event))
              : apply(text, ["hooks", event, group.index, "hooks", j], undefined);
          }
        }
      }
      if (!uninstall && !found) {
        text = Array.isArray(groups) ? apply(text, ["hooks", event, -1], ourGroup(runtime.hookCommand(hook, event), event))
          : apply(text, ["hooks", event], [ourGroup(runtime.hookCommand(hook, event), event)]);
      }
    }
    // Drop an emptied hooks object after an uninstall.
    const after = parse(text, [], { allowTrailingComma: true }) as { hooks?: Record<string, unknown> };
    if (after?.hooks && typeof after.hooks === "object" && Object.keys(after.hooks).length === 0) {
      text = apply(text, ["hooks"], undefined);
    }

    const sl = settings.statusLine;
    if (typeof sl?.command === "string" && ownedStatusline(sl.command)) {
      if (uninstall) {
        let inner = "";
        try { inner = readFileSync(join(stateDir(), "statusline-inner"), "utf8").trim(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The saved statusline command could not be read. Settings were preserved."); }
        text = apply(text, ["statusLine"], inner ? { ...sl, command: inner } : undefined);
      } else {
        if (!existsSync(statusline)) throw new Error("The shipped statusline wrapper is missing. Reinstall the app, then retry.");
        text = apply(text, ["statusLine", "command"], runtime.hookCommand(statusline));
      }
    }
    return text;
  });
}

/**
 * Register (or remove) the MCP review server via the harness's own CLI, best-effort.
 *
 * `spec` rather than a literal `"claude"` for the reason the whole capability layer
 * exists: this shells out to a binary and writes into that vendor's config, so a harness
 * with no `mcp` client of its own must not reach here at all. The caller checks the
 * capability; this function is only ever handed one that exists.
 */
function registerMcp(spec: McpSpec, add: boolean, runtime: Runtime, mcp: string): IntegrationResult {
  try {
    const config = createMigrationConfigPort(migrationIntegrationPorts());
    const before = config.readMcp(spec, INTEGRATION_REPAIR_NONCE);
    if (!add) {
      if (!before.registration || !repairOwnedMcp(before.registration, runtime, mcp)) return { ok: true, message: "Disabled, absent or custom MCP registration preserved." };
      const executable = locateCommandSync(spec.cli);
      if (!executable) throw new Error(`${spec.cli} was not found`);
      // The named entry may have been replaced while resolving the vendor CLI.
      // Require both the same file identity and the same owned registration.
      const current = config.readMcp(spec, INTEGRATION_REPAIR_NONCE);
      if (current.revision !== before.revision || !sameRegistration(current.registration, before.registration)) {
        return { ok: false, message: "MCP registration changed before removal. It was preserved; re-check it before retrying." };
      }
      execFileSync(executable.path, ["mcp", "remove", ...(spec.scope ? ["-s", spec.scope] : []), spec.serverName], {
        stdio: "ignore",
        timeout: 15000,
        env: executable.env,
      });
      return { ok: true, message: "MCP server removed." };
    }
    if (before.present || before.registration) {
      if (!before.registration) return { ok: true, message: "Existing disabled or custom MCP registration preserved." };
      const desired = repairOwnedMcp(before.registration, runtime, mcp);
      if (!desired) return { ok: true, message: "Custom MCP registration preserved. Retarget its Mission runtime manually." };
      if (!sameRegistration(before.registration, desired)) {
        const after = config.writeMcp(spec, INTEGRATION_REPAIR_NONCE, before, desired);
        if (!sameRegistration(after.registration, desired)) throw new Error("MCP repair could not be verified; reconcile its preserved configuration manually.");
      }
      return { ok: true, message: "Existing MCP registration repaired with the app runtime." };
    }
    const executable = locateCommandSync(spec.cli);
    if (!executable) throw new Error(`${spec.cli} was not found`);
    const { env, argv } = runtime.mcpArgs(mcp);
    const envFlags = env.flatMap((e) => [spec.envFlag, e]);
    execFileSync(
      executable.path,
      ["mcp", "add", ...(spec.scope ? ["-s", spec.scope] : []), spec.serverName, ...envFlags, "--", ...argv],
      { stdio: "ignore", timeout: 15000, env: executable.env },
    );
    return { ok: true, message: "MCP review server registered." };
  } catch (error) {
    return { ok: false, message: add
      ? `MCP installation needs attention: ${error instanceof Error ? error.message : "Inspect the CLI configuration and retry."}`
      : `MCP removal needs attention: ${error instanceof Error ? error.message : "Inspect the CLI configuration and retry."}` };
  }
}

/**
 * What to do about MCP for the harness this installer wires, as a sentence.
 *
 * `null` is a real answer and gets said out loud: an installer that silently skipped a
 * harness with no MCP client would report a clean install that did half the work.
 */
function applyMcp(add: boolean, runtime: Runtime, mcp: string): IntegrationResult {
  const results = AGENT_TYPES.map((agent) => {
    const spec = capabilitiesFor(agent).mcp;
    const label = AGENT_IDENTITY[agent].label;
    if (!spec) return { ok: true, message: `${label}: no MCP client to register with.` };
    const result = registerMcp(spec, add, runtime, mcp);
    return { ...result, message: `${label}: ${result.message}` };
  });
  return { ok: results.every(result => result.ok), message: results.map(result => result.message).join(" ") };
}

/** Wire hooks + MCP for Claude Code. */
export function installIntegrations(): IntegrationResult {
  try {
    const { hook, mcp, statusline } = satellitePaths();
    if (!existsSync(hook)) {
      return { ok: false, message: `Satellite not found at ${hook}. Reinstall the app, or run npm run build in a source checkout.` };
    }
    const runtime = resolveRuntime();
    editHooks(false, runtime, hook, statusline);
    const mcpResult = applyMcp(true, runtime, mcp);
    return {
      ok: mcpResult.ok,
      message: `${mcpResult.ok ? "Claude integrations" : "Claude hooks"} installed via ${runtime.label}. ${mcpResult.message}\n\nStart a NEW Claude Code session for hooks to take effect.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove our hooks + MCP registration, leaving the user's other settings intact. */
export function removeIntegrations(): IntegrationResult {
  try {
    const { hook, mcp, statusline } = satellitePaths();
    const runtime = resolveRuntime();
    editHooks(true, runtime, hook, statusline);
    // TEARDOWN, and asymmetric with install on purpose - the same shape as the skill
    // symlinks. Installing telemetry is the Cost settings panel's job, because it edits
    // an `env` block that makes EVERY Claude session on the machine export to us and
    // that is an ask, not a side effect of pressing "Install integrations". Removing it
    // is unconditional, because an env block left pointing at a daemon that is no longer
    // installed makes every session on the machine retry an export forever.
    const telemetry = writeOtelEnv(null);
    const mcpResult = applyMcp(false, runtime, mcp);
    const telemetryMsg = telemetry === "removed" ? " Cost telemetry env block removed." : "";
    return { ok: mcpResult.ok, message: `${mcpResult.ok ? "Claude integrations" : "Claude hooks"} removed. ${mcpResult.message}${telemetryMsg}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
