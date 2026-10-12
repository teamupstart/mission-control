import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  nativeStateLockAddonPath,
  validateNativeStateLockBinding,
} from "../../src/server/state-ownership-native.ts";
import { validateNativeSymlinkPublicationBinding } from "../../src/server/symlink-publication.ts";
import { validateNativePlanFilesBinding } from "../../src/server/plans/native.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Provision the native state lock addon a spawned daemon loads during startup.
 *
 * `src/server/index.ts` calls `acquireStateOwnership()` before it serves anything, so a test
 * that spawns the real daemon needs `dist/native/state-lock.node` on disk or the child exits
 * with `MODULE_NOT_FOUND` before printing a diagnostic of its own. `npm test` builds it once in
 * `pretest`, so a warm suite compiles nothing. A single-file run does not execute npm's
 * lifecycle, so each spec that spawns a daemon calls this and gets the artifact on its own -
 * and on a cold checkout several of them will, at once, which the build script is built to
 * survive.
 *
 * The load decides whether to build rather than a path check: a missing addon, one truncated by
 * an interrupted build, and one compiled against another Node release all fail here, and all
 * three are repaired by the same rebuild. Building unconditionally instead would charge every
 * warm single-file run for a compile it does not need.
 */
export function ensureNativeStateLockAddon(): string {
  const addon = nativeStateLockAddonPath();
  try {
    // dlopen can retain an old addon's exports even after require.cache is cleared.
    // Probe in a child so an upgrade is rebuilt before this worker ever loads it.
    const validators = [
      ["../../src/server/state-ownership-native.ts", "validateNativeStateLockBinding"],
      ["../../src/server/symlink-publication.ts", "validateNativeSymlinkPublicationBinding"],
      ["../../src/server/plans/native.ts", "validateNativePlanFilesBinding"],
    ];
    const probe = 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
      + validators.map(([module, name]) => `import { ${name} } from ${JSON.stringify(new URL(module!, import.meta.url).href)}; ${name}(require(${JSON.stringify(addon)}));`).join("\n");
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", probe], { cwd: REPO_ROOT, stdio: "pipe" });
  } catch {
    delete require.cache[addon];
    execFileSync(process.execPath, ["scripts/build-state-lock-native.mjs"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
  }
  validateNativeStateLockBinding(require(addon));
  validateNativeSymlinkPublicationBinding(require(addon));
  validateNativePlanFilesBinding(require(addon));
  return addon;
}
