import { writeFile } from "node:fs/promises";
import type { RepositoryQueryAuditMetadata } from "@shared/repository-access.ts";
import type { RepositoryAuditSink } from "./reader.ts";

type AuditRecordWriter = (path: string, record: string) => Promise<void>;

async function appendRecord(path: string, record: string): Promise<void> {
  await writeFile(path, record, { encoding: "utf8", mode: 0o600, flag: "a" });
}

export class RepositoryJsonlAuditSink implements RepositoryAuditSink {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly write: AuditRecordWriter = appendRecord,
  ) {}

  append(metadata: RepositoryQueryAuditMetadata, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const record = `${JSON.stringify(metadata)}\n`;
    const pending = this.tail.then(async () => {
      signal.throwIfAborted();
      // Once a record starts, finish it without an abortable filesystem write. The
      // serialized append is the audit commit point and must never leave partial JSONL.
      await this.write(this.path, record);
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
}
