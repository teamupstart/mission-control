import { statfsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

/** Owned by the one service for this state root. A finished candidate still occupies its reservation. */
export class RepositoryCandidateStorage {
  private readonly accounts = new Map<string, { required: number; total: number }>();
  private pendingBytes = 0;
  private writingBytes = 0;

  constructor(private readonly requiredLimit = 512 * 1024 ** 2, private readonly pendingLimit = 2 * 1024 ** 3) {}

  checkRequired(pending: string, extra: number) {
    if ((this.accounts.get(pending)?.required ?? 0) + extra > this.requiredLimit)
      throw Object.assign(new Error("Required repository objects exceed storage limit"), { code: "required_storage_limit" });
  }

  async write(pending: string, path: string, data: Buffer | string, required: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    const bytes = Buffer.byteLength(data);
    if (required) this.checkRequired(pending, bytes);
    if (this.pendingBytes + bytes > this.pendingLimit)
      throw Object.assign(new Error("Pending repository artifacts exceed storage limit"), { code: "pending_storage_limit" });
    const { bsize, bavail } = statfsSync(pending);
    const blocks = Math.ceil(bytes / bsize) * bsize;
    if (bsize * bavail - this.writingBytes - blocks < 64 * 1024 ** 2)
      throw Object.assign(new Error("Insufficient space for repository capture"), { code: "artifact_storage_space" });
    // Reserve before yielding. Other writers see the charge even before the filesystem
    // reports the new allocation. Partial writes stay charged until directory cleanup.
    const account = this.accounts.get(pending) ?? { required: 0, total: 0 };
    account.total += bytes;
    if (required) account.required += bytes;
    this.accounts.set(pending, account);
    this.pendingBytes += bytes;
    this.writingBytes += blocks;
    try {
      await writeFile(path, data, { flag: "wx", mode: 0o400, signal });
    } finally {
      this.writingBytes -= blocks;
    }
  }

  release(pending: string) {
    this.pendingBytes -= this.accounts.get(pending)?.total ?? 0;
    this.accounts.delete(pending);
  }
}
