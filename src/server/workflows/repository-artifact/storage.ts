import { existsSync, statfsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Shared by all pending candidates and reader leases in this state root. */
export class RepositoryArtifactStorage {
  private readonly accounts = new Map<string, { required: number; total: number }>();
  private temporaryBytes = 0;
  private writingBytes = 0;

  constructor(private readonly requiredLimit = 512 * 1024 ** 2, private readonly temporaryLimit = 2 * 1024 ** 3) {}

  checkRequired(pending: string, extra: number) {
    if ((this.accounts.get(pending)?.required ?? 0) + extra > this.requiredLimit)
      throw Object.assign(new Error("Required repository objects exceed storage limit"), { code: "required_storage_limit" });
  }

  async write(allocation: string, path: string, data: Buffer | string, scope: "required" | "additional" | "lease", signal: AbortSignal) {
    signal.throwIfAborted();
    const bytes = Buffer.byteLength(data);
    if (scope === "required") this.checkRequired(allocation, bytes);
    if (this.temporaryBytes + bytes > this.temporaryLimit)
      throw Object.assign(new Error("Temporary repository artifacts exceed storage limit"), { code: "artifact_storage_limit" });
    const { bsize, bavail } = statfsSync(allocation);
    const parent = dirname(path);
    const createDirectory = scope === "lease" && !existsSync(parent);
    const directoryBlocks = createDirectory ? (existsSync(dirname(parent)) ? 1 : 2) : 0;
    const blocks = (Math.ceil(bytes / bsize) + directoryBlocks) * bsize;
    if (bsize * bavail - this.writingBytes - blocks < 64 * 1024 ** 2)
      throw Object.assign(new Error("Insufficient space for repository capture"), { code: "artifact_storage_space" });
    // Reserve before yielding. Other writers see the charge even before the filesystem
    // reports the new allocation. Partial writes stay charged until directory cleanup.
    const account = this.accounts.get(allocation) ?? { required: 0, total: 0 };
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
