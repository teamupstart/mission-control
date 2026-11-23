import { StringDecoder } from "node:string_decoder";
import { open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  RepositoryQueryAuditMetadataSchema,
  type PersonaWorkloadRequest,
  type RepositoryQueryAuditMetadata,
} from "@shared/repository-access.ts";

/** Incremental, bounded metadata-only drain. A seal detects child loss and failed audit writes. */
export async function openRepositoryAuditJournal(
  path: string,
  request: PersonaWorkloadRequest,
  onRecord: (record: RepositoryQueryAuditMetadata) => void,
) {
  const file = await open(path, "r");
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const ids = new Set<string>();
  const handles: RepositoryQueryAuditMetadata["handles"] = [];
  let offset = 0,
    pending = "",
    failed = false;
  let tail = Promise.resolve();
  const drain = () => {
    tail = tail.then(async () => {
      if (failed) throw Error("Audit journal failed");
      const { size } = await file.stat();
      if (size > 256 * 1024 * 1024) throw Error("Audit journal exceeds limit");
      const buffer = Buffer.alloc(65536);
      while (offset < size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, size - offset),
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
        pending += decoder.write(buffer.subarray(0, bytesRead));
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const record = RepositoryQueryAuditMetadataSchema.parse(
            JSON.parse(line),
          );
          if (
            record.workloadId !== request.workloadId ||
            record.attemptId !== request.attemptId ||
            record.snapshotDigest !== request.artifact.digest ||
            ids.has(record.operationId) ||
            ids.size >= request.budgets.attemptCalls
          )
            throw Error("Audit identity or budget mismatch");
          ids.add(record.operationId);
          handles.push(...record.handles);
          onRecord(record);
        }
        if (Buffer.byteLength(pending) > 2 * 1024 * 1024)
          throw Error("Oversized audit record");
      }
    });
    return tail.catch((error) => {
      failed = true;
      throw error;
    });
  };
  return {
    drain,
    handles,
    async finish(signal: AbortSignal) {
      // Provider shutdown closes MCP stdin. The seal rename may finish just after the SDK exits.
      let seal:
        | {
            workloadId: string;
            attemptId: string;
            count: number;
            sha256: string;
          }
        | undefined;
      for (let i = 0; i < 100; i++) {
        signal.throwIfAborted();
        try {
          seal = JSON.parse(await readFile(path + ".seal", "utf8"));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      await drain();
      if (
        !seal ||
        pending ||
        seal.workloadId !== request.workloadId ||
        seal.attemptId !== request.attemptId ||
        seal.count !== ids.size ||
        seal.sha256 !== hash.digest("hex")
      )
        throw Error("Missing or invalid audit seal");
    },
    async close() {
      await tail.catch(() => {});
      await file.close();
    },
  };
}
