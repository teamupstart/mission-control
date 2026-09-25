import { build } from "esbuild";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { piExtensionPath } from "../src/server/config.ts";
import { PI_INTEGRATION_FILES, piIntegrationManifest, verifyPiIntegration } from "../src/server/extensions/pi-artifact.ts";
import { acquireHelperLock, realHelperLockOperations, releaseHelperLock } from "./update-lock.mjs";

async function publishBuild(stage: string, dir: string): Promise<void> {
  const expected = verifyPiIntegration(stage);
  const lockDir = join(dirname(dir), `.${basename(dir)}-build.lock.d`);
  const ops = realHelperLockOperations();
  for (let attempt = 0; attempt < 400; attempt++) {
    const lock = acquireHelperLock(lockDir, ops);
    if (!lock.ok || !lock.entryName) { await setTimeout(25); continue; }
    try {
      // No await while holding the process claim: same-process callers cannot share
      // a claim name or interleave writes. Other processes wait for its release.
      for (const name of PI_INTEGRATION_FILES) renameSync(join(stage, name), join(dir, name));
      if (verifyPiIntegration(dir).buildId !== expected.buildId) throw new Error("Pi integration changed during build publication");
      return;
    } finally { releaseHelperLock(lockDir, lock.entryName, ops); }
  }
  throw new Error("Another Pi integration build is publishing. Retry the build.");
}

/** Build the deployable directory without embedding source paths. No installed generation
 * points here: the publisher verifies and copies it before exposing it to Pi. */
export async function buildPiExtension(target?: string): Promise<void> {
  const output = piExtensionPath(target);
  if (!output.endsWith("/extension.js")) throw new Error("Pi integration output must be named extension.js");
  await mkdir(dirname(output), { recursive: true });
  const dir = await realpath(dirname(output));
  const stage = await mkdtemp(join(dirname(dir), ".pi-integration-build-"));
  try {
    const options = { absWorkingDir: process.cwd(), bundle: true, platform: "node" as const,
      format: "esm" as const, target: "node22", alias: { "@shared": "./src/shared" },
      mainFields: ["module", "main"], write: false as const };
    const extension = await build({ ...options, entryPoints: ["src/pi/extension.ts"],
      define: { __MISSION_PI_PACKAGED__: "true" }, outfile: join(stage, "extension.js") });
    const bridge = await build({ ...options, entryPoints: ["src/mcp/server.ts"], outfile: join(stage, "mcp-server.mjs") });
    const extensionBytes = extension.outputFiles[0]!.contents;
    const bridgeBytes = bridge.outputFiles[0]!.contents;
    await writeFile(join(stage, "extension.js"), extensionBytes);
    await writeFile(join(stage, "mcp-server.mjs"), bridgeBytes);
    await writeFile(join(stage, "manifest.json"), JSON.stringify(piIntegrationManifest(extensionBytes, bridgeBytes), null, 2) + "\n");
    // Readers can refuse an in-flight snapshot; concurrent builders cannot interleave
    // artifact sets or report success without a verified final destination.
    await publishBuild(stage, dir);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPiExtension();
