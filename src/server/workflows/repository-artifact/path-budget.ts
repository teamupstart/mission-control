import { MAX_REPOSITORY_VIEW_ENTRIES } from "@shared/repository-access.ts";

export const treeExpansionLimit = { entries: MAX_REPOSITORY_VIEW_ENTRIES, pathBytes: 64 * 1024 * 1024 };
export type PathBudget = typeof treeExpansionLimit;

export function expansionBudget(limits: Partial<PathBudget> = {}): PathBudget {
  return {
    entries: Math.min(limits.entries ?? treeExpansionLimit.entries, treeExpansionLimit.entries),
    pathBytes: Math.min(limits.pathBytes ?? treeExpansionLimit.pathBytes, treeExpansionLimit.pathBytes),
  };
}

export function chargePath(budget: PathBudget, pathBytes: number) {
  if (budget.entries >= 1 && budget.pathBytes >= pathBytes) {
    budget.entries--;
    budget.pathBytes -= pathBytes;
    return true;
  }
  return false;
}

export function expansionExceeded(): never {
  throw Object.assign(new Error("Required Git tree exceeds path expansion limit"), { code: "tree_expansion_limit" });
}
