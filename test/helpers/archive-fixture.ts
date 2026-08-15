import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ARCHIVE_FORMAT_VERSION,
  SCOUT_ARCHIVE_FORMAT,
  ARCHIVE_PRIMARY_ARTIFACT_ID,
  ARCHIVE_PRIMARY_REPORT_PATH,
  canonicalArchiveContentPayload,
  archiveKey,
  archiveArtifactId,
  serializeArchiveManifest,
  type ArchiveKind,
  type ArchiveManifest,
  type ArchiveManifestArtifact,
  type ArchiveManifestMissing,
  type ArchiveManifestPromptTrail,
  type ArchiveManifestRepository,
} from "../../src/shared/archives.ts";

/**
 * Build real version 1 scout bundles on disk.
 *
 * Bundles are written the way an external producer would write them - files first, then a
 * manifest whose digests are computed from those bytes - so a test never proves the reader
 * against a manifest the reader itself generated. `manifestJson` is the escape hatch for the
 * cases that matter most: a manifest that lies, a version from the future, a path that
 * escapes.
 */

/** A minimal report that satisfies every version 1 rule. */
export function validReportHtml(body = "The resume path never replayed the repository grant."): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head><meta charset=\"utf-8\"><title>Resume permission loss</title>",
    "<style>body { background: #0a0c0f; color: #e7ebf1; }</style></head>",
    "<body><h1>Resume permission loss</h1>",
    `<p>${body}</p>`,
    "<p><code>src/server/reset.ts:118</code></p>",
    "</body></html>",
  ].join("\n");
}

export interface ScoutBundleSpec {
  kind?: ArchiveKind;
  /**
   * Write the bundle in the LEGACY format string, with no kind field.
   *
   * What every bundle on every machine that predates the kind discriminator looks like, and
   * the only way to prove the read path still accepts one. Never produced by the daemon.
   */
  legacyFormat?: boolean;
  producerId?: string;
  archiveId?: string;
  title?: string;
  question?: string | null;
  prompts?: ArchiveManifestPromptTrail | null;
  summary?: string | null;
  tags?: string[];
  captureStatus?: "complete" | "partial";
  createdAt?: string;
  completedAt?: string | null;
  producerLabel?: string | null;
  agent?: string | null;
  model?: string | null;
  source?: string | null;
  repositories?: ArchiveManifestRepository[];
  /** `null` writes no report at all - a partial archive. */
  reportHtml?: string | null;
  /** Extra files beside the report, keyed by their path within `report/`. */
  companions?: Record<string, string>;
  /** Explicit supporting files, keyed by their path within `artifacts/`. */
  supporting?: Record<string, string>;
  missing?: ArchiveManifestMissing[];
  /** Rewrite the manifest before it is written, to forge or damage one. */
  manifestJson?: (manifest: Record<string, unknown>) => unknown;
  /** Skip writing named archive paths, leaving the manifest claiming them. */
  omitFiles?: string[];
}

export interface WrittenScoutBundle {
  producerId: string;
  archiveId: string;
  key: string;
  dir: string;
  manifest: ArchiveManifest;
}

/**
 * The same manifest as an older build would have written it: the legacy `format` string and
 * no `kind` field at all. Deliberately built by REWRITING the current serializer's output
 * rather than by keeping a second serializer, so a field added inside version 1 shows up in
 * both and the legacy vector cannot quietly drift into a shape nothing ever wrote.
 */
