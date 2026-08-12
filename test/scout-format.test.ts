import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SCOUT_ARCHIVE_FORMAT,
  SCOUT_ARCHIVE_FORMAT_VERSION,
  SCOUT_ARCHIVE_FORMAT_VERSIONS,
  SCOUT_ARTIFACT_ROLES,
  SCOUT_CAPTURE_STATUSES,
  SCOUT_INDEX_STATUSES,
  SCOUT_LIMITS,
  SCOUT_MISSING_KINDS,
  SCOUT_SEARCH_SEGMENT_KINDS,
  canonicalScoutContentPayload,
  decodeScoutCursor,
  encodeScoutCursor,
  isScoutId,
  parseScoutArchiveKey,
  parseScoutManifest,
  scoutArchiveKey,
  scoutArtifactId,
  scoutRepoSlot,
  serializeScoutManifest,
  validateScoutArchivePath,
} from "../src/shared/scouts.ts";

/**
 * The portable format, tested with no filesystem and no daemon.
 *
 * That is the point of the split: everything here is decidable from a manifest value alone,
 * so another implementation - or another language - can be held to the same rules using the
 * committed golden vectors without running Mission Control.
 */

const PRODUCER = "7aa704fd-d2ab-48b3-a726-0c2643ed91d2";
const ARCHIVE = "9f5db6c8-79f5-4f9e-84aa-8b5dc15362f8";
const HEX = "a".repeat(64);

function manifestValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const artifacts = [
    {
      id: "report",
      role: "primary_report",
      repo_slot: "repo-01",
      original_path: "docs/reports/resume/report.html",
      archive_path: "report/report.html",
      media_type: "text/html",
      bytes: 12,
      sha256: `sha256:${HEX}`,
    },
  ];
  return {
    format: SCOUT_ARCHIVE_FORMAT,
    format_version: 1,
    producer: { id: PRODUCER, label: "Avery's laptop" },
    archive: {
      id: ARCHIVE,
      created_at: "2026-08-12T18:42:11.000Z",
      completed_at: "2026-08-12T18:50:03.000Z",
      capture_status: "complete",
      title: "Resume permission loss",
      question: "Why did a resumed agent lose repository permissions?",
      summary: "Resume rebuilt the session without replaying the grant.",
      tags: ["permissions", "resume"],
    },
    origin: {
      agent: "codex",
      model: "gpt-5.6",
      source: "manual",
      repositories: [{ slot: "repo-01", label: "mission-control", head: "4cc55a1d" }],
    },
    content: { primary_artifact_id: "report", artifacts },
    missing: [],
    content_digest: `sha256:${createHash("sha256")
      .update(
        canonicalScoutContentPayload(
          artifacts.map((a) => ({ archivePath: a.archive_path, bytes: a.bytes, sha256: a.sha256 })),
        ),
      )
      .digest("hex")}`,
    ...overrides,
  };
}

test("a representative version 1 manifest parses into its camelCase form", () => {
  const parsed = parseScoutManifest(manifestValue());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.manifest.formatVersion, 1);
  assert.equal(parsed.manifest.producer.id, PRODUCER);
  assert.equal(parsed.manifest.archive.captureStatus, "complete");
  assert.deepEqual(parsed.manifest.archive.tags, ["permissions", "resume"]);
  assert.equal(parsed.manifest.primaryArtifactId, "report");
  assert.equal(parsed.manifest.artifacts[0]?.archivePath, "report/report.html");
  assert.equal(parsed.manifest.origin.repositories[0]?.label, "mission-control");
});

test("a manifest round-trips through serialization without changing meaning", () => {
  const parsed = parseScoutManifest(manifestValue());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const text = serializeScoutManifest(parsed.manifest);
  assert.ok(text.endsWith("\n"), "the manifest ends with a newline");
  assert.ok(text.includes('\n  "format_version": 1'), "it is pretty-printed with two spaces");
  const again = parseScoutManifest(JSON.parse(text));
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual(again.manifest, parsed.manifest);
});

test("unknown fields are ignored inside a known version rather than refused", () => {
  const value = manifestValue({ vendor_notes: { anything: true } });
  (value.archive as Record<string, unknown>).future_field = "a newer build wrote this";
  const parsed = parseScoutManifest(value);
  assert.equal(parsed.ok, true, "a newer build's extra fields must not make a bundle unreadable");
  if (!parsed.ok) return;
  assert.equal(
    "future_field" in (parsed.manifest.archive as unknown as Record<string, unknown>),
    false,
    "an unknown field must not reach the parsed manifest, where something could act on it",
  );
});

