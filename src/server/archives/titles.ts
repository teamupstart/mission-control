import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { lstat, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ARCHIVE_TEXT_LIMITS,
  parseArchiveKey,
} from "@shared/archives.ts";

/**
 * A human's local display name for an immutable archive.
 *
 * The archive manifest cannot carry this edit: a published bundle is immutable, and the
 * reconciler deliberately refuses a same-key manifest rewrite. SQLite cannot be its only
 * home either, because the archive index is disposable. These tiny sidecars therefore live
 * beside, not inside, the bundles under `<write-root>/.metadata/names/` and are projected
 * back into the index whenever it is rebuilt.
 *
 * One file per archive avoids a whole-catalog read/modify/write race and keeps a damaged
 * entry from hiding every other name. The file's key is repeated in its body so copying or
 * renaming one by hand cannot silently apply it to a different archive.
 */

const METADATA_DIR = ".metadata";
const NAMES_DIR = "names";
const TITLE_FORMAT = "mission-control/archive-display-name";
const TITLE_VERSION = 1;
const TITLE_FILE_LIMIT = 4 * 1024;

interface StoredArchiveTitle {
  format: typeof TITLE_FORMAT;
  version: typeof TITLE_VERSION;
  key: string;
  title: string;
}

export class ArchiveTitleStore {
  private readonly titles = new Map<string, string>();
  private readonly metadataDirectory: string;
  private readonly directory: string;

  constructor(private readonly writeRoot: string) {
    this.metadataDirectory = join(writeRoot, METADATA_DIR);
    this.directory = join(this.metadataDirectory, NAMES_DIR);
    this.load();
  }

  get(key: string): string | null {
    return this.titles.get(key) ?? null;
  }

  /** Persist first, then publish to the in-memory projection. */
  async set(key: string, rawTitle: string): Promise<string> {
    if (!parseArchiveKey(key)) throw new Error("no such archive");
    const title = normalizedTitle(rawTitle);
    if (!title) throw new Error("archive name must not be blank");

    await this.ensureDirectory();
    const target = join(this.directory, `${key}.json`);
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error("the archive display-name entry is not a regular file");
    }

    const temp = join(this.directory, `${key}.${randomUUID()}.tmp`);
    const record: StoredArchiveTitle = {
      format: TITLE_FORMAT,
      version: TITLE_VERSION,
      key,
      title,
    };
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    this.titles.set(key, title);
    return title;
  }

  /** A confirmed archive deletion also drops its local display name. */
  async remove(key: string): Promise<void> {
    if (!parseArchiveKey(key)) return;
    for (const directory of [this.metadataDirectory, this.directory]) {
      const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      if (!info) {
        this.titles.delete(key);
        return;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("the archive display-name directory is not a real directory");
      }
    }
    const target = join(this.directory, `${key}.json`);
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Error("the archive display-name entry is not a regular file");
    }
    if (existing) await unlink(target);
    this.titles.delete(key);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.writeRoot, { recursive: true, mode: 0o700 });
    await ensureRealDirectory(this.metadataDirectory);
    await ensureRealDirectory(this.directory);
  }

  private load(): void {
    let entries: string[];
    try {
      const metadataInfo = lstatSync(this.metadataDirectory);
      if (metadataInfo.isSymbolicLink() || !metadataInfo.isDirectory()) return;
      const directoryInfo = lstatSync(this.directory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) return;
      entries = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      return;
    }

    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const key = name.slice(0, -".json".length);
      if (!parseArchiveKey(key)) continue;
      const file = join(this.directory, name);
      try {
        const info = lstatSync(file);
        if (info.isSymbolicLink() || !info.isFile() || info.size > TITLE_FILE_LIMIT) {
          continue;
        }
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredArchiveTitle>;
        const title = normalizedTitle(parsed.title);
        if (
          parsed.format !== TITLE_FORMAT
          || parsed.version !== TITLE_VERSION
          || parsed.key !== key
          || !title
        ) {
          continue;
        }
        this.titles.set(key, title);
      } catch {
        // One damaged local annotation never hides the archive or its other names.
      }
    }
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("the archive display-name directory is not a real directory");
    }
    return;
  }
  await mkdir(path, { mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const raced = await lstat(path);
    if (raced.isSymbolicLink() || !raced.isDirectory()) {
      throw new Error("the archive display-name directory is not a real directory");
    }
  });
}

function normalizedTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (title === "" || title.length > ARCHIVE_TEXT_LIMITS.title) return null;
  return title;
}
