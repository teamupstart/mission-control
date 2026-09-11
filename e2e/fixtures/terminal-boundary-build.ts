import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Build the production daemon entry with only OS/terminal boundaries scripted. */
export async function buildTerminalBoundaryDaemon(root: string, id: string): Promise<string> {
  // Same depth as index.mjs: runtime assets resolve relative to the daemon bundle.
  const outfile = join(root, "dist/server", `e2e-terminal-${id}.mjs`);
  const fixture = join(root, "e2e/fixtures/terminal-boundary.ts");
  await build({
    absWorkingDir: root, entryPoints: ["src/server/index.ts"], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22",
    mainFields: ["module", "main"], alias: { "@shared": "./src/shared" },
    banner: { js: "import{createRequire as __mcCreateRequire}from'node:module';const require=__mcCreateRequire(import.meta.url);" },
    plugins: [{ name: "terminal-boundary", setup(plugin) {
      plugin.onResolve({ filter: /^\.\/(processes|proc-cwd)\.ts$/ }, (args) =>
        args.importer === join(root, "src/server/discovery/correlate.ts") ? { path: fixture } : undefined,
      );
      plugin.onResolve({ filter: /^\.\/ghostty\.ts$/ }, (args) =>
        args.importer === join(root, "src/server/terminal/registry.ts") ? { path: fixture } : undefined,
      );
      plugin.onLoad({ filter: /src\/server\/terminal\/registry\.ts$/ }, (args) => ({
        loader: "ts",
        contents: `import { installTerminalBoundary } from ${JSON.stringify(fixture)};\n` +
          readFileSync(args.path, "utf8") + "\ninstallTerminalBoundary(defaultTerminalDeps);\n",
      }));
    } }],
  });
  return outfile;
}
