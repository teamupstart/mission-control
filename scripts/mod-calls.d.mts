export interface ModCallsAllowlist {
  exact: string[];
  prefixes: string[];
}
export function isAllowedModCall(path: string, allowed: ModCallsAllowlist): boolean;
export function pathLiterals(source: string, fileName?: string): string[];
export function findDisallowedModCalls(root: string): { file: string; path: string }[];
