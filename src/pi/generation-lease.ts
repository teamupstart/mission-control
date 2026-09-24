import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { claimIsLive, processIdentity, processIsAlive } from "../../scripts/update-lock.mjs";

const LEASES = ".leases";
const RETIRING = ".retiring";
const leaseKey = Symbol.for("mission-control.pi-generation-leases");
const owner = process as typeof process & { [leaseKey]?: Map<string, string> };

/** Generation bookkeeping never follows a replaced marker or lease into another file. */
export function writePiGenerationFile(path: string, contents: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, contents); }
  finally { closeSync(fd); }
}

// A Pi process may change its title, so only compare its start time, not its argv.
// A same-second PID reuse conservatively retains a generation until the replacement exits.
const identity = (pid: number) => processIdentity(pid, target => execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(target)], {
  encoding: "utf8", timeout: 1000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"],
}));

/** Pin the canonical generation for the whole Pi process, including session switches.
 * No timer or daemon connection is needed; killed processes are reclaimed by identity. */
export function holdPiGeneration(directory: string, buildId: string): void {
  if (basename(directory) !== buildId) return; // Source and copied preflight bundles are not generations.
  // Pi can load the extension for multiple sessions in one process. One unique
  // claim per generation suffices, without reusing a dead process's mutable name.
  const held = owner[leaseKey] ??= new Map();
  const existing = held.get(directory);
  if (existing && existsSync(existing)) return;
  const leases = join(directory, LEASES);
  const retiring = join(directory, RETIRING);
  if (existsSync(retiring)) throw new Error("Pi integration generation is being retired");
  try { mkdirSync(leases, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!lstatSync(leases).isDirectory()) throw new Error("Pi generation leases must be a directory");
  const path = join(leases, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ pid: process.pid, identity: identity(process.pid) }), { flag: "wx", mode: 0o600 });
  // A collector marks before scanning. Either it sees our lease, or we refuse to
  // start using a generation it has claimed. Never recreate a deleted generation.
  if (existsSync(retiring) || !existsSync(path)) {
    rmSync(path, { force: true });
    throw new Error("Pi integration generation is being retired");
  }
  held.set(directory, path);
  process.once("exit", () => { try { rmSync(path, { force: true }); } catch { /* Reclaimed on next publication. */ } });
}

function hasLiveLease(directory: string): boolean {
  const leases = join(directory, LEASES);
  const entry = lstatSync(leases, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isDirectory()) return true;
  for (const name of readdirSync(leases)) {
    const path = join(leases, name);
    const pid = Number(/^(\d+)-[a-f0-9-]+\.json$/.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) return true;
    try {
      if (!lstatSync(path).isFile()) return true;
      // The filename identifies even a process killed halfway through writing its lease.
      if (!processIsAlive(pid)) { rmSync(path, { force: true }); continue; }
      const record = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; identity?: unknown };
      if (record.pid !== pid
        || (record.identity !== null && typeof record.identity !== "string")) return true;
      if (claimIsLive({ pid, identity: record.identity as string | null }, { identity })) return true;
      rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

/** Called only by the serialized publisher. Unknown leases fail closed. */
export function removeIdlePiGeneration(directory: string): boolean {
  if (!lstatSync(directory).isDirectory() || hasLiveLease(directory)) return false;
  const retiring = join(directory, RETIRING);
  writePiGenerationFile(retiring, "");
  try {
    if (hasLiveLease(directory)) return false;
    rmSync(directory, { recursive: true });
    return true;
  } finally { rmSync(retiring, { force: true }); }
}
