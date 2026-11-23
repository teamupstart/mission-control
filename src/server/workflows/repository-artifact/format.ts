import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdir, readdir, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { deflate } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { approvedPath } from "@shared/repository-policy.ts";
import {
  RepositoryViewFieldsSchema,
  RepositoryViewDescriptorSchema,
  type RepositoryViewDescriptor,
} from "@shared/repository-access.ts";

const compress = promisify(deflate);
export const MAX_CAPTURE_OBJECT_BYTES = 64 * 1024 * 1024;
export function decodedPath(key: string) {
  const raw = Buffer.from(key, "hex");
  const text = raw.toString("utf8");
  return Buffer.from(text).equals(raw) ? text : null;
}
export const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
export const objectBytes = (type: string, body: Buffer) =>
  Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);

export class RepositoryArtifactUnavailable extends Error {
  readonly code = "artifact_unavailable";
  constructor() {
    super("Repository artifact unavailable");
  }
}
export class RepositoryCaptureChanged extends RepositoryArtifactUnavailable {}
export const unavailable = (): never => {
  throw new RepositoryArtifactUnavailable();
};

/** Only a verification error that establishes missing or invalid bytes invalidates every claim. */
export function isArtifactIntegrityFailure(error: unknown): boolean {
  if (error instanceof RepositoryArtifactUnavailable || error instanceof SyntaxError || error instanceof z.ZodError)
    return true;
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP");
}

export const objectRecord = z.strictObject({
  id: oid,
  mode: z.literal(0o400),
  type: z.enum(["blob", "tree", "commit"]),
  size: z.number().int().nonnegative(),
  sha256: digestSchema,
});
export type ObjectRecord = z.infer<typeof objectRecord>;
export const manifestSchema = z.strictObject({
  version: z.literal(1),
  repository: digestSchema,
  // The outer digest and lease identity are supplied only after verification.
  view: RepositoryViewFieldsSchema.omit({ snapshotDigest: true, objectView: true }),
  paths: z.array(
    z.strictObject({
      bytes: z.string().regex(/^(?:[a-f0-9]{2})+$/),
      allowed: z.boolean(),
      classifications: z.array(z.string()),
    }),
  ),
  objects: z.array(objectRecord),
});
export type Manifest = z.infer<typeof manifestSchema>;
// Older v1 writers also marked base-only paths as deleted. Every real checkout
// deletion differs from HEAD to index or from index to worktree.
function checkoutDeletion(classes: readonly string[]) {
  return classes.includes("deleted") && (classes.includes("staged") || classes.includes("unstaged"));
}
export function descriptor(manifest: Manifest, digest: string, objectView: string): RepositoryViewDescriptor {
  const { view } = manifest;
  for (const layer of [view.worktree, view.index]) {
    if (layer.some(e => e.kind === "submodule" && e.blob !== null && e.blob.length !== view.worktreeTree.length))
      unavailable();
  }
  const worktree = view.worktree.filter(e => e.blob !== null || !e.classifications.includes("deleted") ||
    checkoutDeletion(e.classifications));
  const listed = new Set(worktree.map(entry => entry.path));
  const statusDeletions = [];
  for (const entry of manifest.paths) {
    if (!entry.allowed || !checkoutDeletion(entry.classifications)) continue;
    const path = decodedPath(entry.bytes);
    if (path && approvedPath(path) && !listed.has(path))
      statusDeletions.push({ path, classifications: entry.classifications });
  }
  return RepositoryViewDescriptorSchema.parse({ ...view, worktree, snapshotDigest: digest, objectView,
    ...(statusDeletions.length ? { statusDeletions } : {}) });
}

/** Probe one byte beyond the sampled size. Short reads may precede EOF. */
export async function readExactFile(fd: FileHandle, size: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const buffer = Buffer.allocUnsafe(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    signal.throwIfAborted();
    const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset === size ? buffer.subarray(0, size) : null;
}

async function ordinaryFile(path: string, mode: number, signal: AbortSignal, expected: number | string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== mode ||
        (typeof expected === "number" && stat.size !== expected)) unavailable();
    // Only the manifest lacks an authenticated size. Authenticate a large one in
    // chunks before allowing its observed size to determine an allocation.
    if (typeof expected === "string" && stat.size > MAX_CAPTURE_OBJECT_BYTES) {
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      for (let offset = 0; offset < stat.size;) {
        signal.throwIfAborted();
        const { bytesRead } = await fd.read(chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
        if (!bytesRead) unavailable();
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (hash.digest("hex") !== expected) unavailable();
    }
    return (await readExactFile(fd, stat.size, signal)) ?? unavailable();
  } finally {
    await fd.close();
  }
}

async function readManifest(root: string, digest: string, signal: AbortSignal) {
  if (!(await lstat(root)).isDirectory()) unavailable();
  const bytes = await ordinaryFile(join(root, "manifest.json"), 0o400, signal, digest);
  if (sha256(bytes) !== digest) unavailable();
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString()));
  if (!bytes.equals(Buffer.from(JSON.stringify(manifest)))) unavailable();
  descriptor(manifest, digest, "verified");
  const files = new Set(await readdir(root));
  files.delete("manifest.json");
  for (const entry of manifest.objects) if (!files.delete(entry.id)) unavailable();
  if (files.size) unavailable();
  return manifest;
}

async function readObject(root: string, entry: ObjectRecord, signal: AbortSignal) {
  const header = Buffer.from(`${entry.type} ${entry.size}\0`);
  const size = header.length + entry.size;
  const data = await ordinaryFile(join(root, entry.id), entry.mode, signal, size);
  if (data.length !== size || !data.subarray(0, header.length).equals(header) ||
      sha256(data) !== entry.sha256 || createHash(entry.id.length === 40 ? "sha1" : "sha256")
        .update(data).digest("hex") !== entry.id) unavailable();
  return data;
}

/** Only verified source bytes enter a lease. Destination errors do not describe the source. */
export async function verifyDirectory(root: string, digest: string, signal: AbortSignal,
  lease?: string, onIntegrityFailure?: () => void) {
  const sourceFailure = (error: unknown): never => {
    if (!signal.aborted && isArtifactIntegrityFailure(error)) onIntegrityFailure?.();
    throw error;
  };
  signal.throwIfAborted();
  const manifest = await readManifest(root, digest, signal).catch(sourceFailure);
  for (const entry of manifest.objects) {
    signal.throwIfAborted();
    const data = await readObject(root, entry, signal).catch(sourceFailure);
    if (lease) {
      const dir = join(lease, "objects", entry.id.slice(0, 2));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, entry.id.slice(2)), await compress(data), { flag: "wx", mode: 0o400 });
    }
  }
  if (lease && manifest.view.frontier.length)
    await writeFile(join(lease, "shallow"), manifest.view.frontier.map((r) => r.revision + "\n").join(""));
  signal.throwIfAborted();
  return manifest;
}
