import { existsSync } from "node:fs";
import { codexHookPath } from "../../config.ts";
import { CODEX_HOOK_EVENTS } from "./hooks.ts";

export interface CodexLaunchPreparation { args: string[]; instrumented: boolean }

/** One argv word in the POSIX shell command Codex's command-hook schema requires. */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * One session-layer hook override in Codex's three-level event -> matcher -> handler shape.
 *
 * The command hook is a shell string, not an argv array. The old compact shape put
 * `command=[node, bridge, event]` directly on the matcher group. Codex's permissive config
 * loader accepted that TOML but found no handler inside it, so every dispatched session
 * launched successfully and silently emitted no hooks. `UserPromptSubmit` was therefore
 * never captured, leaving Codex goals blank before the configured refiner model (including
 * Luna) had anything to run on.
 */
export function codexHookOverride(
  event: (typeof CODEX_HOOK_EVENTS)[number],
  bridge: string,
  node = process.execPath,
): string {
  const command = [node, bridge, event].map(shellWord).join(" ");
  return `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)}}]}]`;
}

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
    codexHookOverride(event, bridge),
  ]);
  return { args: [...safe, ...overrides, "--dangerously-bypass-hook-trust"], instrumented: true };
}
