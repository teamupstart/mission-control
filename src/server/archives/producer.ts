import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isArchiveId } from "@shared/archives.ts";
import { ARCHIVES_DIR, ARCHIVE_PRODUCER_PATH } from "../config.ts";

/**
 * This machine's producer namespace.
 *
 * Every archive this daemon creates lands under `archives/<producer-id>/`, and the producer
 * id is a random UUID stored once in a small file OUTSIDE the library. That is the whole
 * collision story for the sharing model: two people who have never met generate archives in
 * different namespaces, so copying one library into another can never make two different
 * archives claim one key, and copying the SAME bundle twice is idempotent.
 *
 * The label beside it is decoration - a human-readable machine name for a UI - and is never
 * trusted as identity by anything. A foreign manifest's label is a stranger's claim.
 */
export interface ArchiveProducerIdentity {
  id: string;
  label: string | null;
}

interface ProducerFile {
  id?: unknown;
  label?: unknown;
}

/**
 * Read this machine's producer identity, creating it on first use.
 *
 * Written through a temp file and `rename` so a crash mid-write leaves either the old
 * identity or the new one, never a truncated file that would be read as "no identity" and
 * silently open a second namespace on the next boot.
 *
 * A file that exists but cannot be read as a generated UUID is REPLACED rather than
 * repaired: the only thing a corrupt identity can do is make new archives unaddressable,
 * and existing bundles are unaffected because each one carries its producer in its own path
 * and manifest. That is the same reason losing the file entirely is survivable.
 *
 * Synchronous on purpose. It runs once, at composition time, before anything can publish -
 * and an async identity would mean every writer had to await a value that never changes.
 */
export function loadArchiveProducer(
  filePath: string = ARCHIVE_PRODUCER_PATH,
  libraryRoot: string = ARCHIVES_DIR,
): ArchiveProducerIdentity {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  mkdirSync(libraryRoot, { recursive: true, mode: 0o700 });

  const existing = readProducerFile(filePath);
  if (existing) return existing;

  const identity: ArchiveProducerIdentity = { id: randomUUID(), label: null };
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ id: identity.id, label: identity.label }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temp, filePath);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file is ours and unreferenced; failing to remove it is not worth raising.
    }
    throw error;
  }
  // Read back rather than returning what we just built: if two daemons ever raced here, the
  // one whose rename lost must use the identity that actually won, not the one it generated.
  return readProducerFile(filePath) ?? identity;
}

function readProducerFile(filePath: string): ArchiveProducerIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const file = parsed as ProducerFile;
  if (!isArchiveId(file.id)) return null;
  const label = typeof file.label === "string" && file.label.trim() !== "" ? file.label.trim() : null;
  return { id: file.id, label };
}

/** This producer's directory in the library - created lazily by the capture path. */
export function producerDir(libraryRoot: string, producerId: string): string {
  return join(libraryRoot, producerId);
}
