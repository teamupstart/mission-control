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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MOD_API, MOD_NAME } from "../src/mod/constants.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `MISSION_MOD_OUT_DIR` lets a test build into a temporary directory instead of `dist/mod`.
const outRoot = process.env.MISSION_MOD_OUT_DIR ? resolve(process.env.MISSION_MOD_OUT_DIR) : join(root, "dist", "mod");
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
