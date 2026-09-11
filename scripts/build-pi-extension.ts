import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpServerPath, piExtensionPath } from "../src/server/config.ts";

/** Build privately, then publish one complete file on the destination filesystem. A
 * failed or concurrent build must never expose partial JS to machine-wide Pi discovery. */
export async function buildPiExtension(target?: string): Promise<void> {
  const output = piExtensionPath(target);
  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(join(dirname(output), ".pi-extension-build-"));
  try {
    const staged = join(stage, "index.js");
    const options = {
      absWorkingDir: process.cwd(), entryPoints: ["src/pi/extension.ts"], bundle: true, platform: "node" as const,
      format: "esm" as const, target: "node22", alias: { "@shared": "./src/shared" },
      define: { __MISSION_MCP_SERVER__: JSON.stringify(resolve(mcpServerPath())), __MISSION_PI_BUILD__: JSON.stringify("build-marker") },
      outfile: staged,
    };
    const result = await build({ ...options, write: false });
    const hash = createHash("sha256").update(result.outputFiles![0]!.contents).digest("hex");
    await build({ ...options, define: { ...options.define, __MISSION_PI_BUILD__: JSON.stringify(hash) } });
    // Read before publish so a failed/missing output leaves the previous installation intact.
    await readFile(staged);
    await rename(staged, output);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPiExtension();
