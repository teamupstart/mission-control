// Pure policy for Mission-owned scripts only. Never substitute this for user commands.
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
