import type { DatabaseSync } from "node:sqlite";
import {
  SCOUT_SEARCH_LIMITS,
  SCOUT_TEXT_LIMITS,
  encodeScoutCursor,
  scoutArchiveKey,
  type ScoutArchiveIdentity,
  type ScoutArtifactRole,
  type ScoutArtifactView,
  type ScoutIndexStatus,
  type ScoutListCursor,
  type ScoutManifestMissing,
  type ScoutManifestRepository,
  type ScoutSearchQuery,
  type ScoutSearchSegmentKind,
  type ScoutSearchSnippet,
} from "@shared/scouts.ts";
import { openDb } from "../db.ts";
import { mediaTypeForArchivePath } from "./paths.ts";
import type { ScoutBundleFingerprint, VerifiedScoutBundle } from "./bundle.ts";

/**
 * The derived scout index: row parsing, transactions, and bounded queries.
 *
 * Durable-row mechanics only, on the shape `ensembles/store.ts` set - the policy that
 * decides WHEN to write lives in the reconciler and the manager. Everything in these three
 * tables is a projection of a bundle directory, so every write is a whole-archive replace
 * rather than a field update: there is no partial state worth preserving, and a replace is
 * what makes indexing idempotent when the same pass runs twice.
 */

/** One row of the index as the rest of the daemon reads it. */
export interface ScoutArchiveRow {
  key: string;
  producerId: string;
  archiveId: string;
  producerLabel: string | null;
  formatVersion: number;
  status: ScoutIndexStatus;
  captureStatus: "complete" | "partial" | null;
  title: string;
  question: string | null;
  summary: string | null;
  tags: string[];
  agent: string | null;
  model: string | null;
  source: string | null;
  repositories: ScoutManifestRepository[];
  missing: ScoutManifestMissing[];
  primaryArtifactId: string | null;
  contentDigest: string | null;
  manifestDigest: string;
  relativePath: string;
  fingerprint: ScoutBundleFingerprint;
  artifactCount: number;
  bytes: number;
  error: string | null;
  createdAt: number | null;
  completedAt: number | null;
  sortAt: number;
  indexedAt: number;
}

/** What a pass needs to decide "unchanged" without opening anything. */
export interface ScoutIndexedFingerprint {
  key: string;
  relativePath: string;
  fingerprint: ScoutBundleFingerprint;
  manifestDigest: string;
  status: ScoutIndexStatus;
}

/** An unreadable bundle: everything we could learn, plus one safe sentence about why not. */
export interface ScoutUnreadableInput {
  identity: ScoutArchiveIdentity;
  relativePath: string;
  fingerprint: ScoutBundleFingerprint;
  reason: string;
  formatVersion: number | null;
  /**
   * The last manifest digest this build was willing to vouch for, when there is one.
   *
   * Only an immutable-key conflict sets it, and it carries the ORIGINAL digest rather than
   * the one that replaced it. That is what makes the refusal stick: with an empty value the
   * next pass has nothing to compare against, so a second rewrite is adopted as if it were a
   * first sighting. Empty for every other kind of refusal, so a bundle that is merely damaged
   * can become readable again once it is fixed.
   */
  manifestDigest?: string;
  indexedAt: number;
  epoch: number;
}

interface ArchiveRowShape {
  key: string;
  producer_id: string;
  archive_id: string;
  producer_label: string | null;
  format_version: number;
  status: string;
  capture_status: string | null;
  title: string;
  question: string | null;
  summary: string | null;
  tags_json: string | null;
  agent: string | null;
  model: string | null;
  source: string | null;
  repositories_json: string | null;
  repo_labels: string;
  missing_json: string | null;
  primary_artifact_id: string | null;
  content_digest: string | null;
  manifest_digest: string;
  relative_path: string;
  manifest_bytes: number;
  manifest_mtime_ns: string;
  artifact_count: number;
  bytes: number;
  error: string | null;
  created_at: number | null;
  completed_at: number | null;
  sort_at: number;
  indexed_at: number;
  last_seen_epoch: number;
}

interface ArtifactRowShape {
  key: string;
  artifact_id: string;
  ordinal: number;
  role: string;
  repo_slot: string | null;
  original_path: string | null;
  archive_path: string;
  media_type: string;
  bytes: number;
  sha256: string;
}

