import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  inspectSettingsBackupValue,
  SETTINGS_BACKUP_LIMITS,
  SETTINGS_BACKUP_RETENTION,
  SettingsBackupFilenameSchema,
  type SettingsBackupEnvelopeV1,
} from "@shared/settings-backups.ts";
import { SETTINGS_BACKUPS_DIR } from "../config.ts";
import {
  settingsBackupFileText,
  validateSettingsBackupDomains,
  verifySettingsBackupDigest,
} from "./format.ts";

export type SettingsBackupRead =
  | {
      status: "ready";
      id: string;
      filename: string;
      size: number;
      modifiedAt: number;
      snapshot: SettingsBackupEnvelopeV1;
    }
  | {
      status: "produced_by_newer_build" | "corrupt" | "unreadable" | "not_found";
      id: string;
      filename: string;
      size: number | null;
      modifiedAt: number | null;
      reason: string;
    };

export type SettingsBackupListItem = Omit<Extract<SettingsBackupRead, { status: "ready" }>, "snapshot">
  & { kind: SettingsBackupEnvelopeV1["kind"]; createdAt: string; localDate: string; appVersion: string; counts: SettingsBackupEnvelopeV1["counts"]; digest: string }
  | Exclude<SettingsBackupRead, { status: "ready" }>;

interface SettingsBackupStoreHooks {
  /** Focused failure seam after durable temp bytes and before atomic publication. */
  beforeRename?(): void;
}

function boundedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, SETTINGS_BACKUP_LIMITS.errorCharacters);
}

function ownedFilename(value: string): boolean {
  return SettingsBackupFilenameSchema.safeParse(value).success;
}

export class SettingsBackupStore {
  constructor(
    readonly root = SETTINGS_BACKUPS_DIR,
    private readonly hooks: SettingsBackupStoreHooks = {},
  ) {}

