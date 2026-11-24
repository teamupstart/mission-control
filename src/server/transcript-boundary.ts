import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync, type BigIntStats } from "node:fs";
import { Worker } from "node:worker_threads";
import type { PreparedTranscriptBoundaries, TranscriptBoundary } from "./harness/types.ts";

function fileVersion(s: BigIntStats): string {
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}

function fileId(s: BigIntStats): string {
  return [s.dev, s.ino, s.birthtimeNs].join(":");
}

export function transcriptSnapshot(path: string) {
  try {
    const s = statSync(path, { bigint: true });
    return { size: Number(s.size), version: fileVersion(s), fileId: fileId(s) };
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
      // the same descriptor. The confirming pass must belong to a single revision.
      if (prefixDigest(fd) !== proof) return null;
      const final = statSync(path, { bigint: true });
      if (!coversPrefix(final) || fileVersion(final) !== fileVersion(current)) return null;
      current = final;
    }
    return { boundary: { offset: end, proof }, version: fileVersion(current) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Verify all fixed offsets on one descriptor. Later appends do not move a page's end. */
function fixedBoundaries(path: string, offsets: number[]): PreparedTranscriptBoundaries | null {
  const fd = openSync(path, "r");
  try {
    const started = fstatSync(fd, { bigint: true });
    const identity = fileId(started);
    const ends = [...new Set(offsets.filter(n => Number.isSafeInteger(n) && n >= 0 && n <= started.size))].sort((a, b) => a - b);
    const end = ends.at(-1) ?? 0;
    const buffer = Buffer.allocUnsafe(Math.min(65536, end));
    const hashPrefixes = () => {
      // Persisted hashes include the offset in their seed. Feed them together in one file pass.
      const hashes = ends.map(offset => createHash("sha256").update(identity + ":" + offset + "\n"));
      for (let pos = 0; pos < end;) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, end - pos), pos);
        if (!n) return null;
        for (let i = 0; i < ends.length; i++) {
          if (ends[i]! > pos) hashes[i]!.update(buffer.subarray(0, Math.min(n, ends[i]! - pos)));
        }
        pos += n;
      }
      return new Map(ends.map((offset, i) => [offset, { offset, proof: hashes[i]!.digest("hex") }]));
    };
    const proofs = hashPrefixes();
    let final = statSync(path, { bigint: true });
    if (!proofs || fileId(final) !== identity || final.size < end) return null;
    if (fileVersion(final) !== fileVersion(started)) {
      const checked = hashPrefixes();
      if (!checked || ends.some(offset => proofs.get(offset)!.proof !== checked.get(offset)!.proof)) return null;
      const after = statSync(path, { bigint: true });
      if (fileVersion(after) !== fileVersion(final) || fileId(after) !== identity) return null;
      final = after;
    }
    return { proofs, eof: null, version: fileVersion(final), fileId: identity, size: Number(final.size) };
  } finally {
    closeSync(fd);
  }
}

/** Capture the requested prefix proofs against one revision, including EOF when preparing a handoff. */
export function captureHandoffBoundaries(path: string, offsets: number[], includeEof = true): PreparedTranscriptBoundaries | null {
  try {
    if (!includeEof) return fixedBoundaries(path, offsets);
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

export function prepareHandoffBoundaries(path: string, offsets: number[], includeEof = true): Promise<PreparedTranscriptBoundaries | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./transcript-boundary-worker.mjs", import.meta.url), {
      workerData: { path, offsets, includeEof }, execArgv: [],
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => reject(new Error(`Transcript boundary worker exited before returning proof (code ${code})`)));
  });
}