test("an unsupported format version is its own answer, not a schema failure", () => {
  const parsed = parseScoutManifest(manifestValue({ format_version: 2 }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, "unsupported_version");
  assert.equal(parsed.formatVersion, 2);
  assert.match(parsed.reason, /newer than this build/);
});

test("a value that is not a scout archive is refused before its shape is read", () => {
  assert.equal(parseScoutManifest(null).ok, false);
  assert.equal(parseScoutManifest([]).ok, false);
  const wrong = parseScoutManifest(manifestValue({ format: "something/else" }));
  assert.equal(wrong.ok, false);
  if (wrong.ok) return;
  assert.equal(wrong.problem, "wrong_format");
});

test("identity components must be generated UUIDs", () => {
  for (const [key, value] of [
    ["producer", { id: "../../etc", label: null }],
    ["archive-id", null],
  ] as const) {
    const overrides =
      key === "producer"
        ? { producer: value }
        : { archive: { ...(manifestValue().archive as object), id: "not-a-uuid" } };
    const parsed = parseScoutManifest(manifestValue(overrides as Record<string, unknown>));
    assert.equal(parsed.ok, false, `${key} must be refused`);
  }
});

test("only report/report.html may be the primary artifact of a complete archive", () => {
  const value = manifestValue();
  const artifacts = (value.content as { artifacts: Array<Record<string, unknown>> }).artifacts;
  artifacts[0]!.archive_path = "report/summary.html";
  const parsed = parseScoutManifest(value);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, "primary_report");
  assert.match(parsed.reason, /report\/report\.html/);
});

test("a complete archive without a primary report is refused; a partial one explains itself", () => {
  const empty = manifestValue({ content: { primary_artifact_id: null, artifacts: [] } });
  empty.content_digest = `sha256:${createHash("sha256").update("").digest("hex")}`;
  const complete = parseScoutManifest({ ...empty });
  assert.equal(complete.ok, false, "a complete archive must have a report");

  const partialNoReason = parseScoutManifest({
    ...empty,
    archive: { ...(empty.archive as object), capture_status: "partial" },
  });
  assert.equal(partialNoReason.ok, false, "a partial archive with no report must say why");

  const partial = parseScoutManifest({
    ...empty,
    archive: { ...(empty.archive as object), capture_status: "partial" },
    missing: [
      { kind: "primary_report", expected_source: "docs/reports/x/report.html", reason: "never submitted" },
    ],
  });
  assert.equal(partial.ok, true);
  if (!partial.ok) return;
  assert.equal(partial.manifest.primaryArtifactId, null);
  assert.equal(partial.manifest.missing[0]?.kind, "primary_report");
});

test("two artifacts may not claim one id or one path", () => {
  const withDuplicateId = manifestValue();
  const artifacts = (withDuplicateId.content as { artifacts: Array<Record<string, unknown>> }).artifacts;
  artifacts.push({ ...artifacts[0]!, archive_path: "report/other.html" });
  assert.equal(parseScoutManifest(withDuplicateId).ok, false);

  const withDuplicatePath = manifestValue();
  const more = (withDuplicatePath.content as { artifacts: Array<Record<string, unknown>> }).artifacts;
  more.push({ ...more[0]!, id: "artifact-01", role: "report_companion" });
  assert.equal(parseScoutManifest(withDuplicatePath).ok, false);
});

