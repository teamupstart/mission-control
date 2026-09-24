import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { piExtensionPath } from "../src/server/config.ts";
import { piIntegrationManifest } from "../src/server/extensions/pi-artifact.ts";

/** Build the deployable directory without embedding source paths. No installed generation
 * points here: the publisher verifies and copies it before exposing it to Pi. */
export async function buildPiExtension(target?: string): Promise<void> {
  const output = piExtensionPath(target);
  if (!output.endsWith("/extension.js")) throw new Error("Pi integration output must be named extension.js");
  const dir = dirname(output);
  await mkdir(dir, { recursive: true });
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
    // Publish individual complete files, manifest last. A racing installer either sees a
    // verified generation or refuses the mixed snapshot; it never installs partial bytes.
    for (const name of ["extension.js", "mcp-server.mjs", "manifest.json"]) {
      await readFile(join(stage, name));
      await rename(join(stage, name), join(dir, name));
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPiExtension();
