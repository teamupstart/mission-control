import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Stages the built mod folder marketplace at `{stateDir}/mod` (spec 7.10a).
 *
 * The build is written to a sibling folder and renamed into place; it is never copied onto the
 * published path. Rewriting files under a path a running Claude Code has open leaves it reading a
 * half-replaced mod, and the repository's rule for native addons (`scripts/native-addon-publish.mjs`)
 * applies for the same reason: a rename publishes a new inode and leaves the old one alone. When a
 * previous build is there it is renamed aside first and removed after the new one is in, and put
 * back if the swap fails, so a failed stage never leaves the path empty.
 */

const PLUGIN_NAME = "mission-control";

export interface StagedMod {
  /** The folder marketplace root, `dest`. */
  dest: string;
  /** The plugin folder inside it. */
  pluginDir: string;
  /** The `version` in the staged `plugin.json`. */
  version: string;
}

/** The version in a mod build's `plugin.json`, or throws when the folder is not a mod build. */
export async function readModVersion(root: string): Promise<string> {
  const raw = await readFile(join(root, PLUGIN_NAME, ".claude-plugin", "plugin.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") throw new Error(root + " has a plugin.json with no version");
  return parsed.version;
}

async function assertBuild(source: string): Promise<void> {
  for (const file of [join(".claude-plugin", "marketplace.json"), join(PLUGIN_NAME, ".claude-plugin", "plugin.json"), join(PLUGIN_NAME, "hooks", "register.js")]) {
    try {
      if (!(await stat(join(source, file))).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(source + " is not a mod build (missing " + file + "); run `npm run build:mod`");
    }
  }
}

export async function stageMod(options: {
  source: string;
  dest: string;
  /** The rename used to publish; a test injects one that fails part way through the swap. */
  rename?: typeof rename;
}): Promise<StagedMod> {
  const { source, dest } = options;
  const move = options.rename ?? rename;
  await assertBuild(source);
  const suffix = process.pid + "-" + randomBytes(4).toString("hex");
  const staging = dest + ".staging-" + suffix;
  const previous = dest + ".old-" + suffix;
  await mkdir(dirname(dest), { recursive: true });
  try {
    await cp(source, staging, { recursive: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  let movedAside = false;
  try {
    try {
      await move(dest, previous);
      movedAside = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await move(staging, dest);
  } catch (error) {
    if (movedAside) await move(previous, dest).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (movedAside) await rm(previous, { recursive: true, force: true });
  return { dest, pluginDir: join(dest, PLUGIN_NAME), version: await readModVersion(dest) };
}
