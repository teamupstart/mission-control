import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflate } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import {
  RepositoryViewFieldsSchema,
  RepositoryViewDescriptorSchema,
  type RepositoryViewDescriptor,
} from "@shared/repository-access.ts";

const compress = promisify(deflate);
export const MAX_CAPTURE_OBJECT_BYTES = 64 * 1024 * 1024;
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
export function descriptor(manifest: Manifest, digest: string, objectView: string): RepositoryViewDescriptor {
  return RepositoryViewDescriptorSchema.parse({ ...manifest.view, snapshotDigest: digest, objectView });
}

async function ordinaryFile(path: string, mode: number, expectedSize?: number) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== mode ||
        (expectedSize !== undefined && stat.size !== expectedSize)) unavailable();
    return await fd.readFile();
  } finally {
    await fd.close();
  }
}

async function readManifest(root: string, digest: string) {
  if (!(await lstat(root)).isDirectory()) unavailable();
  const bytes = await ordinaryFile(join(root, "manifest.json"), 0o400);
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

async function readObject(root: string, entry: ObjectRecord) {
  const header = Buffer.from(`${entry.type} ${entry.size}\0`);
  const size = header.length + entry.size;
  const data = await ordinaryFile(join(root, entry.id), entry.mode, size);
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
  const manifest = await readManifest(root, digest).catch(sourceFailure);
  for (const entry of manifest.objects) {
    signal.throwIfAborted();
    const data = await readObject(root, entry).catch(sourceFailure);
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