test("an archive path is validated, never repaired", () => {
  assert.equal(validateScoutArchivePath("report/report.html"), "report/report.html");
  assert.equal(validateScoutArchivePath("report/img/chart.png"), "report/img/chart.png");
  assert.equal(validateScoutArchivePath("artifacts/repo-01/evidence/run.log"), "artifacts/repo-01/evidence/run.log");
  for (const bad of [
    "",
    "/report/report.html",
    "report/../../etc/passwd",
    "report//report.html",
    "report/./report.html",
    "report\\report.html",
    "report/.hidden",
    "manifest.json",
    "report",
    "elsewhere/report.html",
    "artifacts/not-a-slot/file.txt",
    "report/report\u0000.html",
    "report/a\nb.txt",
  ]) {
    assert.equal(validateScoutArchivePath(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("a supporting artifact may not be stored under a slot it does not claim", () => {
  const value = manifestValue();
  const artifacts = (value.content as { artifacts: Array<Record<string, unknown>> }).artifacts;
  artifacts.push({
    id: "artifact-01",
    role: "supporting",
    repo_slot: "repo-02",
    original_path: "evidence/run.log",
    archive_path: "artifacts/repo-01/evidence/run.log",
    media_type: "text/plain",
    bytes: 4,
    sha256: `sha256:${"b".repeat(64)}`,
  });
  const parsed = parseScoutManifest(value);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, "path");
});

test("declared totals are refused against the hard limits", () => {
  const value = manifestValue();
  const artifacts = (value.content as { artifacts: Array<Record<string, unknown>> }).artifacts;
  artifacts[0]!.bytes = SCOUT_LIMITS.primaryReportBytes + 1;
  const parsed = parseScoutManifest(value);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, "limits");
});

test("the canonical content digest matches its committed golden vectors", () => {
  const golden = JSON.parse(
    readFileSync(new URL("./fixtures/scout-archive/golden-digests.json", import.meta.url), "utf8"),
  ) as {
    format: string;
    format_version: number;
    vectors: Array<{
      name: string;
      entries: Array<{ archivePath: string; bytes: number; sha256: string }>;
      payload: string;
      content_digest: string;
    }>;
  };
  assert.equal(golden.format, SCOUT_ARCHIVE_FORMAT);
  assert.equal(golden.format_version, SCOUT_ARCHIVE_FORMAT_VERSION);
  assert.ok(golden.vectors.length >= 3, "the vectors must cover more than the trivial case");
  for (const vector of golden.vectors) {
    const payload = canonicalScoutContentPayload(vector.entries);
    assert.equal(payload, vector.payload, `${vector.name}: the canonical payload changed`);
    const digest = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
    assert.equal(digest, vector.content_digest, `${vector.name}: the digest changed`);
  }
});

test("the canonical payload sorts, excludes manifest.json, and survives a space in a path", () => {
  const entries = [
    { archivePath: "report/z.txt", bytes: 2, sha256: `sha256:${"b".repeat(64)}` },
    { archivePath: "manifest.json", bytes: 9, sha256: `sha256:${"f".repeat(64)}` },
    { archivePath: "report/a b.txt", bytes: 1, sha256: `sha256:${"a".repeat(64)}` },
  ];
  const payload = canonicalScoutContentPayload(entries);
  assert.equal(payload.includes("manifest.json"), false);
  const lines = payload.trimEnd().split("\n");
  assert.deepEqual(
    lines.map((line) => line.split(" ").slice(2).join(" ")),
    ["report/a b.txt", "report/z.txt"],
  );
  assert.equal(
    canonicalScoutContentPayload([...entries].reverse()),
    payload,
    "input order must not change the digest",
  );
});

test("an archive key round-trips and refuses anything that is not two generated ids", () => {
  const key = scoutArchiveKey(PRODUCER, ARCHIVE);
  assert.equal(key, `${PRODUCER}~${ARCHIVE}`);
  assert.equal(encodeURIComponent(key), key, "the key must survive URL encoding unchanged");
  assert.deepEqual(parseScoutArchiveKey(key), { producerId: PRODUCER, archiveId: ARCHIVE });
  for (const bad of [
    "",
    PRODUCER,
    `${PRODUCER}~`,
    `${PRODUCER}~${ARCHIVE}~${ARCHIVE}`,
    `..~${ARCHIVE}`,
    `${PRODUCER.toUpperCase()}~${ARCHIVE}`,
    `${PRODUCER}/${ARCHIVE}`,
  ]) {
    assert.equal(parseScoutArchiveKey(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("uppercase identity components are refused, so one bundle cannot have two keys", () => {
  assert.equal(isScoutId(PRODUCER), true);
  assert.equal(isScoutId(PRODUCER.toUpperCase()), false);
});

test("generated repo slots and artifact ids have stable shapes", () => {
  assert.equal(scoutRepoSlot(1), "repo-01");
  assert.equal(scoutRepoSlot(12), "repo-12");
  assert.equal(scoutArtifactId(1), "artifact-01");
  assert.equal(scoutArtifactId(103), "artifact-103");
});

test("a list cursor round-trips and refuses a forged one", () => {
  const cursor = { sortAt: 1_760_000_000_000, key: scoutArchiveKey(PRODUCER, ARCHIVE) };
  const encoded = encodeScoutCursor(cursor);
  assert.deepEqual(decodeScoutCursor(encoded), cursor);
  for (const bad of ["", "abc", "-1.key", `nope.${cursor.key}`, "1760000000000.not-a-key"]) {
    assert.equal(decodeScoutCursor(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("the persisted vocabularies are append-only and contain what this build writes", () => {
  // These reach directories, manifests, and rows on other people's machines. A rename is
  // never a migration here, because the evidence a rename orphans is not in this database.
  assert.deepEqual([...SCOUT_ARCHIVE_FORMAT_VERSIONS], [1]);
  assert.deepEqual([...SCOUT_CAPTURE_STATUSES], ["complete", "partial"]);
  assert.deepEqual([...SCOUT_INDEX_STATUSES], ["ready", "partial", "unreadable"]);
  assert.deepEqual([...SCOUT_ARTIFACT_ROLES], ["primary_report", "report_companion", "supporting"]);
  assert.deepEqual([...SCOUT_MISSING_KINDS], ["primary_report", "report_companion", "supporting_artifact"]);
  assert.deepEqual(
    [...SCOUT_SEARCH_SEGMENT_KINDS],
    ["title", "question", "summary", "tag", "provenance", "report_text", "artifact_path"],
  );
  assert.equal(
    SCOUT_CAPTURE_STATUSES.includes("unreadable" as never),
    false,
    "a manifest must not be able to claim the index's own refusal verdict",
  );
});

test("a cursor survives an archive whose timestamp predates 1970", () => {
  // `sort_at` is an epoch millisecond taken from the manifest, so a bundle dated 1969 has a
  // negative one - and a decoder that refused negatives would 400 on a cursor this module
  // had just produced, at a page boundary only that operator can reach.
  const cursor = { sortAt: -31_449_600_000, key: scoutArchiveKey(PRODUCER, ARCHIVE) };
  assert.deepEqual(decodeScoutCursor(encodeScoutCursor(cursor)), cursor);
});
