import { randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MOD_NAME as PLUGIN_NAME } from "../mod/constants.ts";

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
  let parsed: { version?: unknown };
  try {
    parsed = JSON.parse(raw) as { version?: unknown };
  } catch {
    throw new Error(root + " has a plugin.json that is not valid JSON");
  }
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
  /** The copy into the staging folder; a test injects one whose result differs from the source. */
  copy?: typeof cp;
  /**
   * Run on the copy before anything is renamed. A rejection refuses the build and leaves the
   * published mod as it was, so a build that setup's own checks reject never displaces a working one.
   */
  validate?: (stagingDir: string) => Promise<void>;
}): Promise<StagedMod> {
  const { source, dest } = options;
  const move = options.rename ?? rename;
  const copy = options.copy ?? cp;
  // A source that is not a usable build is refused before anything is copied.
  await assertBuild(source);
  await readModVersion(source);
  const suffix = process.pid + "-" + randomBytes(4).toString("hex");
  const staging = dest + ".staging-" + suffix;
  const previous = dest + ".old-" + suffix;
  await mkdir(dirname(dest), { recursive: true });
  // What gets published is what was copied, so it is the copy that is validated, not the source
  // read a moment earlier: the source may have changed while it was being copied.
  let version: string;
  try {
    await copy(source, staging, { recursive: true });
    await assertBuild(staging);
    version = await readModVersion(staging);
    await options.validate?.(staging);
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
    // Put the old mod back first: the published path must not stay empty because tidying failed.
    if (movedAside) {
      try {
        await move(previous, dest);
      } catch (restoreError) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        // The published path is now empty. Say so, and leave the old build where it is.
        throw new Error(
          "publishing the new mod failed (" + describeError(error) + ") and putting the previous mod back failed too (" + describeError(restoreError) + "); the previous build is at " + previous + " and must be moved back to " + dest + " by hand",
        );
      }
    }
    // Removing the staging copy is best effort; it must not mask the publish error.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  // The new mod is live. A backup folder that cannot be removed is not a reason to report the
  // publish as failed, and the caller must still go on to install what was published.
  if (movedAside) await rm(previous, { recursive: true, force: true }).catch(() => undefined);
  return { dest, pluginDir: join(dest, PLUGIN_NAME), version };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
