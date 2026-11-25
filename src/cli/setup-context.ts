import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HOST, runtimePort, readClientToken, stateDir } from "../shared/harness-runtime.mjs";
import { detectClaude, type ClaudeCli } from "./claude-cli.ts";
import type { CliIo } from "./commands/types.ts";

export interface SetupContext {
  io: CliIo;
  mode: "setup" | "doctor";
  off: boolean;
  stateHome: string;
  buildRoot: string;
  detectClaude: () => Promise<ClaudeCli | null>;
  request: (path: string, body?: unknown) => Promise<unknown>;
}

export const PluginListSchema = z.array(z.object({
  id: z.string(), version: z.string(), scope: z.string(), enabled: z.boolean(),
  errors: z.array(z.string()).optional().default([]),
}));
export const MOD_ID = "mission-control@mission-control";
const MarketplacesSchema = z.array(z.object({ name: z.string(), source: z.string(), path: z.string().optional() }));

export async function modMarketplace(cli: ClaudeCli) {
  return MarketplacesSchema.parse(JSON.parse(await cli.run(["plugin", "marketplace", "list", "--json"])))
    .find((marketplace) => marketplace.name === "mission-control");
}

export async function installedMod(cli: ClaudeCli) {
  return PluginListSchema.parse(JSON.parse(await cli.run(["plugin", "list", "--json"])))
    .find((plugin) => plugin.id === MOD_ID && plugin.scope === "user");
}

export function createSetupContext(io: CliIo, mode: SetupContext["mode"], off = false): SetupContext {
  // Both src/cli/setup-context.ts and dist/cli/mctl.mjs are two levels below the built tree root.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const stateHome = resolve(io.cwd, stateDir(io.env));
  return {
    io, mode, off, stateHome, buildRoot: join(root, "dist/mod"),
    detectClaude: () => detectClaude(io.env, io.cwd),
    request: async (path, body) => {
      const token = readClientToken({ ...io.env, MISSION_HOME: stateHome });
      const response = await fetch(`http://${HOST}:${runtimePort(io.env)}${path}`, {
        method: body === undefined ? "GET" : "PUT",
        headers: { "x-harness-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}; check the daemon and its token`);
      return response.json();
    },
  };
}

export async function readAllowedModCalls(root: string): Promise<{ exact: string[]; prefixes: string[] }> {
  const schema = z.object({ exact: z.array(z.string()), prefixes: z.array(z.string()) });
  return schema.parse(JSON.parse(await readFile(join(root, "mission-control/allowed-calls.json"), "utf8")));
}
