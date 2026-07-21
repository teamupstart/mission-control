import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { CODEX_HOOK_EVENTS } from "./hooks.ts";

export interface CodexLaunchPreparation { args: string[]; instrumented: boolean }

function hookPath(): string {
  return process.env.MISSION_CODEX_HOOK ?? fileURLToPath(new URL("../../../../dist/satellites/codex-hook.mjs", import.meta.url));
}

/** Complete, launch-scoped Codex hook configuration. Never returns a lone trust bypass. */
export function prepareCodexLaunch(auto: boolean): CodexLaunchPreparation {
  const safe = auto ? ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"] : [];
  const bridge = hookPath();
  if (!existsSync(bridge)) return { args: safe, instrumented: false };
  const overrides = CODEX_HOOK_EVENTS.flatMap((event) => [
    "-c",
    `hooks.${event}=[{command=[${JSON.stringify(process.execPath)},${JSON.stringify(bridge)},${JSON.stringify(event)}]}]`,
  ]);
  return { args: [...safe, ...overrides, "--dangerously-bypass-hook-trust"], instrumented: true };
}
