import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync, type BigIntStats } from "node:fs";
import { Worker } from "node:worker_threads";
import type { PreparedTranscriptBoundaries, TranscriptBoundary } from "./harness/types.ts";

function fileVersion(s: BigIntStats): string {
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}

export function transcriptSnapshot(path: string) {
  try {
    const s = statSync(path, { bigint: true });
    return { size: Number(s.size), version: fileVersion(s) };
  } catch {
    return null;
  }
}

export function transcriptBoundary(path: string, offset?: number): TranscriptBoundary | null {
  try {
    return captureBoundary(path, offset)?.boundary ?? null;
  } catch {
    return null;
  }
}

/** The offset and prefix come from one open file. A replacement inode or a rewritten prefix invalidates it. */
function captureBoundary(path: string, offset?: number) {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const original = fstatSync(fd, { bigint: true });
    const end = offset ?? Number(original.size);
    if (!Number.isSafeInteger(end) || end < 0 || end > original.size) return null;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end));
    const prefixDigest = (file: number) => {
      const hash = createHash("sha256").update([original.dev, original.ino, original.birthtimeNs, end].join(":") + "\n");
      for (let pos = 0; pos < end;) {
        const n = readSync(file, chunk, 0, Math.min(end - pos, chunk.length), pos);
        if (!n) return null;
        hash.update(chunk.subarray(0, n));
        pos += n;
      }
      return hash.digest("hex");
    };
    const coversPrefix = (s: BigIntStats) => original.dev === s.dev && original.ino === s.ino
      && original.birthtimeNs === s.birthtimeNs && s.size >= end;
    const proof = prefixDigest(fd);
    let current = statSync(path, { bigint: true });
    if (!proof || !coversPrefix(current)) return null;
    if (current.ctimeNs !== original.ctimeNs || current.size !== original.size) {
      // Growth can coincide with an in-place edit. Verify the original bytes twice on
      // the same descriptor, even if more output arrives during the second pass.
      if (prefixDigest(fd) !== proof) return null;
      const final = statSync(path, { bigint: true });
      if (!coversPrefix(final) || (final.ctimeNs !== current.ctimeNs && final.size <= current.size)) return null;
      current = final;
    }
    return { boundary: { offset: end, proof }, version: fileVersion(current) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Capture the handoff EOF and any outstanding text receipts against the same revision. */
export function captureHandoffBoundaries(path: string, offsets: number[]): PreparedTranscriptBoundaries | null {
  try {
    const eof = captureBoundary(path);
    if (!eof) return null;
    const proofs = new Map<number, TranscriptBoundary>([[eof.boundary.offset, eof.boundary]]);
    for (const offset of offsets) {
      if (offset > eof.boundary.offset || proofs.has(offset)) continue;
      const receipt = captureBoundary(path, offset);
      if (!receipt || receipt.version !== eof.version) return null;
      proofs.set(offset, receipt.boundary);
    }
    return { version: eof.version, eof: eof.boundary, proofs };
  } catch (error) {
    // A consistently unreadable file still permits delivery, with no text attribution.
    if (!(error instanceof Error) || !("code" in error)) throw error;
    return { version: transcriptSnapshot(path)?.version ?? null, eof: null, proofs: new Map() };
  }
}

export function prepareHandoffBoundaries(path: string, offsets: number[]): Promise<PreparedTranscriptBoundaries | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./transcript-boundary-worker.mjs", import.meta.url), {
      workerData: { path, offsets }, execArgv: [],
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => reject(new Error(`Transcript boundary worker exited before returning proof (code ${code})`)));
  });
}
