import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../../test/temp-root.mjs";

/** One immutable web build per invocation, shared by its isolated daemon fixtures. */
export function snapshotWebBuild(source: string): {directory: string; dispose(): void} {
  if (!existsSync(join(source, "index.html"))) throw new Error("Build the dashboard before running E2E tests.");
  const directory = tempDir("mission-e2e-web-");
  try {
    cpSync(source, directory, {recursive: true});
    return {directory, dispose: () => rmSync(directory, {recursive: true, force: true})};
  } catch (error) {
    rmSync(directory, {recursive: true, force: true});
    throw error;
  }
}
