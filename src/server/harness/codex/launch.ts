import { existsSync } from "node:fs";
import { codexHookPath } from "../../config.ts";
import { CODEX_HOOK_EVENTS } from "./hooks.ts";

export interface CodexLaunchPreparation { args: string[]; instrumented: boolean }

/**
 * Complete, launch-scoped Codex hook configuration. Never returns a lone trust bypass.
 *
 * `--dangerously-bypass-hook-trust` rides with the `-c hooks.*` overrides and only with
 * them: Codex would otherwise stop at a trust prompt for hooks the dashboard itself just
 * injected, and a dispatched session has no human at the keyboard to answer it.
 *
 * The flag is process-wide for that launch, so it also clears any hook the dispatched
 * checkout's own Codex config declares - a real widening, and the reason it is spent only
 * here. Dispatch is a launch the operator asked for, into a repo they named, and it is
 * the only path that reaches this function; a Codex session started by hand never sees
 * the flag. Note this is NOT the repo allowlist (`repoAllowlisted`), which gates Foreman,
 * the Inspector and shipping and does not gate dispatch.
 */
export function prepareCodexLaunch(auto: boolean): CodexLaunchPreparation {
  const safe = auto ? ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"] : [];
  const bridge = codexHookPath();
  if (!existsSync(bridge)) return { args: safe, instrumented: false };
  const overrides = CODEX_HOOK_EVENTS.flatMap((event) => [
    "-c",
    `hooks.${event}=[{command=[${JSON.stringify(process.execPath)},${JSON.stringify(bridge)},${JSON.stringify(event)}]}]`,
  ]);
  return { args: [...safe, ...overrides, "--dangerously-bypass-hook-trust"], instrumented: true };
}
