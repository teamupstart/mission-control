import type { WorktreeClaimVariableSource } from "@shared/worktrees.ts";

/** Where a named variable's value may come from, in the order they are consulted. */
export interface NamedVariableSources {
  daemonEnv: NodeJS.ProcessEnv;
  daemonToken: string;
  loginShell: Readonly<Record<string, string>>;
}

/**
 * The one rule for a named variable's value, shared by the step environment and the settings
 * presence check so the two can never disagree: the daemon's environment, else the login
 * shell's, and nothing when the value is empty or carries the daemon's own token.
 */
export function resolveNamedVariable(
  name: string,
  sources: NamedVariableSources,
): { value: string; source: WorktreeClaimVariableSource } | null {
  const token = sources.daemonToken.trim();
  const daemon = Object.hasOwn(sources.daemonEnv, name) ? sources.daemonEnv[name] : undefined;
  const resolved = daemon
    ? { value: daemon, source: "daemon" as const }
    : Object.hasOwn(sources.loginShell, name) && sources.loginShell[name]
      ? { value: sources.loginShell[name]!, source: "loginShell" as const }
      : null;
  if (!resolved || resolved.value.includes("\0") || (token.length > 0 && resolved.value.includes(token))) return null;
  return resolved;
}
