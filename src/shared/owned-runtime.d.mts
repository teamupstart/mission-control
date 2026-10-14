export function resolveOwnedRuntime(context: {executable: string; kind: 'node' | 'electron'}): {command: string; env: Record<string, string>};
