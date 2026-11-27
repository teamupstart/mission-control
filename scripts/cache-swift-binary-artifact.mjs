import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";

async function checksumOf(path) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return hash.digest("hex");
}

export async function cacheSwiftBinaryArtifact(cachePath, url, checksum) {
  const artifacts = join(cachePath, "artifacts");
  // SwiftPM mangles ASCII release URLs to C99 identifiers in its binary artifact cache.
  const cached = join(artifacts, url.replace(/[^A-Za-z0-9_]/g, "_"));
  if (await checksumOf(cached) === checksum) return;

  await mkdir(artifacts, { recursive: true });
  const staging = await mkdtemp(join(artifacts, ".download-"));
  try {
    const archive = join(staging, "artifact.zip");
    console.log(`Downloading SwiftPM binary artifact ${url}`);
    execFileSync("curl", [
      "--disable", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
      "--connect-timeout", "15", "--max-time", "120", "--retry", "2", "--retry-max-time", "120",
      "--output", archive, url,
    ], { stdio: "inherit", timeout: 180_000 });
    if (await checksumOf(archive) !== checksum) {
      throw new Error(`SHA-256 mismatch for SwiftPM binary artifact ${url}`);
    }
    await rename(archive, cached);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
