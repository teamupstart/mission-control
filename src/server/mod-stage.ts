import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { MOD_API, MOD_NAME } from "../mod/constants.ts";

const ManifestSchema = z.object({ name: z.literal(MOD_NAME), version: z.string().min(1), modApi: z.literal(MOD_API) });
const MarketplaceSchema = z.object({ name: z.literal(MOD_NAME), plugins: z.array(z.object({
  name: z.literal(MOD_NAME), source: z.literal(`./${MOD_NAME}`), version: z.string(),
})).length(1) });

/** A state-home override must not register a pooled checkout, including through a symlink. */
async function refuseCheckoutDestination(path: string): Promise<void> {
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

export async function stagedModVersion(root: string): Promise<string> {
  return ManifestSchema.parse(JSON.parse(await readFile(join(root, MOD_NAME, ".claude-plugin/plugin.json"), "utf8"))).version;
}

async function marketplaceVersion(root: string): Promise<string> {
  const version = await stagedModVersion(root);
  const marketplace = MarketplaceSchema.parse(JSON.parse(await readFile(join(root, ".claude-plugin/marketplace.json"), "utf8")));
  if (marketplace.plugins[0]!.version !== version) throw new Error("Mod and marketplace versions differ; rebuild the mod");
  return version;
}

/** Reject symlinks and hash paths as well as bytes, so an unchanged setup rewrites no files. */
async function digest(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(relative: string): Promise<void> {
    for (const entry of (await readdir(join(root, relative))).sort()) {
      const name = join(relative, entry);
      const stat = await lstat(join(root, name));
      if (stat.isSymbolicLink()) throw new Error(`Mod contains a symlink: ${name}`);
      hash.update(JSON.stringify([name, stat.isDirectory() ? "dir" : "file"]));
      if (stat.isDirectory()) await walk(name);
      else if (stat.isFile()) hash.update(await readFile(join(root, name)));
      else throw new Error(`Mod contains an unsupported file: ${name}`);
    }
  }
  await walk("");
  return hash.digest("hex");
}

/** Publish a complete folder marketplace; rollback on rename failure, never overwrite live files. */
export async function stageMod(source: string, stateHome: string): Promise<{ root: string; version: string; changed: boolean }> {
  const root = resolve(stateHome, "mod");
  if (resolve(source) === resolve(root)) throw new Error("The built mod and staged mod must be separate directories");
  await refuseCheckoutDestination(root);
  const expected = await digest(source);
  await mkdir(stateHome, { recursive: true });
  const lock = join(stateHome, ".mod-stage-lock");
  await mkdir(lock); // Concurrent setup must not interleave the two directory renames.
  let scratch: string | undefined;
  try {
    try {
      if (await digest(root) === expected) return { root, version: await marketplaceVersion(root), changed: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    scratch = await mkdtemp(join(stateHome, ".mod-stage-"));
    const candidate = join(scratch, "new");
    const previous = join(scratch, "previous");
    await cp(source, candidate, { recursive: true, dereference: false });
    if (await digest(candidate) !== expected) throw new Error("Built mod changed during staging; retry setup");
    const version = await marketplaceVersion(candidate);
    let moved = false;
    try { await rename(root, previous); moved = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(candidate, root); }
    catch (error) {
      if (moved) await rename(previous, root);
      throw error;
    }
    return { root, version, changed: true };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
