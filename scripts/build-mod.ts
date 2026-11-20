// Builds the Claude Code mod into `dist/mod/mission-control/` and writes the folder marketplace
// beside it (spec 7.10, 7.10a). Run through `npm run build:mod`, which `npm run build` includes.
//
//   dist/mod/.claude-plugin/marketplace.json      lists the plugin with a relative `source`
//   dist/mod/mission-control/.claude-plugin/plugin.json
//   dist/mod/mission-control/hooks/hooks.json     names ./register.js
//   dist/mod/mission-control/hooks/register.js    the bundled hooks module
//   dist/mod/mission-control/types/index.d.ts     the `$.state` contract, named in plugin.json
//
// This script only builds under `dist/`. Staging into `{stateDir}/mod/` and installing are P14's.
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MOD_API, MOD_NAME } from "../src/mod/constants.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The real path of `path`, resolving symlinks in its nearest existing ancestor. */
function realPathOfNearest(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...missing);
}

/**
 * The build replaces its output directory wholesale, so an override must name somewhere this
 * script may delete: strictly inside `dist/` or the temp directory, judged after symlinks are
 * resolved (the same shape of check as `openDb`'s test-home guard). `MISSION_MOD_OUT_DIR` lets a
 * test build into a temporary directory instead of `dist/mod`.
 */
function resolveOutRoot(): string {
  const override = process.env.MISSION_MOD_OUT_DIR;
  if (!override) return join(root, "dist", "mod");
  const target = realPathOfNearest(override);
  const strictlyInside = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const checkout = realPathOfNearest(root);
  const dist = realPathOfNearest(join(root, "dist"));
  // Under dist/ is always fine. Under the temp directory is fine too, unless that would delete
  // the checkout (the target is the checkout or one of its ancestors) or a path inside it that is
  // not under dist/, which matters when the checkout itself lives under the temp directory.
  const underDist = strictlyInside(dist, target);
  const underTmp = strictlyInside(realPathOfNearest(tmpdir()), target);
  const touchesCheckout = target === checkout || strictlyInside(target, checkout) || strictlyInside(checkout, target);
  if (!(underDist || (underTmp && !touchesCheckout))) {
    throw new Error(`MISSION_MOD_OUT_DIR ${override} resolves to ${target}, which is not inside dist/ or a temp directory outside the checkout; refusing to replace it`);
  }
  // The checked path is the one acted on: a symlinked override would otherwise be unlinked, not replaced.
  return target;
}
const outRoot = resolveOutRoot();
const pluginDir = join(outRoot, MOD_NAME);
const DESCRIPTION = "Mission Control inside Claude Code: dispatch, the Mission Control pane and attention.";

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };

// A build is a whole replacement: never leave a file from an older layout behind.
await rm(outRoot, { recursive: true, force: true });
await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
await mkdir(join(pluginDir, "hooks"), { recursive: true });
await mkdir(join(pluginDir, "types"), { recursive: true });
await mkdir(join(outRoot, ".claude-plugin"), { recursive: true });

await build({
  entryPoints: [join(root, "src/mod/register.ts")],
  outfile: join(pluginDir, "hooks", "register.js"),
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2023",
  mainFields: ["module", "main"],
  alias: { "@shared": join(root, "src/shared") },
  logLevel: "warning",
});

await cp(join(root, "src/mod/types/index.d.ts"), join(pluginDir, "types", "index.d.ts"));
await writeFile(join(pluginDir, "hooks", "hooks.json"), `${JSON.stringify({ modules: ["./register.js"] }, null, 2)}\n`);
await writeFile(
  join(pluginDir, ".claude-plugin", "plugin.json"),
  `${JSON.stringify(
    {
      name: MOD_NAME,
      version: pkg.version,
      description: DESCRIPTION,
      author: { name: "Mission Control" },
      modApi: MOD_API,
      // Relative to the plugin root, not to .claude-plugin/: `claude plugin validate` requires a "./"
      // prefix and rejects "..", so "../types/index.d.ts" is invalid.
      types: "./types/index.d.ts",
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  join(outRoot, ".claude-plugin", "marketplace.json"),
  `${JSON.stringify(
    {
      name: MOD_NAME,
      owner: { name: "Mission Control" },
      plugins: [{ name: MOD_NAME, source: `./${MOD_NAME}`, description: DESCRIPTION, version: pkg.version }],
    },
    null,
    2,
  )}\n`,
);

console.log(`[build:mod] wrote ${pluginDir} (version ${pkg.version}, modApi ${MOD_API})`);
