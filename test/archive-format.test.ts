import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ARCHIVE_FORMAT,
  ARCHIVE_KINDS,
  SCOUT_ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_FORMAT_VERSIONS,
  ARCHIVE_ARTIFACT_ROLES,
  ARCHIVE_CAPTURE_STATUSES,
  ARCHIVE_INDEX_STATUSES,
  ARCHIVE_LIMITS,
  ARCHIVE_MISSING_KINDS,
  ARCHIVE_PROMPT_KINDS,
  ARCHIVE_PROMPT_LIMITS,
  ARCHIVE_SEARCH_SEGMENT_KINDS,
  canonicalArchiveContentPayload,
  decodeArchiveCursor,
  encodeArchiveCursor,
  isArchiveId,
  parseArchiveKey,
  parseArchiveManifest,
  archiveKey,
  archiveArtifactId,
  archiveRepoSlot,
  serializeArchiveManifest,
  validateArchivePath,
} from "../src/shared/archives.ts";

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
    format: ARCHIVE_FORMAT,
    format_version: 1,
    kind: "scout",
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
        canonicalArchiveContentPayload(
          artifacts.map((a) => ({ archivePath: a.archive_path, bytes: a.bytes, sha256: a.sha256 })),
        ),
      )
      .digest("hex")}`,
    ...overrides,
  };
}

/**
 * The same manifest as a build that predates the kind discriminator wrote it.
 *
 * Derived from the current one rather than typed out separately, so a field added inside
 * version 1 appears in both and this vector cannot drift into a shape nothing ever wrote.
 */
function legacyManifestValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = manifestValue(overrides);
  delete value.kind;
  return { ...value, format: SCOUT_ARCHIVE_FORMAT };
}

test("a representative version 1 manifest parses into its camelCase form", () => {
  const parsed = parseArchiveManifest(manifestValue());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.manifest.formatVersion, 1);
  assert.equal(parsed.manifest.producer.id, PRODUCER);
  assert.equal(parsed.manifest.archive.captureStatus, "complete");
  assert.deepEqual(parsed.manifest.archive.tags, ["permissions", "resume"]);
  assert.equal(parsed.manifest.archive.prompts, null, "an older v1 archive has no inferred trail");
  assert.equal(parsed.manifest.primaryArtifactId, "report");
  assert.equal(parsed.manifest.artifacts[0]?.archivePath, "report/report.html");
  assert.equal(parsed.manifest.origin.repositories[0]?.label, "mission-control");
});

test("a manifest round-trips through serialization without changing meaning", () => {
  const parsed = parseArchiveManifest(manifestValue());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const text = serializeArchiveManifest(parsed.manifest);
  assert.ok(text.endsWith("\n"), "the manifest ends with a newline");
  assert.ok(text.includes('\n  "format_version": 1'), "it is pretty-printed with two spaces");
  const again = parseArchiveManifest(JSON.parse(text));
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual(again.manifest, parsed.manifest);
});

test("a complete prompt trail parses and round-trips inside additive version 1", () => {
  const value = manifestValue();
  (value.archive as Record<string, unknown>).prompts = {
    entries: [
      { kind: "initial", text: "Find why resume loses permissions", at: null },
      { kind: "follow_up", text: "Also check Pi", at: "2026-08-12T18:46:00.000Z" },
    ],
    truncated: false,
  };
  const parsed = parseArchiveManifest(value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.manifest.archive.prompts?.entries.map((entry) => entry.kind), [
    "initial",
    "follow_up",
  ]);
  const serialized = serializeArchiveManifest(parsed.manifest);
  assert.match(serialized, /"follow_up"/);
  const again = parseArchiveManifest(JSON.parse(serialized));
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual(again.manifest.archive.prompts, parsed.manifest.archive.prompts);
});

test("prompt ordering and UTF-8 byte bounds are manifest compatibility checks", () => {
  const promptManifest = (entries: Array<{ kind: string; text: string; at: string | null }>) => {
    const value = manifestValue();
    (value.archive as Record<string, unknown>).prompts = { entries, truncated: false };
    return value;
  };
  assert.equal(
    parseArchiveManifest(promptManifest([{ kind: "follow_up", text: "not first", at: null }])).ok,
    false,
  );
  assert.equal(
    parseArchiveManifest(
      promptManifest([
        { kind: "initial", text: "first", at: null },
        { kind: "initial", text: "again", at: null },
      ]),
    ).ok,
    false,
  );

  const within = "界".repeat(Math.floor(ARCHIVE_PROMPT_LIMITS.entryBytes / 3));
  assert.equal(
    parseArchiveManifest(promptManifest([{ kind: "initial", text: within, at: null }])).ok,
    true,
    "a multibyte value inside the byte ceiling parses",
  );
  assert.equal(
    parseArchiveManifest(promptManifest([{ kind: "initial", text: `${within}界`, at: null }])).ok,
    false,
    "the same character count can cross the UTF-8 byte ceiling",
  );

  const full = "x".repeat(ARCHIVE_PROMPT_LIMITS.entryBytes);
  const tooManyBytes = [
    { kind: "initial", text: full, at: null },
    ...Array.from({ length: 12 }, () => ({ kind: "follow_up", text: full, at: null })),
  ];
  assert.equal(parseArchiveManifest(promptManifest(tooManyBytes)).ok, false, "the total text cap is enforced");
});

test("unknown fields are ignored inside a known version rather than refused", () => {
  const value = manifestValue({ vendor_notes: { anything: true } });
  (value.archive as Record<string, unknown>).future_field = "a newer build wrote this";
  const parsed = parseArchiveManifest(value);
  assert.equal(parsed.ok, true, "a newer build's extra fields must not make a bundle unreadable");
  if (!parsed.ok) return;
  assert.equal(
    "future_field" in (parsed.manifest.archive as unknown as Record<string, unknown>),
    false,
    "an unknown field must not reach the parsed manifest, where something could act on it",
  );
});

test("an unsupported format version is its own answer, not a schema failure", () => {
  const parsed = parseArchiveManifest(manifestValue({ format_version: 2 }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, "unsupported_version");
  assert.equal(parsed.formatVersion, 2);
  assert.match(parsed.reason, /newer than this build/);
});

test("the kind vocabulary is append-only and already contains the kinds a reader may meet", () => {
  // Order and membership are the contract, not the set: a manifest carries one of these
  // strings, so reordering or renaming would orphan bundles that already declare one.
  assert.deepEqual([...ARCHIVE_KINDS], ["scout", "plan"]);
});

test("a legacy scout-archive manifest still parses, and reads as a scout", () => {
  const parsed = parseArchiveManifest(legacyManifestValue());
  assert.equal(parsed.ok, true, "every bundle published before the rename must stay readable");
  if (!parsed.ok) return;
  assert.equal(parsed.manifest.kind, "scout");
  assert.equal(parsed.manifest.formatVersion, 1);
  assert.equal(parsed.manifest.artifacts[0]?.archivePath, "report/report.html");
});

test("a legacy manifest cannot redefine the old identifier by claiming a kind", () => {
  // `mission-control/scout-archive` means one thing for ever. A file carrying that format
  // string and a `kind` field is either damaged or hostile, and honouring the field would
  // let whoever wrote it decide what an identifier this build promised never to redefine
  // now means.
  const parsed = parseArchiveManifest(legacyManifestValue({ kind: "plan" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.manifest.kind, "scout");
});

test("a new-format manifest with no kind is refused, by its own problem code", () => {
  const value = manifestValue();
  delete value.kind;
  const parsed = parseArchiveManifest(value);
  assert.equal(parsed.ok, false, "the new format's whole point is that a bundle says what it is");
  if (parsed.ok) return;
  assert.equal(parsed.problem, "wrong_kind");
  assert.match(parsed.reason, /what kind/);
});

test("a kind this build has no name for is refused rather than guessed at", () => {
  const parsed = parseArchiveManifest(manifestValue({ kind: "sketch" }));
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, "wrong_kind");
  assert.match(parsed.reason, /sketch/);
  const nonString = parseArchiveManifest(manifestValue({ kind: 7 }));
  assert.equal(nonString.ok, false);
});

test("serialization writes the new format and never the legacy one", () => {
  const parsed = parseArchiveManifest(legacyManifestValue());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const text = serializeArchiveManifest(parsed.manifest);
  assert.ok(text.includes(`"format": "${ARCHIVE_FORMAT}"`), "one format is written");
  assert.equal(
    text.includes(SCOUT_ARCHIVE_FORMAT),
    false,
    "a manifest read as legacy must never be re-serialized as one - that would be a rewrite",
  );
  assert.ok(text.includes('"kind": "scout"'), "the kind it read as is what it writes");
});

test("a value that is not an archive is refused before its shape is read", () => {
  assert.equal(parseArchiveManifest(null).ok, false);
  assert.equal(parseArchiveManifest([]).ok, false);
  const wrong = parseArchiveManifest(manifestValue({ format: "something/else" }));
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
    const parsed = parseArchiveManifest(manifestValue(overrides as Record<string, unknown>));
    assert.equal(parsed.ok, false, `${key} must be refused`);
  }
});

test("only report/report.html may be the primary artifact of a complete archive", () => {
  const value = manifestValue();
  const artifacts = (value.content as { artifacts: Array<Record<string, unknown>> }).artifacts;
  artifacts[0]!.archive_path = "report/summary.html";
  const parsed = parseArchiveManifest(value);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, "primary_report");
  assert.match(parsed.reason, /report\/report\.html/);
});

test("a complete archive without a primary report is refused; a partial one explains itself", () => {
  const empty = manifestValue({ content: { primary_artifact_id: null, artifacts: [] } });
  empty.content_digest = `sha256:${createHash("sha256").update("").digest("hex")}`;
  const complete = parseArchiveManifest({ ...empty });
  assert.equal(complete.ok, false, "a complete archive must have a report");

  const partialNoReason = parseArchiveManifest({
    ...empty,
    archive: { ...(empty.archive as object), capture_status: "partial" },
  });
  assert.equal(partialNoReason.ok, false, "a partial archive with no report must say why");

  const partial = parseArchiveManifest({
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
  assert.equal(parseArchiveManifest(withDuplicateId).ok, false);

  const withDuplicatePath = manifestValue();
  const more = (withDuplicatePath.content as { artifacts: Array<Record<string, unknown>> }).artifacts;
  more.push({ ...more[0]!, id: "artifact-01", role: "report_companion" });
  assert.equal(parseArchiveManifest(withDuplicatePath).ok, false);
});

test("an archive path is validated, never repaired", () => {
  assert.equal(validateArchivePath("report/report.html"), "report/report.html");
  assert.equal(validateArchivePath("report/img/chart.png"), "report/img/chart.png");
  assert.equal(validateArchivePath("artifacts/repo-01/evidence/run.log"), "artifacts/repo-01/evidence/run.log");
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
    assert.equal(validateArchivePath(bad), null, `${JSON.stringify(bad)} must be refused`);
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
  const parsed = parseArchiveManifest(value);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, "path");
});

test("declared totals are refused against the hard limits", () => {
  const value = manifestValue();
  const artifacts = (value.content as { artifacts: Array<Record<string, unknown>> }).artifacts;
  artifacts[0]!.bytes = ARCHIVE_LIMITS.primaryReportBytes + 1;
  const parsed = parseArchiveManifest(value);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.problem, "limits");
});

test("the canonical content digest matches its committed golden vectors", () => {
  const golden = JSON.parse(
    readFileSync(new URL("./fixtures/scout-archive/golden-digests.json", import.meta.url), "utf8"),
  ) as {
    format: string;
    legacy_format: string;
    format_version: number;
    vectors: Array<{
      name: string;
      entries: Array<{ archivePath: string; bytes: number; sha256: string }>;
      payload: string;
      content_digest: string;
    }>;
  };
  // Both identifiers are pinned here, and the pair is the compatibility window written down:
  // one is what this build writes, the other is what it must go on reading for ever. The
  // vectors below are unaffected by either - a content digest covers archived paths, sizes
  // and hashes, and never the format string - which is what makes them still golden across
  // the rename.
  assert.equal(golden.format, ARCHIVE_FORMAT);
  assert.equal(golden.legacy_format, SCOUT_ARCHIVE_FORMAT);
  assert.equal(golden.format_version, ARCHIVE_FORMAT_VERSION);
  assert.ok(golden.vectors.length >= 3, "the vectors must cover more than the trivial case");
  for (const vector of golden.vectors) {
    const payload = canonicalArchiveContentPayload(vector.entries);
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
  const payload = canonicalArchiveContentPayload(entries);
  assert.equal(payload.includes("manifest.json"), false);
  const lines = payload.trimEnd().split("\n");
  assert.deepEqual(
    lines.map((line) => line.split(" ").slice(2).join(" ")),
    ["report/a b.txt", "report/z.txt"],
  );
  assert.equal(
    canonicalArchiveContentPayload([...entries].reverse()),
    payload,
    "input order must not change the digest",
  );
});

test("an archive key round-trips and refuses anything that is not two generated ids", () => {
  const key = archiveKey(PRODUCER, ARCHIVE);
  assert.equal(key, `${PRODUCER}~${ARCHIVE}`);
  assert.equal(encodeURIComponent(key), key, "the key must survive URL encoding unchanged");
  assert.deepEqual(parseArchiveKey(key), { producerId: PRODUCER, archiveId: ARCHIVE });
  for (const bad of [
    "",
    PRODUCER,
    `${PRODUCER}~`,
    `${PRODUCER}~${ARCHIVE}~${ARCHIVE}`,
    `..~${ARCHIVE}`,
    `${PRODUCER.toUpperCase()}~${ARCHIVE}`,
    `${PRODUCER}/${ARCHIVE}`,
  ]) {
    assert.equal(parseArchiveKey(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("uppercase identity components are refused, so one bundle cannot have two keys", () => {
  assert.equal(isArchiveId(PRODUCER), true);
  assert.equal(isArchiveId(PRODUCER.toUpperCase()), false);
});

test("generated repo slots and artifact ids have stable shapes", () => {
  assert.equal(archiveRepoSlot(1), "repo-01");
  assert.equal(archiveRepoSlot(12), "repo-12");
  assert.equal(archiveArtifactId(1), "artifact-01");
  assert.equal(archiveArtifactId(103), "artifact-103");
});

test("a list cursor round-trips and refuses a forged one", () => {
  const cursor = { sortAt: 1_760_000_000_000, key: archiveKey(PRODUCER, ARCHIVE) };
  const encoded = encodeArchiveCursor(cursor);
  assert.deepEqual(decodeArchiveCursor(encoded), cursor);
  for (const bad of ["", "abc", "-1.key", `nope.${cursor.key}`, "1760000000000.not-a-key"]) {
    assert.equal(decodeArchiveCursor(bad), null, `${JSON.stringify(bad)} must be refused`);
  }
});

test("the persisted vocabularies are append-only and contain what this build writes", () => {
  // These reach directories, manifests, and rows on other people's machines. A rename is
  // never a migration here, because the evidence a rename orphans is not in this database.
  assert.deepEqual([...ARCHIVE_FORMAT_VERSIONS], [1]);
  assert.deepEqual([...ARCHIVE_CAPTURE_STATUSES], ["complete", "partial"]);
  assert.deepEqual([...ARCHIVE_INDEX_STATUSES], ["ready", "partial", "unreadable"]);
  assert.deepEqual([...ARCHIVE_ARTIFACT_ROLES], ["primary_report", "report_companion", "supporting"]);
  assert.deepEqual([...ARCHIVE_MISSING_KINDS], ["primary_report", "report_companion", "supporting_artifact"]);
  assert.deepEqual([...ARCHIVE_PROMPT_KINDS], ["initial", "follow_up"]);
  assert.deepEqual(
    [...ARCHIVE_SEARCH_SEGMENT_KINDS],
    ["title", "question", "summary", "tag", "provenance", "report_text", "artifact_path", "prompt"],
  );
  assert.equal(
    ARCHIVE_CAPTURE_STATUSES.includes("unreadable" as never),
    false,
    "a manifest must not be able to claim the index's own refusal verdict",
  );
});

test("a cursor survives an archive whose timestamp predates 1970", () => {
  // `sort_at` is an epoch millisecond taken from the manifest, so a bundle dated 1969 has a
  // negative one - and a decoder that refused negatives would 400 on a cursor this module
  // had just produced, at a page boundary only that operator can reach.
  const cursor = { sortAt: -31_449_600_000, key: archiveKey(PRODUCER, ARCHIVE) };
  assert.deepEqual(decodeArchiveCursor(encodeArchiveCursor(cursor)), cursor);
});
