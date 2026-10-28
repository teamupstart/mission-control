import { basename, isAbsolute } from "node:path";
import { ownedScriptCommand, resolveOwnedRuntime } from "@shared/owned-runtime.mjs";
import { isMissionHookCommand } from "../server/harness/claude/hooks.ts";
import type { Registration } from "./migration-integration-config.ts";

export const INTEGRATION_REPAIR_NONCE = "6b2ef50c5ff44f5eabb62538f8e436ce8a0fb612a29fc88bf2f753531e4eef61";

export function integrationRuntime(executable: string, kind: "node" | "electron") {
  const runtime = resolveOwnedRuntime({ executable, kind });
  return {
    ...runtime,
    label: kind === "electron" ? "this app's bundled Node" : `Node (${executable})`,
    hookCommand: (script: string, event?: string) => ownedScriptCommand(runtime, script, event ? [event] : []),
    mcpArgs: (script: string) => ({ env: Object.entries(runtime.env).map(([k, v]) => `${k}=${v}`), argv: [runtime.command, script] }),
  };
}

// Accept only literal invocations emitted by our installers. An opaque shell command
// containing a Mission filename is not authority to rewrite the user's shell program.
export function ownedInvocation(command: string): { executable: string; script: string; event?: string } | null {
  const match = /^(?:ELECTRON_RUN_AS_NODE=(?:1|"1") )?"((?:[^"\\$`]|\\[\\"$`])+)" "((?:[^"\\$`]|\\[\\"$`])+)"(?: (?:"([A-Za-z]+)"|([A-Za-z]+)))?$/.exec(command);
  if (!match) return null;
  const decode = (s: string) => s.replace(/\\([\\"$`])/g, "$1");
  const executable = decode(match[1]!);
  const script = decode(match[2]!);
  if (!isAbsolute(executable) || !isAbsolute(script) || !ownedInterpreter(executable)) return null;
  return { executable, script, event: match[3] ?? match[4] };
}

function ownedInterpreter(executable: string): boolean {
  return /^node(?:\.exe)?$/.test(basename(executable))
    || /\.app\/Contents\/MacOS\/(?:Mission Control|Agent Mission Control|Electron)$/.test(executable);
}

export function ownedHook(command: string): ReturnType<typeof ownedInvocation> {
  const invocation = ownedInvocation(command);
  return invocation && isMissionHookCommand(command)
    && /\/(?:hooks\/harness-hook|dist\/satellites\/hook)\.mjs$/.test(invocation.script) ? invocation : null;
}

export function ownedStatusline(command: string): boolean {
  const invocation = ownedInvocation(command);
  return Boolean(invocation && !invocation.event
    && /\/(?:hooks\/harness-statusline|dist\/satellites\/harness-statusline)\.mjs$/.test(invocation.script));
}

/** Named registration plus exact script/runtime shape prove installer ownership. */
export function repairOwnedMcp(before: Registration, runtime: ReturnType<typeof integrationRuntime>, script: string): Registration | null {
  if (!isAbsolute(before.command) || !ownedInterpreter(before.command)
    || before.args.length !== 1 || !isAbsolute(before.args[0]!)
    || !before.args[0]!.endsWith("/dist/mcp/server.mjs")) return null;
  if (before.env?.ELECTRON_RUN_AS_NODE !== undefined && before.env.ELECTRON_RUN_AS_NODE !== "1") return null;
  return { command: runtime.command, args: [script], env: { ...before.env, ...runtime.env } };
}

export function sameRegistration(a: Registration | null, b: Registration): boolean {
  return Boolean(a && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args)
    && JSON.stringify(Object.entries(a.env ?? {}).sort()) === JSON.stringify(Object.entries(b.env ?? {}).sort()));
}