const ARCHIVE_COLUMNS = `key, producer_id, archive_id, producer_label, format_version, status,
  capture_status, title, question, summary, tags_json, agent, model, source, repositories_json,
  repo_labels, missing_json, primary_artifact_id, content_digest, manifest_digest, relative_path,
  manifest_bytes, manifest_mtime_ns, artifact_count, bytes, error, created_at, completed_at, sort_at,
  indexed_at, last_seen_epoch`;

const ARCHIVE_PLACEHOLDERS = ARCHIVE_COLUMNS.split(",").map(() => "?").join(", ");

export class ScoutStore {
  constructor(private readonly db: DatabaseSync = openDb()) {}

  /** Run `fn` in a transaction, joining one already in progress rather than nesting. */
  private inTransaction<T>(fn: () => T): T {
    const owns = !this.db.isTransaction;
    if (owns) this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      if (owns) this.db.exec("COMMIT");
      return out;
    } catch (err) {
      if (owns && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Replace every derived row for one verified bundle, in one transaction.
   *
   * A replace rather than an update because the bundle is the whole truth: an archive whose
   * artifact list shrank must not keep the row for a file that is no longer declared, and
   * reasoning about which of three tables to patch is how that happens.
   */
  replaceArchive(bundle: VerifiedScoutBundle, indexedAt: number, epoch: number): void {
    const manifest = bundle.manifest;
    const createdAt = instant(manifest.archive.createdAt);
    const completedAt = instant(manifest.archive.completedAt);
    // The pipe is the delimiter, so a label containing one could otherwise forge a match for
    // a repository this archive never touched (`a|b` matching a filter for `b`). Foreign
    // manifests choose these strings, so the separator is removed rather than trusted.
    const repoLabels = manifest.origin.repositories
      .map((repository) => repository.label?.trim().toLowerCase().replaceAll("|", " "))
      .filter((label): label is string => Boolean(label));
    this.inTransaction(() => {
      this.clearRows(bundle.key);
      this.db.prepare(`INSERT INTO scout_archives (${ARCHIVE_COLUMNS}) VALUES (${ARCHIVE_PLACEHOLDERS})`).run(
        bundle.key,
        bundle.identity.producerId,
        bundle.identity.archiveId,
        clip(manifest.producer.label, SCOUT_TEXT_LIMITS.label),
        manifest.formatVersion,
        bundle.status,
        manifest.archive.captureStatus,
        clip(manifest.archive.title, SCOUT_TEXT_LIMITS.title) ?? "",
        clip(manifest.archive.question, SCOUT_TEXT_LIMITS.question),
        clip(manifest.archive.summary, SCOUT_TEXT_LIMITS.summary),
        manifest.archive.tags.length > 0 ? JSON.stringify(manifest.archive.tags) : null,
        clip(manifest.origin.agent, SCOUT_TEXT_LIMITS.label),
        clip(manifest.origin.model, SCOUT_TEXT_LIMITS.label),
        clip(manifest.origin.source, SCOUT_TEXT_LIMITS.label),
        manifest.origin.repositories.length > 0 ? JSON.stringify(manifest.origin.repositories) : null,
        repoLabels.length > 0 ? `|${repoLabels.join("|")}|` : "",
        manifest.missing.length > 0 ? JSON.stringify(manifest.missing) : null,
        manifest.primaryArtifactId,
        manifest.contentDigest,
        bundle.manifestDigest,
        bundle.relativePath,
        bundle.fingerprint.manifestBytes,
        bundle.fingerprint.manifestMtimeNs,
        manifest.artifacts.length,
        bundle.contentBytes,
        null,
        createdAt,
        completedAt,
        completedAt ?? createdAt ?? indexedAt,
        indexedAt,
        epoch,
      );
      const insertArtifact = this.db.prepare(
        `INSERT INTO scout_artifacts
           (key, artifact_id, ordinal, role, repo_slot, original_path, archive_path, media_type, bytes, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      manifest.artifacts.forEach((artifact, index) => {
        insertArtifact.run(
          bundle.key,
          artifact.id,
          index,
          artifact.role,
          artifact.repoSlot,
          artifact.originalPath,
          artifact.archivePath,
          mediaTypeForArchivePath(artifact.archivePath),
          artifact.bytes,
          artifact.sha256,
        );
      });
      this.writeSegments(bundle.key, searchSegments(bundle));
    });
  }

  /**
   * Record a bundle this build refuses, so the operator can see that it exists.
   *
   * Listed rather than hidden: a directory that is present and unreadable is a fact worth
   * showing - it might be from a newer Mission Control, or it might be damaged - and a
   * library that silently omitted it would read as evidence that never arrived.
   */
  replaceUnreadable(input: ScoutUnreadableInput): void {
    const key = scoutArchiveKey(input.identity.producerId, input.identity.archiveId);
    this.inTransaction(() => {
      this.clearRows(key);
      this.db.prepare(`INSERT INTO scout_archives (${ARCHIVE_COLUMNS}) VALUES (${ARCHIVE_PLACEHOLDERS})`).run(
        key,
        input.identity.producerId,
        input.identity.archiveId,
        null,
        input.formatVersion ?? 0,
        "unreadable",
        null,
        "",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "",
        null,
        null,
        null,
        input.manifestDigest ?? "",
        input.relativePath,
        input.fingerprint.manifestBytes,
        input.fingerprint.manifestMtimeNs,
        0,
        0,
        clip(input.reason, SCOUT_TEXT_LIMITS.error),
        null,
        null,
        input.indexedAt,
        input.indexedAt,
        input.epoch,
      );
    });
  }

  /** Mark an unchanged archive as still present in this pass. */
  markSeen(key: string, epoch: number): void {
    this.db.prepare(`UPDATE scout_archives SET last_seen_epoch = ? WHERE key = ?`).run(epoch, key);
  }

  /** Every indexed bundle's fingerprint, for the "has anything changed?" comparison. */
  fingerprints(): ScoutIndexedFingerprint[] {
    const rows = this.db
      .prepare(
        `SELECT key, relative_path, manifest_bytes, manifest_mtime_ns, manifest_digest, status
           FROM scout_archives`,
      )
      .all() as unknown as Array<{
      key: string;
      relative_path: string;
      manifest_bytes: number;
      manifest_mtime_ns: string;
      manifest_digest: string;
      status: string;
    }>;
    return rows.map((row) => ({
      key: row.key,
      relativePath: row.relative_path,
      fingerprint: {
        manifestBytes: row.manifest_bytes,
        manifestMtimeNs: row.manifest_mtime_ns,
      },
      manifestDigest: row.manifest_digest,
      status: readStatus(row.status),
    }));
  }

  /**
   * Drop every archive not observed by the pass that just finished, returning their keys.
   *
   * Only ever called after a COMPLETE walk. A pass that threw halfway would otherwise prune
   * the producers it never reached, and an external sync tool that had merely not finished
   * writing would look like a deletion.
   */
  pruneUnseen(epoch: number): string[] {
    return this.inTransaction(() => {
      const stale = (
        this.db.prepare(`SELECT key FROM scout_archives WHERE last_seen_epoch < ?`).all(epoch) as unknown as Array<{
          key: string;
        }>
      ).map((row) => row.key);
      for (const key of stale) this.clearRows(key);
      return stale;
    });
  }

  /** Remove every row for one archive. Used by deletion and by pruning. */
  remove(key: string): boolean {
    return this.inTransaction(() => {
      const existed = this.get(key) !== null;
      this.clearRows(key);
      return existed;
    });
  }

  get(key: string): ScoutArchiveRow | null {
    const row = this.db.prepare(`SELECT * FROM scout_archives WHERE key = ?`).get(key) as unknown as
      | ArchiveRowShape
      | undefined;
    return row ? rowToArchive(row) : null;
  }

  artifacts(key: string): ScoutArtifactView[] {
    const rows = this.db
      .prepare(`SELECT * FROM scout_artifacts WHERE key = ? ORDER BY ordinal`)
      .all(key) as unknown as ArtifactRowShape[];
    return rows.map(rowToArtifact);
  }

  artifact(key: string, artifactId: string): ScoutArtifactView | null {
    const row = this.db
      .prepare(`SELECT * FROM scout_artifacts WHERE key = ? AND artifact_id = ?`)
      .get(key, artifactId) as unknown as ArtifactRowShape | undefined;
    return row ? rowToArtifact(row) : null;
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM scout_archives`).get() as unknown as {
      n: number;
    };
    return row.n;
  }

  /**
   * One bounded page of archives, newest first.
   *
   * Keyset pagination on `(sort_at, key)` rather than OFFSET: the library changes underneath
   * a reader whenever the reconciler commits, and an offset page would then repeat or skip
   * rows. Both halves of the key are compared so archives sharing a completion millisecond
   * still have a total order.
   *
   * Search is a literal, case-folded substring scan over the bounded segment table. No
   * ranking, no stemming, and no HTML parsing at query time - the parse happened once, at
   * index time, and a query that reopened report files would make search cost grow with the
   * whole library.
   */
  list(query: Omit<ScoutSearchQuery, "cursor"> & { cursor: ScoutListCursor | null }): {
    rows: ScoutArchiveRow[];
    nextCursor: string | null;
  } {
    const limit = Math.min(Math.max(1, Math.floor(query.limit)), SCOUT_SEARCH_LIMITS.maxLimit);
    const where: string[] = [];
    const params: Array<string | number> = [];
    const needle = foldNeedle(query.q);
    if (needle) {
      where.push(
        `EXISTS (SELECT 1 FROM scout_search_segments s WHERE s.key = a.key AND instr(s.text_fold, ?) > 0)`,
      );
      params.push(needle);
    }
    if (query.producer) {
      where.push(`a.producer_id = ?`);
      params.push(query.producer);
    }
    if (query.repo) {
      where.push(`instr(a.repo_labels, ?) > 0`);
      params.push(`|${query.repo.trim().toLowerCase().replaceAll("|", " ")}|`);
    }
    if (query.agent) {
      where.push(`a.agent = ?`);
      params.push(query.agent);
    }
    if (query.status) {
      where.push(`a.status = ?`);
      params.push(query.status);
    }
    if (query.from !== null) {
      where.push(`a.sort_at >= ?`);
      params.push(query.from);
    }
    if (query.to !== null) {
      where.push(`a.sort_at <= ?`);
      params.push(query.to);
    }
    const cursor = query.cursor;
    if (cursor) {
      where.push(`(a.sort_at < ? OR (a.sort_at = ? AND a.key < ?))`);
      params.push(cursor.sortAt, cursor.sortAt, cursor.key);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT a.* FROM scout_archives a ${clause} ORDER BY a.sort_at DESC, a.key DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as unknown as ArchiveRowShape[];
    const page = rows.slice(0, limit).map(rowToArchive);
    const nextCursor =
      rows.length > limit && page.length > 0
        ? encodeScoutCursor({ sortAt: page[page.length - 1]!.sortAt, key: page[page.length - 1]!.key })
        : null;
    return { rows: page, nextCursor };
  }

  /** The first segment of one archive that contains the needle, for a result snippet. */
  snippet(key: string, rawQuery: string | null): ScoutSearchSnippet | null {
    const needle = foldNeedle(rawQuery);
    if (!needle) return null;
    const row = this.db
      .prepare(
        `SELECT source_kind, text FROM scout_search_segments
          WHERE key = ? AND instr(text_fold, ?) > 0 ORDER BY ordinal LIMIT 1`,
      )
      .get(key, needle) as unknown as { source_kind: string; text: string } | undefined;
    if (!row) return null;
    return {
      kind: readSegmentKind(row.source_kind),
      text: cutSnippet(row.text, needle, SCOUT_TEXT_LIMITS.snippet),
    };
  }

  private clearRows(key: string): void {
    this.db.prepare(`DELETE FROM scout_search_segments WHERE key = ?`).run(key);
    this.db.prepare(`DELETE FROM scout_artifacts WHERE key = ?`).run(key);
    this.db.prepare(`DELETE FROM scout_archives WHERE key = ?`).run(key);
  }

  private writeSegments(key: string, segments: Array<{ kind: ScoutSearchSegmentKind; text: string }>): void {
    const insert = this.db.prepare(
      `INSERT INTO scout_search_segments (key, ordinal, source_kind, text, text_fold) VALUES (?, ?, ?, ?, ?)`,
    );
    segments.forEach((segment, index) => {
      insert.run(key, index, segment.kind, segment.text, segment.text.toLowerCase());
    });
  }
}

/**
 * Everything about one bundle a literal search may match, as bounded segments.
 *
 * The report's visible text is split into fixed-size chunks rather than stored whole so one
 * row stays small enough to be a useful snippet source, and so a long report cannot make a
 * single row dominate the table. Chunks OVERLAP by a snippet's width, which is what stops a
 * phrase that straddles a boundary from being unfindable.
 */
function searchSegments(bundle: VerifiedScoutBundle): Array<{ kind: ScoutSearchSegmentKind; text: string }> {
  const manifest = bundle.manifest;
  const segments: Array<{ kind: ScoutSearchSegmentKind; text: string }> = [];
  const push = (kind: ScoutSearchSegmentKind, text: string | null): void => {
    const trimmed = text?.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    segments.push({ kind, text: trimmed.slice(0, SCOUT_TEXT_LIMITS.segment) });
  };
  push("title", manifest.archive.title);
  push("question", manifest.archive.question);
  push("summary", manifest.archive.summary);
  for (const tag of manifest.archive.tags) push("tag", tag);
  push("provenance", manifest.origin.agent);
  push("provenance", manifest.origin.model);
  push("provenance", manifest.origin.source);
  push("provenance", manifest.producer.label);
  for (const repository of manifest.origin.repositories) push("provenance", repository.label);
  for (const artifact of manifest.artifacts) {
    push("artifact_path", artifact.originalPath ?? artifact.archivePath);
    if (artifact.originalPath) push("artifact_path", artifact.archivePath);
  }
  const overlap = SCOUT_TEXT_LIMITS.snippet;
  const stride = SCOUT_TEXT_LIMITS.segment - overlap;
  for (let start = 0; start < bundle.reportText.length; start += stride) {
    push("report_text", bundle.reportText.slice(start, start + SCOUT_TEXT_LIMITS.segment));
    if (start + SCOUT_TEXT_LIMITS.segment >= bundle.reportText.length) break;
  }
  return segments;
}

function foldNeedle(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, SCOUT_SEARCH_LIMITS.queryChars);
  return trimmed === "" ? null : trimmed.toLowerCase();
}

/** A window of `text` around the first match, with ellipses when it was cut. */
function cutSnippet(text: string, needle: string, width: number): string {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text.slice(0, width);
  const lead = Math.max(0, at - Math.floor((width - needle.length) / 2));
  const slice = text.slice(lead, lead + width);
  return `${lead > 0 ? "…" : ""}${slice}${lead + width < text.length ? "…" : ""}`;
}

function rowToArchive(row: ArchiveRowShape): ScoutArchiveRow {
  return {
    key: row.key,
    producerId: row.producer_id,
    archiveId: row.archive_id,
    producerLabel: row.producer_label,
    formatVersion: row.format_version,
    status: readStatus(row.status),
    captureStatus: row.capture_status === "complete" || row.capture_status === "partial" ? row.capture_status : null,
    title: row.title,
    question: row.question,
    summary: row.summary,
    tags: parseJsonArray<string>(row.tags_json) ?? [],
    agent: row.agent,
    model: row.model,
    source: row.source,
    repositories: parseJsonArray<ScoutManifestRepository>(row.repositories_json) ?? [],
    missing: parseJsonArray<ScoutManifestMissing>(row.missing_json) ?? [],
    primaryArtifactId: row.primary_artifact_id,
    contentDigest: row.content_digest,
    manifestDigest: row.manifest_digest,
    relativePath: row.relative_path,
    fingerprint: { manifestBytes: row.manifest_bytes, manifestMtimeNs: row.manifest_mtime_ns },
    artifactCount: row.artifact_count,
    bytes: row.bytes,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    sortAt: row.sort_at,
    indexedAt: row.indexed_at,
  };
}

function rowToArtifact(row: ArtifactRowShape): ScoutArtifactView {
  return {
    id: row.artifact_id,
    role: readRole(row.role),
    repoSlot: row.repo_slot,
    originalPath: row.original_path,
    archivePath: row.archive_path,
    mediaType: row.media_type,
    bytes: row.bytes,
    sha256: row.sha256,
  };
}

/**
 * A persisted status this build does not know reads as `unreadable`, never as ready.
 *
 * A newer build could write a status this one has never heard of. Defaulting to the
 * permissive end would present an archive as complete on the word of a value we cannot
 * interpret; defaulting to `unreadable` says exactly what is true - this build cannot vouch
 * for the row - and the reconciler re-derives it from the bundle on its next pass anyway.
 */
function readStatus(raw: string): ScoutIndexStatus {
  return raw === "ready" || raw === "partial" ? raw : "unreadable";
}

function readRole(raw: string): ScoutArtifactRole {
  return raw === "primary_report" || raw === "report_companion" ? raw : "supporting";
}

function readSegmentKind(raw: string): ScoutSearchSegmentKind {
  switch (raw) {
    case "title":
    case "question":
    case "summary":
    case "tag":
    case "provenance":
    case "report_text":
    case "artifact_path":
      return raw;
    default:
      return "provenance";
  }
}

function parseJsonArray<T>(raw: string | null): T[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/** An ISO instant from a manifest as epoch ms, or null when it is not one. */
function instant(raw: string | null): number | null {
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

/** Drop every scout row. For tests that need a clean index between cases. */
export function clearScoutTables(db: DatabaseSync): void {
  db.exec("DELETE FROM scout_search_segments; DELETE FROM scout_artifacts; DELETE FROM scout_archives;");
}