  private ensureRoot(): void {
    const parent = dirname(this.root);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new TypeError("Settings backup parent must be a real directory");
    }
    chmodSync(parent, 0o700);

    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700 });
    const rootStat = lstatSync(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new TypeError("Settings backup root must be a real directory");
    }
    chmodSync(this.root, 0o700);
  }

  private pathForFilename(filename: string): string {
    const parsed = SettingsBackupFilenameSchema.parse(filename);
    const path = join(this.root, parsed);
    if (dirname(path) !== this.root || basename(path) !== parsed) {
      throw new TypeError("Settings backup path escaped its root");
    }
    return path;
  }

  private ownedFilenames(): string[] {
    this.ensureRoot();
    const names = readdirSync(this.root).filter(ownedFilename);
    if (names.length > SETTINGS_BACKUP_LIMITS.ownedFiles) {
      throw new RangeError("Settings backup root contains too many owned files");
    }
    return names;
  }

  private inspect(filename: string): SettingsBackupRead {
    const id = filename.slice(0, -5);
    const path = this.pathForFilename(filename);
    let size: number | null = null;
    let modifiedAt: number | null = null;
    try {
      const pathStat = lstatSync(path);
      size = pathStat.size;
      modifiedAt = pathStat.mtimeMs;
      if (pathStat.isSymbolicLink()) throw new TypeError("Snapshot entry is a symbolic link");
      if (!pathStat.isFile()) throw new TypeError("Snapshot entry is not a regular file");
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const fd = openSync(path, constants.O_RDONLY | noFollow);
      let text: string;
      try {
        const stat = fstatSync(fd);
        size = stat.size;
        modifiedAt = stat.mtimeMs;
        if (!stat.isFile()) throw new TypeError("Snapshot entry is not a regular file");
        if (stat.size <= 0 || stat.size > SETTINGS_BACKUP_LIMITS.fileBytes) {
          throw new RangeError("Snapshot file size is outside the supported bounds");
        }
        text = readFileSync(fd, "utf8");
        if (Buffer.byteLength(text, "utf8") !== stat.size) {
          throw new TypeError("Snapshot changed while it was being read");
        }
      } finally {
        closeSync(fd);
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return { status: "corrupt", id, filename, size, modifiedAt, reason: "Snapshot JSON is invalid" };
      }
      const compatibility = inspectSettingsBackupValue(value);
      if (compatibility.status !== "ready") {
        return { ...compatibility, id, filename, size, modifiedAt };
      }
      const snapshot = compatibility.snapshot;
      if (snapshot.id !== id) {
        return { status: "corrupt", id, filename, size, modifiedAt, reason: "Snapshot id does not match its filename" };
      }
      if (!verifySettingsBackupDigest(snapshot)) {
        return { status: "corrupt", id, filename, size, modifiedAt, reason: "Snapshot digest does not match" };
      }
      try {
        validateSettingsBackupDomains(snapshot);
      } catch (error) {
        return { status: "corrupt", id, filename, size, modifiedAt, reason: boundedReason(error) };
      }
      return { status: "ready", id, filename, size, modifiedAt, snapshot };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { status: "not_found", id, filename, size, modifiedAt, reason: "Snapshot was not found" };
      }
      return { status: "unreadable", id, filename, size, modifiedAt, reason: boundedReason(error) };
    }
  }

  read(id: string): SettingsBackupRead {
    return this.inspect(`${id}.json`);
  }

  list(): SettingsBackupListItem[] {
    return this.ownedFilenames()
      .map((filename) => this.inspect(filename))
      .sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0)
        || right.filename.localeCompare(left.filename))
      .slice(0, SETTINGS_BACKUP_LIMITS.listResults)
      .map((entry) => {
        if (entry.status !== "ready") return entry;
        const { snapshot, ...metadata } = entry;
        return {
          ...metadata,
          kind: snapshot.kind,
          createdAt: snapshot.createdAt,
          localDate: snapshot.localDate,
          appVersion: snapshot.appVersion,
          counts: snapshot.counts,
          digest: snapshot.digest,
        };
      });
  }

  private syncRoot(): void {
    const fd = openSync(this.root, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  private prune(): void {
    const byKind = {
      daily: [] as Array<{ filename: string; id: string }>,
      pre_restore: [] as Array<{ filename: string; id: string }>,
    };
    for (const filename of this.ownedFilenames()) {
      const path = this.pathForFilename(filename);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const id = filename.slice(0, -5);
      byKind[id.startsWith("daily-") ? "daily" : "pre_restore"].push({ filename, id });
    }

    for (const kind of ["daily", "pre_restore"] as const) {
      const expired = byKind[kind]
        .sort((left, right) => right.id.localeCompare(left.id))
        .slice(SETTINGS_BACKUP_RETENTION[kind]);
      for (const entry of expired) unlinkSync(this.pathForFilename(entry.filename));
    }
    this.syncRoot();
  }

  write(snapshot: SettingsBackupEnvelopeV1): SettingsBackupRead {
    this.ensureRoot();
    const filename = SettingsBackupFilenameSchema.parse(`${snapshot.id}.json`);
    const target = this.pathForFilename(filename);
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new TypeError("Refusing to replace a non-regular settings backup entry");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }

    validateSettingsBackupDomains(snapshot);
    if (!verifySettingsBackupDigest(snapshot)) throw new TypeError("Refusing snapshot with invalid digest");
    const text = settingsBackupFileText(snapshot);
    if (Buffer.byteLength(text, "utf8") > SETTINGS_BACKUP_LIMITS.fileBytes) {
      throw new RangeError("Settings backup exceeds the file size limit");
    }

    const tempName = `.${filename}.${randomUUID()}.tmp`;
    const tempPath = join(this.root, tempName);
    let tempExists = false;
    try {
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const fd = openSync(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        0o600,
      );
      tempExists = true;
      try {
        writeFileSync(fd, text, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tempPath, 0o600);

      const tempStat = lstatSync(tempPath);
      if (!tempStat.isFile() || tempStat.isSymbolicLink()) {
        throw new TypeError("Temporary settings backup is not a regular file");
      }
      const tempValue = JSON.parse(readFileSync(tempPath, "utf8")) as unknown;
      const tempParsed = inspectSettingsBackupValue(tempValue);
      if (tempParsed.status !== "ready"
        || tempParsed.snapshot.id !== snapshot.id
        || !verifySettingsBackupDigest(tempParsed.snapshot)) {
        throw new TypeError("Temporary settings backup did not verify");
      }
      validateSettingsBackupDomains(tempParsed.snapshot);
      this.hooks.beforeRename?.();

      renameSync(tempPath, target);
      tempExists = false;
      this.syncRoot();
      const verified = this.inspect(filename);
      if (verified.status !== "ready") {
        throw new TypeError(`Published settings backup did not verify: ${verified.reason}`);
      }
      this.prune();
      return verified;
    } finally {
      if (tempExists) {
        try {
          const stat = lstatSync(tempPath);
          if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(tempPath);
        } catch {
          // The exact temp file is already absent or could not be inspected. Never broaden cleanup.
        }
      }
    }
  }
}
