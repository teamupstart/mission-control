// Compatibility facade for callers that need the daemon's executable PATH.
// The ownership, refresh, provenance, and cache contract lives in executables/locator.ts.

import {
  EXECUTABLE_REFRESH_COOLDOWN_MS,
  executableLocator,
  refreshExecutableEnvironment,
} from "../executables/locator.ts";

export const LOGIN_SHELL_PATH_REFRESH_COOLDOWN_MS = EXECUTABLE_REFRESH_COOLDOWN_MS;

/** Current resolved PATH. Entry points initialize the locator before launching children. */
export function loginShellPath(): string {
  return executableLocator.snapshot().path;
}

/** Refresh the one executable-environment snapshot without probing twice for concurrent callers. */
export async function refreshLoginShellPath(
  options: { force?: boolean } = {},
): Promise<string> {
  return (await refreshExecutableEnvironment(options)).path;
}
