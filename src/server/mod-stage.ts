import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { MOD_NAME as PLUGIN_NAME } from "../mod/constants.ts";

/** A state-home override must not register a pooled checkout, including through a symlink. */
export async function refuseCheckoutDestination(path: string): Promise<void> {
  const missing: string[] = [];
  let ancestor = resolve(path);
  while (true) {
    try { ancestor = join(await realpath(ancestor), ...missing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  while (true) {
    let checkout = false;
    try {
      const metadata = await stat(join(ancestor, ".git"));
      // An empty .git directory is not a checkout (some managed temp roots carry one).
      checkout = metadata.isFile() || (metadata.isDirectory() && (await lstat(join(ancestor, ".git/HEAD"))).isFile());
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (checkout) throw new Error("Refusing to register a mod stage inside a checkout. Set MISSION_HOME to a persistent state directory outside the checkout.");
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

/**
 * Stages the built mod folder marketplace at `{stateDir}/mod` (spec 7.10a).
 *
 * The build is written to a sibling folder and renamed into place; it is never copied onto the
 * published path. Rewriting files under a path a running Claude Code has open leaves it reading a
 * half-replaced mod, and the repository's rule for native addons (`scripts/native-addon-publish.mjs`)
 * applies for the same reason: a rename publishes a new inode and leaves the old one alone. When a
 * previous build is there it is renamed aside first and removed after the new one is in, and put
 * back if the swap fails, so a failed publish leaves the old mod where it was. The one exception is
 * a swap that fails and then also fails to put the old mod back: the published path is then empty,
 * the thrown error says so and names the kept backup folder, and the person moves it back by hand.
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

/**
 * The folder marketplace's manifest, read and checked rather than only found: `claude plugin
 * marketplace add` rejects one that is unreadable or does not list the mod, and by then the
 * published mod would already have been replaced.
 */
async function assertMarketplace(root: string): Promise<void> {
  const file = join(root, ".claude-plugin", "marketplace.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(root + " has a marketplace.json that is missing or not valid JSON; run `npm run build:mod`");
  }
  const m = manifest as { name?: unknown; plugins?: unknown } | null;
  const lists = Array.isArray(m?.plugins) && m.plugins.some((p) => typeof p === "object" && p !== null && (p as { name?: unknown }).name === PLUGIN_NAME);
  if (typeof m !== "object" || m === null || m.name !== PLUGIN_NAME || !lists) {
    throw new Error(root + " has a marketplace.json that is not the " + PLUGIN_NAME + " marketplace listing the " + PLUGIN_NAME + " plugin; run `npm run build:mod`");
  }
}

async function assertBuild(source: string): Promise<void> {
  for (const file of [join(".claude-plugin", "marketplace.json"), join(PLUGIN_NAME, ".claude-plugin", "plugin.json"), join(PLUGIN_NAME, "hooks", "register.js")]) {
    try {
      if (!(await stat(join(source, file))).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(source + " is not a mod build (missing " + file + "); run `npm run build:mod`");
    }
  }
  await assertMarketplace(source);
}

/** Whether a process with this id is running (and so may be mid-stage). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes staging copies and backups that an earlier run left beside `dest` (it was killed between
 * the publish and its cleanup, or its cleanup failed). A sibling whose process is still running is
 * left alone. A `.old-` backup is removed only while a published mod exists: when `dest` is missing,
 * the backup may be the only copy of the working mod, and an earlier error named it for restoring by hand.
 */
async function sweepStaleSiblings(dest: string): Promise<void> {
  const parent = dirname(dest);
  const name = basename(dest);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch {
    return;
  }
  const published = await stat(dest).then((s) => s.isDirectory(), () => false);
  for (const entry of entries) {
    const match = new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.(staging|old)-(\\d+)-[0-9a-f]+$").exec(entry);
    if (!match) continue;
    const pid = Number(match[2]);
    if (pid !== process.pid && isRunning(pid)) continue;
    if (match[1] === "old" && !published) continue;
    await rm(join(parent, entry), { recursive: true, force: true }).catch(() => undefined);
  }
}

interface StageOptions {
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
  /** How long to wait for another run that is staging the same mod, in ms. Default 30 s. */
  lockTimeoutMs?: number;
}

async function stageModLocked(options: StageOptions): Promise<StagedMod> {
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
  await sweepStaleSiblings(dest);
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

/** A lock this old is taken to be left by a run that hung or was killed, whatever its process id says. */
const LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * Takes the lock that serializes stagers of one `dest`: a `{dest}.lock` folder, created atomically.
 * Without it two overlapping runs could each rename the other's freshly published build aside as
 * its own backup and then delete it. A lock whose owner is gone (or is very old) is taken over; one
 * whose owner is running is waited for, then reported, so the person is told rather than left
 * with a mod one run silently removed.
 */
async function acquireLock(dest: string, timeoutMs: number): Promise<() => Promise<void>> {
  const lock = dest + ".lock";
  const owner = join(lock, "owner");
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(dest), { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(owner, String(process.pid));
      return () => rm(lock, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let pid = NaN;
    let age = 0;
    try {
      pid = Number((await readFile(owner, "utf8")).trim());
      age = Date.now() - (await stat(owner)).mtimeMs;
    } catch {
      // No owner file yet: the holder is between creating the folder and writing it. Judge by the folder's age.
      age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
    }
    const dead = Number.isInteger(pid) && pid > 0 ? !isRunning(pid) : age > 5000;
    if (dead || age > LOCK_STALE_MS) {
      await rm(lock, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("another mctl setup (process " + (Number.isInteger(pid) ? pid : "unknown") + ") is staging the mod; wait for it to finish, then run `mctl setup` again");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function stageMod(options: StageOptions): Promise<StagedMod> {
  await refuseCheckoutDestination(options.dest);
  const release = await acquireLock(options.dest, options.lockTimeoutMs ?? 30_000);
  try {
    return await stageModLocked(options);
  } finally {
    await release();
  }
}