function legacyManifestJson(manifest: ArchiveManifest): string {
  const body = JSON.parse(serializeArchiveManifest(manifest)) as Record<string, unknown>;
  body.format = SCOUT_ARCHIVE_FORMAT;
  delete body.kind;
  return `${JSON.stringify(body, null, 2)}\n`;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function write(root: string, relative: string, contents: string | Buffer): Buffer {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  writeFileSync(target, bytes);
  return bytes;
}

/** Write one bundle under `<libraryRoot>/<producer>/<archive>/` and return where it landed. */
export function writeScoutBundle(libraryRoot: string, spec: ScoutBundleSpec = {}): WrittenScoutBundle {
  const producerId = spec.producerId ?? randomUUID();
  const archiveId = spec.archiveId ?? randomUUID();
  const dir = join(libraryRoot, producerId, archiveId);
  mkdirSync(dir, { recursive: true });
  const omit = new Set(spec.omitFiles ?? []);

  const artifacts: ArchiveManifestArtifact[] = [];
  const reportHtml = spec.reportHtml === undefined ? validReportHtml() : spec.reportHtml;
  if (reportHtml !== null) {
    const bytes = omit.has(ARCHIVE_PRIMARY_REPORT_PATH)
      ? Buffer.from(reportHtml, "utf8")
      : write(dir, ARCHIVE_PRIMARY_REPORT_PATH, reportHtml);
    artifacts.push({
      id: ARCHIVE_PRIMARY_ARTIFACT_ID,
      role: "primary_report",
      repoSlot: spec.repositories?.[0]?.slot ?? null,
      originalPath: "docs/reports/resume-permissions/report.html",
      archivePath: ARCHIVE_PRIMARY_REPORT_PATH,
      mediaType: "text/html",
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }

  let ordinal = 0;
  for (const [relative, contents] of Object.entries(spec.companions ?? {})) {
    ordinal += 1;
    const archivePath = `report/${relative}`;
    const bytes = omit.has(archivePath)
      ? Buffer.from(contents, "utf8")
      : write(dir, archivePath, contents);
    artifacts.push({
      id: archiveArtifactId(ordinal),
      role: "report_companion",
      repoSlot: spec.repositories?.[0]?.slot ?? null,
      originalPath: `docs/reports/resume-permissions/${relative}`,
      archivePath,
      mediaType: null,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  for (const [relative, contents] of Object.entries(spec.supporting ?? {})) {
    ordinal += 1;
    const archivePath = `artifacts/${relative}`;
    const bytes = omit.has(archivePath)
      ? Buffer.from(contents, "utf8")
      : write(dir, archivePath, contents);
    artifacts.push({
      id: archiveArtifactId(ordinal),
      role: "supporting",
      repoSlot: relative.split("/")[0] ?? null,
      originalPath: relative.split("/").slice(1).join("/"),
      archivePath,
      mediaType: null,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }

  const manifest: ArchiveManifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    kind: spec.kind ?? "scout",
    producer: { id: producerId, label: spec.producerLabel ?? "a test machine" },
    archive: {
      id: archiveId,
      createdAt: spec.createdAt ?? "2026-08-12T18:42:11.000Z",
      completedAt: spec.completedAt === undefined ? "2026-08-12T18:50:03.000Z" : spec.completedAt,
      captureStatus: spec.captureStatus ?? (reportHtml === null ? "partial" : "complete"),
      title: spec.title ?? "Resume permission loss",
      question: spec.question === undefined ? "Why did a resumed agent lose repository permissions?" : spec.question,
      prompts: spec.prompts ?? null,
      summary:
        spec.summary === undefined ? "Resume rebuilt the session without replaying the grant." : spec.summary,
      tags: spec.tags ?? ["permissions", "resume"],
    },
    origin: {
      agent: spec.agent === undefined ? "codex" : spec.agent,
      model: spec.model === undefined ? "gpt-5.6" : spec.model,
      source: spec.source === undefined ? "manual" : spec.source,
      repositories: spec.repositories ?? [
        { slot: "repo-01", label: "mission-control", head: "4cc55a1d69bb7f843881001643c76185f5c7db1a" },
      ],
    },
    primaryArtifactId: reportHtml === null ? null : ARCHIVE_PRIMARY_ARTIFACT_ID,
    artifacts,
    missing:
      spec.missing ??
      (reportHtml === null
        ? [
            {
              kind: "primary_report",
              expectedSource: "docs/reports/<slug>/report.html",
              reason: "the session ended before a report was submitted",
            },
          ]
        : []),
    contentDigest: `sha256:${createHash("sha256").update(canonicalArchiveContentPayload(artifacts)).digest("hex")}`,
  };

  const serialized = spec.legacyFormat
    ? legacyManifestJson(manifest)
    : serializeArchiveManifest(manifest);
  const body = spec.manifestJson
    ? `${JSON.stringify(spec.manifestJson(JSON.parse(serialized) as Record<string, unknown>), null, 2)}\n`
    : serialized;
  writeFileSync(join(dir, "manifest.json"), body, "utf8");

  return { producerId, archiveId, key: archiveKey(producerId, archiveId), dir, manifest };
}
