import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SCOUT_ARCHIVE_FORMAT_VERSION,
  SCOUT_PRIMARY_ARTIFACT_ID,
  SCOUT_PRIMARY_REPORT_PATH,
  canonicalScoutContentPayload,
  scoutArchiveKey,
  scoutArtifactId,
  serializeScoutManifest,
  type ScoutManifest,
  type ScoutManifestArtifact,
  type ScoutManifestMissing,
  type ScoutManifestRepository,
} from "../../src/shared/scouts.ts";

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
  producerId?: string;
  archiveId?: string;
  title?: string;
  question?: string | null;
  summary?: string | null;
  tags?: string[];
  captureStatus?: "complete" | "partial";
  createdAt?: string;
  completedAt?: string | null;
  producerLabel?: string | null;
  agent?: string | null;
  model?: string | null;
  source?: string | null;
  repositories?: ScoutManifestRepository[];
  /** `null` writes no report at all - a partial archive. */
  reportHtml?: string | null;
  /** Extra files beside the report, keyed by their path within `report/`. */
  companions?: Record<string, string>;
  /** Explicit supporting files, keyed by their path within `artifacts/`. */
  supporting?: Record<string, string>;
  missing?: ScoutManifestMissing[];
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
  manifest: ScoutManifest;
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

  const artifacts: ScoutManifestArtifact[] = [];
  const reportHtml = spec.reportHtml === undefined ? validReportHtml() : spec.reportHtml;
  if (reportHtml !== null) {
    const bytes = omit.has(SCOUT_PRIMARY_REPORT_PATH)
      ? Buffer.from(reportHtml, "utf8")
      : write(dir, SCOUT_PRIMARY_REPORT_PATH, reportHtml);
    artifacts.push({
      id: SCOUT_PRIMARY_ARTIFACT_ID,
      role: "primary_report",
      repoSlot: spec.repositories?.[0]?.slot ?? null,
      originalPath: "docs/reports/resume-permissions/report.html",
      archivePath: SCOUT_PRIMARY_REPORT_PATH,
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
      id: scoutArtifactId(ordinal),
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
      id: scoutArtifactId(ordinal),
      role: "supporting",
      repoSlot: relative.split("/")[0] ?? null,
      originalPath: relative.split("/").slice(1).join("/"),
      archivePath,
      mediaType: null,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }

  const manifest: ScoutManifest = {
    formatVersion: SCOUT_ARCHIVE_FORMAT_VERSION,
    producer: { id: producerId, label: spec.producerLabel ?? "a test machine" },
    archive: {
      id: archiveId,
      createdAt: spec.createdAt ?? "2026-08-12T18:42:11.000Z",
      completedAt: spec.completedAt === undefined ? "2026-08-12T18:50:03.000Z" : spec.completedAt,
      captureStatus: spec.captureStatus ?? (reportHtml === null ? "partial" : "complete"),
      title: spec.title ?? "Resume permission loss",
      question: spec.question === undefined ? "Why did a resumed agent lose repository permissions?" : spec.question,
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
    primaryArtifactId: reportHtml === null ? null : SCOUT_PRIMARY_ARTIFACT_ID,
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
    contentDigest: `sha256:${createHash("sha256").update(canonicalScoutContentPayload(artifacts)).digest("hex")}`,
  };

  const serialized = serializeScoutManifest(manifest);
  const body = spec.manifestJson
    ? `${JSON.stringify(spec.manifestJson(JSON.parse(serialized) as Record<string, unknown>), null, 2)}\n`
    : serialized;
  writeFileSync(join(dir, "manifest.json"), body, "utf8");

  return { producerId, archiveId, key: scoutArchiveKey(producerId, archiveId), dir, manifest };
}
