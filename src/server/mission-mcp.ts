import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { STATE_DIR, mcpServerPath } from "./config.ts";
import { run } from "./util/exec.ts";

// The one place that knows how to hand a LAUNCHING agent our own MCP server.
//
// There are two consumers and they speak different launch grammars - Claude takes a
// `--mcp-config` JSON file, Codex takes `-c mcp_servers.<name>.*` TOML overrides - but
// they are registering the SAME bundle, under the same name, through the same runtime,
// and the tool names an agent then calls are derived from that name. Two writers of that
// answer is two ways for a dispatched session to end up pointed at a stale path, an
// Electron binary with no `ELECTRON_RUN_AS_NODE`, or a server name whose tools no longer
// match the ones a prompt told the agent to call. So the resolution lives here once and
// each harness only renders it.
//
// Everything in this file is LAUNCH-scoped: it reaches sessions the dashboard dispatches
// and nothing else. Whatever `claude mcp add` / `codex mcp add` wrote into the machine's
// own config (see `src/main/integrations.ts`) is untouched, and a session an operator
// started themselves is untouched with it.

/** What the MCP server is registered as, and therefore the prefix its tools carry. */
export const MISSION_MCP_SERVER_NAME = "mission-control";

/**
 * Every tool the bundled server exposes (`src/mcp/server.ts`).
 *
 * A LIST rather than free text because the one thing a caller does with a tool name is
 * pre-approve it on the spawn argv, and a name that does not match what the server
 * registers pre-approves nothing at all - the agent still stops on a permission prompt,
 * which is precisely the failure the ask channel's `--allowed-tools` exists to prevent
 * and precisely the kind that shows up as "the agent just sat there". `mission-mcp.test.ts`
 * reads the server's own `registerTool` calls and fails if the two drift.
 */
export const MISSION_MCP_TOOLS = [
  "share_plan",
  "request_plan_decisions",
  "request_review",
  "create_task",
  "request_input",
  "report_status",
] as const;

export type MissionMcpTool = (typeof MISSION_MCP_TOOLS)[number];

/** The fully-qualified name, as an MCP client namespaces a server's tool. */
export function missionMcpToolName(tool: MissionMcpTool): string {
  return `mcp__${MISSION_MCP_SERVER_NAME}__${tool}`;
}

/**
 * What a launch REQUIRES of Mission MCP - stated as capabilities, never as argv.
 *
 * A caller says which of our tools the session it is launching has to be able to call;
 * this module decides what that costs in each harness's launch grammar. The alternative -
 * letting a caller hand down flags - would put the packaged-path, runtime and server-name
 * decisions back into every caller, which is the drift this module exists to remove.
 */
export interface MissionMcpRequirement {
  tools: readonly MissionMcpTool[];
}

/**
 * One resolved way to launch the bundled MCP server: a runtime, its argv, and the env
 * that runtime needs.
 *
 * The daemon runs either under a real `node` (dev, `npm start`) or inside an Electron
 * `utilityProcess`, where `process.execPath` is the Electron binary and needs
 * `ELECTRON_RUN_AS_NODE=1` to behave like node. Same problem `integrations.ts` solves for
 * `claude mcp add`, solved the same way and for the same reason: the agent launches this
 * bundle as an EXTERNAL process, so it needs a concrete, absolute runtime rather than
 * whatever happens to be on the spawned shell's PATH.
 */
export interface MissionMcpDescriptor {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Resolved once per daemon lifetime - it cannot change while we run, and it may shell out. */
let cachedRuntime: { command: string; env: Record<string, string> } | undefined;

async function resolveRuntime(): Promise<{ command: string; env: Record<string, string> }> {
  if (cachedRuntime) return cachedRuntime;
  // Already a real node (dev, or a daemon started directly): use it, no subprocess needed.
  if (/^node(\.exe)?$/.test(basename(process.execPath))) {
    return (cachedRuntime = { command: process.execPath, env: {} });
  }
  const which = await run("which", ["node"]);
  const found = which.stdout.trim().split("\n")[0];
  if (which.code === 0 && found && existsSync(found)) {
    return (cachedRuntime = { command: found, env: {} });
  }
  // No system node - run the Electron binary in node mode, exactly as integrations.ts does.
  return (cachedRuntime = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } });
}

/**
 * How to launch our MCP server on this machine, or NULL when it cannot be launched at all.
 *
 * Null means the bundle is not on disk (`npm run build` never ran, or a packaged build
 * resolved somewhere unexpected). It is returned rather than thrown because every caller's
 * correct response is to leave the launch alone: a dispatched session without our MCP
 * server is the status quo, whereas a dispatch that FAILS because a bundle is missing is a
 * session that would otherwise have launched fine. Callers say out loud what the absence
 * costs them - the sentences differ per harness - so this stays quiet.
 *
 * `mcpServerPath()` is the one resolver, and it lives in `config.ts` for the packaged-build
 * reason documented there; do not re-derive the path here.
 */
