import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  SessionFileDocument,
  SessionFileEntry,
  SessionFileSaveResult,
} from "@shared/types.ts";
import { run } from "./util/exec.ts";

export const MAX_SESSION_FILE_ENTRIES = 2_000;
export const MAX_SESSION_EDITOR_BYTES = 2 * 1024 * 1024;
export const MAX_SESSION_PREVIEW_BYTES = 5 * 1024 * 1024;

export class SessionFileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function revision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function languageFor(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (["dockerfile", "makefile", "procfile"].includes(base)) return base;
  const ext = path.extname(base).slice(1);
  return ext || "text";
}

function isHtml(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

async function rootAndTarget(cwd: string, relativePath: string): Promise<{ root: string; target: string }> {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new SessionFileError("path must be relative to the session checkout");
  }
  const root = await realpath(cwd).catch(() => {
    throw new SessionFileError("session checkout is unavailable", 404);
  });
  const unresolved = path.resolve(root, relativePath);
  const rel = path.relative(root, unresolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new SessionFileError("path leaves the session checkout", 403);
  }
  const targetStat = await lstat(unresolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new SessionFileError("file no longer exists", 404);
    throw error;
  });
  if (targetStat.isSymbolicLink()) throw new SessionFileError("symbolic-link files are unavailable", 403);
  if (!targetStat.isFile()) throw new SessionFileError("path is not a regular file");
  const target = await realpath(unresolved);
  const realRel = path.relative(root, target);
  if (realRel === ".." || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
    throw new SessionFileError("path resolves outside the session checkout", 403);
  }
  return { root, target };
}

export async function listSessionFiles(cwd: string): Promise<SessionFileEntry[]> {
  const root = await realpath(cwd).catch(() => {
    throw new SessionFileError("session checkout is unavailable", 404);
  });
  const result = await run(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { timeoutMs: 15_000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.code !== 0 || result.overflowed) {
    throw new SessionFileError("could not list files in this checkout", 500);
  }
  const discovered = result.stdout
    .split("\0")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const files: SessionFileEntry[] = [];
  for (const filePath of discovered) {
    if (files.length >= MAX_SESSION_FILE_ENTRIES) break;
    const candidate = path.resolve(root, filePath);
    const rel = path.relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    const info = await lstat(candidate).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink()) files.push({ path: filePath });
  }
  return files;
}

export async function readSessionFile(cwd: string, relativePath: string): Promise<SessionFileDocument> {
  const { target } = await rootAndTarget(cwd, relativePath);
  const info = await stat(target);
  const html = isHtml(relativePath);
  const cap = html ? MAX_SESSION_PREVIEW_BYTES : MAX_SESSION_EDITOR_BYTES;
  if (info.size > cap) {
    return {
      path: relativePath,
      kind: "oversized",
      editable: false,
      text: null,
      size: info.size,
      mtime: info.mtimeMs,
      language: languageFor(relativePath),
      revision: "",
      error: `File exceeds the ${Math.round(cap / 1024 / 1024)} MiB ${html ? "preview" : "editor"} limit`,
    };
  }
  const bytes = await readFile(target);
  const rev = revision(bytes);
  if (bytes.includes(0)) {
    return {
      path: relativePath, kind: "binary", editable: false, text: null, size: bytes.length,
      mtime: info.mtimeMs, language: languageFor(relativePath), revision: rev,
      error: "Binary files cannot be opened in the text editor",
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      path: relativePath, kind: "binary", editable: false, text: null, size: bytes.length,
      mtime: info.mtimeMs, language: languageFor(relativePath), revision: rev,
      error: "This file is not valid UTF-8",
    };
  }
  const editable = bytes.length <= MAX_SESSION_EDITOR_BYTES;
  return {
    path: relativePath,
    kind: html ? "html" : "text",
    editable,
    text,
    size: bytes.length,
    mtime: info.mtimeMs,
    language: languageFor(relativePath),
    revision: rev,
    error: editable ? null : "Preview only: file exceeds the 2 MiB editor limit",
  };
}

export async function saveSessionFile(
  cwd: string,
  relativePath: string,
  text: string,
  expectedRevision: string,
): Promise<SessionFileSaveResult> {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_SESSION_EDITOR_BYTES) {
    throw new SessionFileError("text exceeds the 2 MiB editor limit", 413);
  }

  let resolved: { target: string };
  try {
    resolved = await rootAndTarget(cwd, relativePath);
  } catch (error) {
    if (error instanceof SessionFileError && error.status === 404) {
      return { ok: false, status: 409, error: "file was deleted on disk", deleted: true };
    }
    throw error;
  }
  const current = await readFile(resolved.target);
  const currentRevision = revision(current);
  const currentText = decodeConflictText(current);
  if (currentRevision !== expectedRevision) {
    return { ok: false, status: 409, error: "file changed on disk", currentRevision, currentText };
  }

  const info = await lstat(resolved.target);
  const temp = path.join(path.dirname(resolved.target), `.mission-control-${randomUUID()}.tmp`);
  let tempExists = false;
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, info.mode & 0o777);
    tempExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(info.mode & 0o777);
    } finally {
      await handle.close();
    }
    const latest = await readFile(resolved.target).catch(() => null);
    if (!latest || revision(latest) !== expectedRevision) {
      return {
        ok: false,
        status: 409,
        error: latest ? "file changed while saving" : "file was deleted while saving",
        currentRevision: latest ? revision(latest) : undefined,
        currentText: latest ? decodeConflictText(latest) : null,
        deleted: !latest,
      };
    }
    await rename(temp, resolved.target);
    tempExists = false;
    const written = await stat(resolved.target);
    return { ok: true, revision: revision(bytes), mtime: written.mtimeMs };
  } finally {
    if (tempExists) await unlink(temp).catch(() => {});
  }
}

function decodeConflictText(bytes: Buffer): string | null {
  if (bytes.length > MAX_SESSION_EDITOR_BYTES || bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
