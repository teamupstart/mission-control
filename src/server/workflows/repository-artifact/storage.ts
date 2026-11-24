import { existsSync, statfsSync } from "node:fs";
import { lstat, mkdir, opendir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Measure surviving payloads, including partial writes, without reading file contents. */
async function payloadBytes(path: string, depth: number): Promise<number> {
  const stat = await lstat(path).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  if (depth === 0) throw Object.assign(new Error("Unexpected artifact directory"), { code: "artifact_layout" });
  let total = 0;
  for await (const entry of await opendir(path)) total += await payloadBytes(join(path, entry.name), depth - 1);
  return total;
}

/** Shared by all pending candidates and reader leases in this state root. */
export class RepositoryArtifactStorage {
  private readonly accounts = new Map<string, { required: number; total: number; displaced: number }>();
  private temporaryBytes = 0;
  private writingBytes = 0;

  constructor(private readonly requiredLimit = 512 * 1024 ** 2, private readonly temporaryLimit = 2 * 1024 ** 3) {}

  private checkRequired(pending: string | undefined, extra: number) {
    if ((pending ? this.accounts.get(pending)?.required ?? 0 : 0) + extra > this.requiredLimit)
      throw Object.assign(new Error("Required repository objects exceed storage limit"), { code: "required_storage_limit" });
  }

  /** Include each required blob once, before reading the next worktree path. */
  requiredBlobBudget(pending?: string) {
    const seen = new Set<string>();
    let total = 0;
    return (id: string, size: number) => {
      if (!seen.has(id)) {
        total += size + Buffer.byteLength(`blob ${size}\0`);
        seen.add(id);
      }
      // Metadata written since the last scan also consumes the required allowance.
      this.checkRequired(pending, total);
    };
  }

  private checkTemporary(extra: number) {
    if (this.temporaryBytes + extra > this.temporaryLimit)
      throw Object.assign(new Error("Temporary repository artifacts exceed storage limit"), { code: "artifact_storage_limit" });
  }

  trackDisplaced(pending: string, bytes: number) {
    const account = this.accounts.get(pending) ?? { required: 0, total: 0, displaced: 0 };
    const delta = bytes - account.displaced;
    if (delta > 0) this.checkTemporary(delta);
    this.temporaryBytes += delta;
    account.total += delta;
    account.displaced = bytes;
    this.accounts.set(pending, account);
  }

  /** An in-process candidate may still carry its original charge. A recovered
   * empty candidate needs a new reservation before the published bytes return. */
  reclaimPublished(pending: string, bytes: number, move: () => void) {
    const account = this.accounts.get(pending) ?? { required: 0, total: 0, displaced: 0 };
    const extra = Math.max(0, bytes - (account.total - account.displaced));
    if (extra) this.checkTemporary(extra);
    this.temporaryBytes += extra;
    account.total += extra;
    this.accounts.set(pending, account);
    try { move(); }
    catch (error) {
      this.temporaryBytes -= extra;
      account.total -= extra;
      throw error;
    }
  }

  async restoreAbandoned(path: string, kind: "pending" | "leases") {
    // Fail closed if the surviving payload cannot be measured. The next cleanup
    // can still remove it or replace this conservative charge with a precise one.
    const old = this.accounts.get(path)?.total ?? 0;
    const reserved = Math.max(old, this.temporaryLimit);
    this.temporaryBytes += reserved - old;
    this.accounts.set(path, { required: 0, total: reserved, displaced: 0 });
    const displaced = kind === "pending" ? await payloadBytes(join(path, "previous"), 1) : 0;
    const total = kind === "pending" ? displaced + await payloadBytes(join(path, "artifact"), 1)
      : await payloadBytes(join(path, "objects"), 2) + await payloadBytes(join(path, "shallow"), 0);
    this.temporaryBytes += total - reserved;
    this.accounts.set(path, { required: 0, total, displaced });
  }

  async write(allocation: string, path: string, data: Buffer | string, scope: "required" | "additional" | "lease", signal: AbortSignal) {
    signal.throwIfAborted();
    const bytes = Buffer.byteLength(data);
    if (scope === "required") this.checkRequired(allocation, bytes);
    this.checkTemporary(bytes);
    const { bsize, bavail } = statfsSync(allocation);
    const parent = dirname(path);
    const createDirectory = scope === "lease" && !existsSync(parent);
    const directoryBlocks = createDirectory ? (existsSync(dirname(parent)) ? 1 : 2) : 0;
    const blocks = (Math.ceil(bytes / bsize) + directoryBlocks) * bsize;
    if (bsize * bavail - this.writingBytes - blocks < 64 * 1024 ** 2)
      throw Object.assign(new Error("Insufficient space for repository capture"), { code: "artifact_storage_space" });
    // Reserve before yielding. Other writers see the charge even before the filesystem
    // reports the new allocation. Partial writes stay charged until directory cleanup.
    const account = this.accounts.get(allocation) ?? { required: 0, total: 0, displaced: 0 };
    account.total += bytes;
    if (scope === "required") account.required += bytes;
    this.accounts.set(allocation, account);
    this.temporaryBytes += bytes;
    this.writingBytes += blocks;
    try {
      if (createDirectory) await mkdir(parent, { recursive: true, mode: 0o700 });
      await writeFile(path, data, { flag: "wx", mode: 0o400, signal });
    } finally {
      this.writingBytes -= blocks;
    }
  }

  release(allocation: string) {
    this.temporaryBytes -= this.accounts.get(allocation)?.total ?? 0;
    this.accounts.delete(allocation);
  }
}