export async function missionMcpDescriptor(): Promise<MissionMcpDescriptor | null> {
  const server = mcpServerPath();
  if (!existsSync(server)) return null;
  const runtime = await resolveRuntime();
  return {
    serverName: MISSION_MCP_SERVER_NAME,
    command: runtime.command,
    args: [server],
    env: runtime.env,
  };
}

// ---- Claude: a launch-scoped `--mcp-config` file -------------------------------------

/**
 * The subdirectory holding the one file the spawn argv points at.
 *
 * Still spelled `ask-channel` after the serialization moved here, and deliberately: this
 * path is what an installed copy's `--mcp-config` already points at, and renaming it would
 * orphan that file on every machine rather than migrate it. The file is Claude's launch
 * grammar; its CONTENT is this module's.
 */
const CONFIG_DIR = join(STATE_DIR, "ask-channel");
const CONFIG_PATH = join(CONFIG_DIR, "mcp.json");

/** The paths the argv points at - for tests and for anyone debugging a dispatched session. */
export const missionMcpPaths = { dir: CONFIG_DIR, config: CONFIG_PATH };

/** The exact bytes of Claude's launch-scoped MCP config for this descriptor. */
export function missionMcpConfigJson(descriptor: MissionMcpDescriptor): string {
  return JSON.stringify(
    {
      mcpServers: {
        [descriptor.serverName]: {
          command: descriptor.command,
          args: descriptor.args,
          env: descriptor.env,
        },
      },
    },
    null,
    2,
  );
}

/**
 * Write `file` only when its content would change, and ATOMICALLY when it does.
 *
 * The skip is an optimisation; the atomicity is not. This path is what the spawn argv
 * points at, so a plain `writeFileSync` over it can be read half-written by a `claude` that
 * a concurrent dispatch started moments earlier. A truncated `mcp.json` means no
 * `request_input` while `--disallowed-tools` still applies - arm B exactly, the one state
 * the ask channel exists to prevent. Temp file in the SAME directory (so the rename cannot
 * cross a filesystem) then `renameSync`, which is atomic: a reader sees the old file or the
 * new one.
 */
function writeIfChanged(path: string, content: string): void {
  try {
    if (readFileSync(path, "utf8") === content) return;
  } catch {
    // Missing or unreadable: fall through and write it.
  }
  // Unique per writer, so two dispatches racing cannot share a temp file and interleave.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort - the throw below is what the caller acts on.
    }
    throw err;
  }
}

/**
 * Serialize the descriptor to Claude's config file and return the argv that points at it.
 *
 * Throws on a filesystem failure rather than returning a half-registration: the caller
 * (`askChannelArgs`) turns that into "no ask channel at all", which is the only safe
 * direction - see its own doc comment.
 */
export function claudeMissionMcpArgs(descriptor: MissionMcpDescriptor): string[] {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeIfChanged(CONFIG_PATH, missionMcpConfigJson(descriptor));
  return ["--mcp-config", CONFIG_PATH];
}

// ---- Codex: launch-scoped `-c mcp_servers.*` TOML overrides ---------------------------

/**
 * One TOML value, encoded so Codex's config parser reads back exactly the string we meant.
 *
 * `JSON.stringify` IS a TOML basic-string encoder for the characters an absolute path can
 * carry: TOML basic strings use the same `\"`, `\\` and `\uXXXX` escapes JSON does. The
 * same trick is already load-bearing one file over in `codexHookOverride`.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Register our MCP server on ONE Codex launch, as three `-c` overrides.
 *
 * Launch-scoped for the same reason Codex's hooks are (see `prepareCodexLaunch`): we only
 * reconfigure sessions WE start. Whatever `codex mcp add` wrote into `~/.codex/config.toml`
 * is untouched, and this composes with it rather than replacing it - a dotted `-c` override
 * merges into the loaded config, so an operator's other servers survive.
 *
 * All three keys together or none. A `command` with no `args` points Codex at a runtime
 * with nothing to run, and a registration missing its `env` launches an Electron binary
 * that is not in node mode - both are servers that appear registered, fail to start, and
 * leave the agent believing a tool exists that it can never call. `env` is emitted even
 * when empty, because an empty inline table is a statement ("this runtime needs nothing")
 * rather than an omission.
 *
 * Probed against codex-cli 0.145.0: `codex mcp list --json` with exactly these overrides
 * reports the server with the command, args and env round-tripped byte-for-byte, including
 * paths carrying spaces and single quotes, and including `env={}`.
 */
export function codexMissionMcpArgs(descriptor: MissionMcpDescriptor): string[] {
  const key = `mcp_servers.${descriptor.serverName}`;
  const args = descriptor.args.map(tomlString).join(",");
  const env = Object.entries(descriptor.env)
    .map(([name, value]) => `${tomlString(name)}=${tomlString(value)}`)
    .join(",");
  return [
    "-c", `${key}.command=${tomlString(descriptor.command)}`,
    "-c", `${key}.args=[${args}]`,
    "-c", `${key}.env={${env}}`,
  ];
}
