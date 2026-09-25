import { lstatSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { removeIdlePiGeneration, removeRetiredPiGenerations, writePiGenerationFile } from "../../pi/generation-lease.ts";
import { piGenerationPath, piIntegrationRoot } from "./pi-paths.ts";

/** Bound idle storage to current + one prior publication + one damaged backup.
 * Live process leases are additional roots. Unknown entries and symlinks are untouched.
 * Runs only after a successful link/intent commit while the publication lock is held. */
export function prunePiGenerations(currentBuildId: string): void {
  const root = piIntegrationRoot();
  writePiGenerationFile(join(piGenerationPath(currentBuildId), ".published"), "");
  removeRetiredPiGenerations(root);
  const directories = readdirSync(root).filter(name => lstatSync(join(root, name)).isDirectory());
  const prior = directories.filter(name => /^[a-f0-9]{64}$/.test(name) && name !== currentBuildId)
    .map(name => ({ name, published: lstatSync(join(root, name, ".published"), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => b.published - a.published || a.name.localeCompare(b.name));
  for (const { name } of prior.slice(1)) removeIdlePiGeneration(piGenerationPath(name));
  const damaged = directories.filter(name => name.startsWith(".damaged-"))
    .sort((a, b) => lstatSync(join(root, b)).mtimeMs - lstatSync(join(root, a)).mtimeMs);
  for (const [index, name] of damaged.entries()) {
    const directory = join(root, name);
    removeRetiredPiGenerations(directory);
    const contents = readdirSync(directory);
    if (contents.length === 0 || (index > 0 && contents.length === 1 && /^[a-f0-9]{64}$/.test(contents[0]!)
      && removeIdlePiGeneration(join(directory, contents[0]!)))) rmdirSync(directory);
  }
}
