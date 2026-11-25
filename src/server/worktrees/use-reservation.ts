import { pathContains } from "./occupancy.ts";
import { canonicalWorktreePath } from "./path.ts";

const using = new Set<string[]>();
const cleaning = new Set<string[]>();
const listeners = new Set<(paths: readonly string[]) => void>();

export function worktreePathsOverlap(first: readonly string[], second: readonly string[]): boolean {
  return first.some((a) => second.some((b) => pathContains(a, b) || pathContains(b, a)));
}

export function worktreeUseReserved(paths: readonly string[]): boolean {
  return [...using].some((entry) => worktreePathsOverlap(entry, paths));
}

export function worktreeCleanupReserved(paths: readonly string[]): boolean {
  const canonical = paths.map(canonicalWorktreePath);
  return [...cleaning].some((entry) => worktreePathsOverlap(entry, canonical));
}

export function onWorktreeUse(listener: (paths: readonly string[]) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function noteWorktreeUse(paths: readonly string[]): void {
  if (!listeners.size || !paths.length) return;
  const canonical = paths.map(canonicalWorktreePath);
  for (const listener of listeners) listener(canonical);
}

/** Admission is synchronous, before either side awaits an external provider. */
export function reserveWorktreeUse(paths: readonly string[]): Disposable | null {
  const canonical = paths.map(canonicalWorktreePath);
  if (worktreeCleanupReserved(canonical)) return null;
  noteWorktreeUse(canonical);
  using.add(canonical);
  return { [Symbol.dispose]: () => { using.delete(canonical); } };
}

export function reserveWorktreeCleanup(paths: readonly string[]): Disposable | null {
  const canonical = paths.map(canonicalWorktreePath);
  if (worktreeUseReserved(canonical) || worktreeCleanupReserved(canonical)) return null;
  cleaning.add(canonical);
  return { [Symbol.dispose]: () => { cleaning.delete(canonical); } };
}
