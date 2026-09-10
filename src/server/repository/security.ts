import { posix } from "node:path";
import type { RepositoryOperationId } from "@shared/repository-access.ts";

const DENIED_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".dockercfg",
  "credentials",
  "credentials.json",
  "secrets",
  "secrets.json",
]);

const DENIED_SEGMENTS = new Set([
  ".git",
  ".aws",
  ".ssh",
  ".claude",
  ".codex",
  ".mission-control",
]);

const DENIED_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".crt", ".cer"] as const;
const DENIED_KEY_PREFIXES = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"] as const;

export class RepositoryPathPolicyError extends Error {
  readonly code: "path_invalid" | "path_denied";

  constructor(code: "path_invalid" | "path_denied", message: string) {
    super(message);
    this.name = "RepositoryPathPolicyError";
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new RepositoryPathPolicyError("path_invalid", message);
}

/** Validate one addressable repository path without resolving it against the host. */
export function canonicalRepositoryPath(path: string, allowGlob = false): string {
  if (!path) invalid("repository path is empty");
  if (Buffer.byteLength(path, "utf8") > 4_096) invalid("repository path is too long");
  if (path.includes("\0")) invalid("repository path contains NUL");
  if (path.includes("\\")) invalid("repository paths use POSIX separators only");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) invalid("repository path is absolute");
  if (path.startsWith("-")) invalid("repository path is option-like");
  if (path.startsWith("./") || path.endsWith("/") || path.includes("//")) {
    invalid("repository path is not canonical");
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") invalid("repository path traverses");
    if (Buffer.byteLength(segment, "utf8") > 255) invalid("repository path segment is too long");
    if (!allowGlob && /[*?[\]{}]/.test(segment)) invalid("literal repository path contains glob syntax");
  }
  if (posix.normalize(path) !== path) invalid("repository path changes under normalization");
  return path;
}

/** Decode only lossless UTF-8 Git paths. Other names may be listed but are not addressable. */
export function addressableGitPath(bytes: Uint8Array): string | null {
  const decoded = Buffer.from(bytes).toString("utf8");
  return Buffer.from(decoded, "utf8").equals(Buffer.from(bytes)) ? decoded : null;
}

/** Stable marker for a Git path the string request contract cannot address without loss. */
export function escapedGitPath(bytes: Uint8Array): string {
  const addressable = addressableGitPath(bytes);
  if (addressable !== null) return addressable;
  return `git-bytes:${Buffer.from(bytes).toString("hex")}`;
}

export function repositoryPathDenied(path: string): boolean {
  const canonical = canonicalRepositoryPath(path, true);
  const segments = canonical.split("/").map((segment) => segment.toLocaleLowerCase("en-US"));
  const base = segments.at(-1)!;
  if (segments.some((segment) => DENIED_SEGMENTS.has(segment))) return true;
  if (base === ".env" || base === ".envrc" || base.startsWith(".env.") || base.startsWith(".envrc.")) return true;
  if (DENIED_BASENAMES.has(base)) return true;
  if (base.startsWith("credentials.") || base.startsWith("secrets.")) return true;
  if (DENIED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  return DENIED_KEY_PREFIXES.some((prefix) => base.startsWith(prefix));
}

export function approveRepositoryPath(path: string, allowGlob = false): string {
  const canonical = canonicalRepositoryPath(path, allowGlob);
  if (repositoryPathDenied(canonical)) {
    throw new RepositoryPathPolicyError("path_denied", "repository path is protected");
  }
  return canonical;
}

export function validateRevisionId(revision: string): string {
  if (!/^[0-9a-f]{40,64}$/.test(revision)) {
    throw new RepositoryPathPolicyError("path_invalid", "revision must be an exact object id");
  }
  return revision;
}

export const REPOSITORY_OPERATION_SAFETY: Record<
  RepositoryOperationId,
  { validatesPaths: true; preauthorizesContent: boolean; scrubsText: boolean }
> = {
  read: { validatesPaths: true, preauthorizesContent: true, scrubsText: true },
  search: { validatesPaths: true, preauthorizesContent: true, scrubsText: true },
  glob: { validatesPaths: true, preauthorizesContent: false, scrubsText: false },
  git_status: { validatesPaths: true, preauthorizesContent: false, scrubsText: false },
  git_diff: { validatesPaths: true, preauthorizesContent: true, scrubsText: true },
  git_show: { validatesPaths: true, preauthorizesContent: true, scrubsText: true },
  git_log: { validatesPaths: true, preauthorizesContent: false, scrubsText: true },
  git_blame: { validatesPaths: true, preauthorizesContent: true, scrubsText: true },
};
