import { fileURLToPath } from "node:url";
import type { SetupRuntimeView } from "@shared/setup-catalog.ts";
import type { OwnedRuntimeContext } from "@shared/owned-runtime.ts";

export function currentOwnedRuntime(): OwnedRuntimeContext {
  return { executable: process.execPath, kind: process.versions.electron ? "electron" : "node" };
}

/** Facts about the serving process, never the connected browser or an adopted shell. */
export function servingRuntime(facts: {
  executable: string; node: string; electron?: string; parentPort: boolean; modulePath: string;
} = {
  executable: process.execPath,
  node: process.versions.node,
  electron: process.versions.electron,
  parentPort: Boolean(process.parentPort),
  modulePath: fileURLToPath(import.meta.url),
}): SetupRuntimeView {
  // A utility process runs the nested Electron Helper.app executable, not the main
  // binary. Match the enclosing application's Resources, not just the nearest .app.
  const contents = [...facts.executable.matchAll(/\.app\/Contents\//g)]
    .map(match => facts.executable.slice(0, match.index! + ".app/Contents".length));
  const bundled = Boolean(facts.electron && facts.parentPort
    && contents.some(root => facts.modulePath.startsWith(`${root}/Resources/app/`)));
  return {
    origin: bundled ? "bundled" : facts.electron ? "electron-development" : "standalone",
    executable: facts.executable,
    node: facts.node,
    ...(facts.electron ? { electron: facts.electron } : {}),
  };
}
