export interface ModCallsAllowlist {
  exact: string[];
  prefixes: string[];
}
export function isAllowedModCall(path: string, allowed: ModCallsAllowlist): boolean;
export function findDisallowedModCalls(root: string): { file: string; path: string }[];
