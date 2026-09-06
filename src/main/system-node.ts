import { locateExecutableSync } from "../server/executables/locator.ts";

/** Resolve a system Node binary that remains available while Electron replaces itself. */
export function findSystemNode(): string | null {
  return locateExecutableSync("node")?.path ?? null;
}
