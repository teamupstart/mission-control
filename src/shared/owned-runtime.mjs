// Pure policy for Mission-owned scripts only. Never substitute this for user commands.

/**
 * The first line of the workflow-check supervisor shim (`src/server/workflows/check-spawn.ts`).
 *
 * The shim runs under this owned runtime, which in a packaged app is an executable INSIDE the
 * app bundle, and it lives in its own detached process group. One that outlives its daemon
 * therefore keeps the bundle busy, and the update helper's bundle-exit wait has to be able to
 * say so. The helper reads a lingering process's command line only to test for this marker -
 * it never prints a command line - so the outcome a person reads can name the cause.
 */
export const CHECK_SUPERVISOR_MARKER = 'mission-control:workflow-check-supervisor';
export function resolveOwnedRuntime({executable, kind}) {
  if (typeof executable !== 'string' || (!executable.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(executable)) || !['node', 'electron'].includes(kind)) throw new Error('An absolute owned runtime and explicit context are required');
  return {command: executable, env: kind === 'electron' ? {ELECTRON_RUN_AS_NODE: '1'} : {}};
}

/** Shell spelling only for our scripts. Keep the Node-mode flag on this invocation. */
export function ownedScriptCommand(runtime, script, args = []) {
  const quote = (value) => `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
  return [...Object.entries(runtime.env).map(([key, value]) => `${key}=${quote(value)}`),
    ...[runtime.command, script, ...args].map(quote)].join(' ');
}
