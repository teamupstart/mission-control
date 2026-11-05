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

/**
 * The bundled scripts Mission Control registers in an operator's own agent configuration
 * (`~/.claude.json`, `~/.claude/settings.json` and Codex's `config.toml`), relative to the app
 * root. A `claude` or `codex` the operator starts runs them on this app's runtime, so they are
 * the processes Mission Control neither launches nor owns.
 *
 * The one list: the integration installer resolves these paths from it, the daemon's literal
 * `mcpServerPath` (kept literal so the bundle smoke can resolve it) is tested against it, and the
 * updater lets a running one survive a bundle swap (`waitForBundleExit` in
 * `scripts/mac-app-lifecycle.mjs`). That exemption is safe only because each is a single
 * self-contained bundle that imports nothing beside itself and never opens the state database,
 * which `test/operator-satellites.test.ts` checks against the real build. A script launched only
 * by dispatched sessions, such as `dist/satellites/codex-hook.mjs`, does not belong here.
 */
export const OPERATOR_SATELLITES = Object.freeze({
  mcpServer: 'dist/mcp/server.mjs',
  hook: 'dist/satellites/hook.mjs',
  statusline: 'dist/satellites/harness-statusline.mjs',
});
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
