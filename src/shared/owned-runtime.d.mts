export function resolveOwnedRuntime(context: {executable: string; kind: 'node' | 'electron'}): {command: string; env: Record<string, string>};
export function ownedScriptCommand(runtime: {command: string; env: Record<string, string>}, script: string, args?: string[]): string;
