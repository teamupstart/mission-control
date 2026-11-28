import { build as bundle } from "esbuild";
import { build as buildWeb } from "vite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../test/temp-root.mjs";

/** Real daemon and dashboard, with only registry data substituted. No product test hook. */
export async function buildFeatureFlags() {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const webDir = tempDir("mission-flags-panel-");
  const daemonBundle = join(root, "dist/server", `e2e-flags-${process.pid}-${Date.now()}.mjs`);
  const fixture = join(root, "e2e/fixtures/feature-flag-registry.ts");
  const cleanup = () => {
    rmSync(webDir, { recursive: true, force: true });
    rmSync(daemonBundle, { force: true });
  };
  const nodeEnv = process.env.NODE_ENV;
  try {
    await bundle({
      absWorkingDir: root, entryPoints: ["src/server/index.ts"], outfile: daemonBundle,
      bundle: true, platform: "node", format: "esm", target: "node22",
      mainFields: ["module", "main"], alias: { "@shared": "./src/shared" },
      banner: { js: "import{createRequire as __mcCreateRequire}from'node:module';const require=__mcCreateRequire(import.meta.url);" },
      plugins: [{ name: "feature-flag-registry", setup(plugin) {
        plugin.onResolve({ filter: /\/feature-flag-registry\.ts$/ }, () => ({ path: fixture }));
      } }],
    });
    await buildWeb({ configFile: join(root, "vite.config.ts"), logLevel: "error",
      build: { outDir: webDir, emptyOutDir: true },
      plugins: [{ name: "feature-flag-registry", enforce: "pre", transform(source, id) {
        if (id === join(root, "src/shared/feature-flag-registry.ts")) {
          // Every export, not a named list: the substitute keeps the shipped registry's `<FLAG>_ID`
          // constants (docs/feature-flags.md), and a dashboard gate that imports one must still build.
          return `export * from ${JSON.stringify(fixture)};`;
        }
      } }],
    });
    return { webDir, daemonBundle, cleanup };
  } catch (error) { cleanup(); throw error; }
  finally {
    // Vite sets NODE_ENV globally. Playwright reuses this worker for dev-server specs.
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
}
