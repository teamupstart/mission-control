import { z } from "zod";

/**
 * The portable archive contract: what a completed archive IS, independently of the task,
 * session, worktree, or database that produced it.
 *
 * An archive is a directory - `archives/<producer-id>/<archive-id>/` - holding a
 * `manifest.json`, a `report/` folder whose `report.html` is the page a reader opens, and
 * an `artifacts/` folder of supporting evidence below a generated repository slot.
 * Everything a reader needs to display, search, and verify one is in those files. SQLite is
 * a disposable projection of them, never the other way round.
 *
 * Every archive declares its KIND - what the bundle preserves - and the kind is the only
 * thing that differs between them. The mechanics here are kind-agnostic: identity, paths,
 * digests, limits, and the manifest shape say nothing about scouting.
 *
 * This module is the format owner and is browser-safe on purpose (no `node:` imports):
 * the daemon writes and verifies bundles with it, the dashboard decodes their keys with
 * it, and a non-TypeScript implementation can reproduce the identity rules from it plus
 * the golden vectors in `test/fixtures/scout-archive/`.
 *
 * Everything here that is written into a bundle - the format name, the version tuple, the
 * kind/status/role vocabularies, the canonical digest encoding, the path rules - is an
 * APPEND-ONLY portable contract. Bundles produced by this build are read by later builds
 * and by other people's machines; renaming a value orphans evidence that no migration can
 * reach, because the evidence is not in this database. That is why the rename that
 * introduced this module was ADDITIVE: `SCOUT_ARCHIVE_FORMAT` below keeps its exact
 * original meaning for ever and simply stops being written.
 */

/** The literal `format` string this build writes into every manifest. */
export const ARCHIVE_FORMAT = "mission-control/archive";

/**
 * The `format` string this build wrote before archives declared a kind. READ, NEVER WRITTEN.
 *
 * Every bundle published by an earlier build carries it, on this machine and on anybody
 * else's, and those bundles are never rewritten - so this identifier is not redefined,
 * retired, or reused. It means exactly one thing for ever: a version 1 archive of a scout's
 * report. `parseArchiveManifest` reads one as `kind: "scout"`, which is what it is.
 */
export const SCOUT_ARCHIVE_FORMAT = "mission-control/scout-archive";

/**
 * What a bundle preserves, persisted in the manifest and projected into the index.
 *
 * APPEND-ONLY, like every other vocabulary here: a member is added at the end and no member
 * is ever renamed or reordered. `plan` is present from the first build that understands
 * kinds at all, because a reader that meets a plan bundle from a newer Mission Control
 * should say what it is rather than refuse a value it has no name for - and because adding a
 * member later would be a second format decision for no benefit.
 *
 * A kind being READABLE here says nothing about what this build can WRITE. The capture path
 * keeps its own registry of the kinds it knows how to produce.
 */
export const ARCHIVE_KINDS = ["scout", "plan"] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

/**
 * Every archive format version this build can read, append-only.
 *
 * A manifest naming a version outside this tuple is not a corrupt bundle - it is a bundle
 * from a NEWER Mission Control, and the honest answer is "this build cannot read it yet",
 * not a parse failure that looks like damage. `parseArchiveManifest` returns that as its own
 * result code so the index can list the archive as unreadable and leave it untouched.
 */
export const ARCHIVE_FORMAT_VERSIONS = [1] as const;
export type ArchiveFormatVersion = (typeof ARCHIVE_FORMAT_VERSIONS)[number];

/** The version this build writes. */
export const ARCHIVE_FORMAT_VERSION: ArchiveFormatVersion = 1;

/**
 * What the archive itself claims about its own completeness, persisted in the manifest.
 *
 * `unreadable` is deliberately NOT here: that is an index verdict about a bundle this
 * build could not accept, and a manifest must not be able to claim it about itself.
 */
export const ARCHIVE_CAPTURE_STATUSES = ["complete", "partial"] as const;
export type ArchiveCaptureStatus = (typeof ARCHIVE_CAPTURE_STATUSES)[number];

/** What the local index says about a discovered bundle. Persisted in `archives.status`. */
export const ARCHIVE_INDEX_STATUSES = ["ready", "partial", "unreadable"] as const;
export type ArchiveIndexStatus = (typeof ARCHIVE_INDEX_STATUSES)[number];

/** What one archived file was to the archive it is in. Persisted in the manifest and the index. */
export const ARCHIVE_ARTIFACT_ROLES = ["primary_report", "report_companion", "supporting"] as const;
export type ArchiveArtifactRole = (typeof ARCHIVE_ARTIFACT_ROLES)[number];

/** What a partial archive is missing, per entry. */
export const ARCHIVE_MISSING_KINDS = [
  "primary_report",
  "report_companion",
  "supporting_artifact",
] as const;
export type ArchiveMissingKind = (typeof ARCHIVE_MISSING_KINDS)[number];

/**
 * Where one indexed search segment came from.
 *
 * Persisted in `archive_search_segments.source_kind` and reported back as the snippet's
 * provenance, so a result can say WHY it matched - the difference between "the report says
 * this" and "a file was named this".
 */
export const ARCHIVE_SEARCH_SEGMENT_KINDS = [
  "title",
  "question",
  "summary",
  "tag",
  "provenance",
  "report_text",
  "artifact_path",
] as const;
export type ArchiveSearchSegmentKind = (typeof ARCHIVE_SEARCH_SEGMENT_KINDS)[number];

/** The manifest filename, and the one content path excluded from the canonical digest. */
export const ARCHIVE_MANIFEST_FILENAME = "manifest.json";
/** The report directory, captured as one relative unit so its local links survive. */
export const ARCHIVE_REPORT_DIR = "report";
/** Explicitly submitted supporting files, below a generated repository slot. */
export const ARCHIVE_ARTIFACTS_DIR = "artifacts";
/** The only allowable primary-report path in a complete v1 archive. */
export const ARCHIVE_PRIMARY_REPORT_PATH = "report/report.html";
/** The reserved artifact id of the primary report. */
export const ARCHIVE_PRIMARY_ARTIFACT_ID = "report";

/**
 * Reserved directories inside the library root. Neither is ever a producer id (both start
 * with a dot, and a producer id is a UUID), and discovery skips them by name anyway.
 */
export const ARCHIVE_STAGING_DIR = ".staging";
export const ARCHIVE_TRASH_DIR = ".trash";

/**
 * Hard limits, applied before a bundle is published locally and again before an imported
 * one is indexed. They protect a local daemon from a bundle - ours or somebody else's -
 * that would take the machine down while being hashed.
 *
 * Kept together so the capture path, the importer, and the documentation cannot disagree
 * about what "too big" means.
 */
export const ARCHIVE_LIMITS = {
  /** `report/report.html` itself. */
  primaryReportBytes: 32 * 1024 * 1024,
  /** Everything under `report/`, including the report. */
  reportDirectoryBytes: 128 * 1024 * 1024,
  /** How many files may live under `report/`. */
  reportDirectoryEntries: 256,
  /** One explicitly submitted supporting file. */
  supportingFileBytes: 64 * 1024 * 1024,
  /** How many content entries one manifest may declare, in total. */
  entries: 512,
  /** The whole bundle's content bytes. */
  bundleBytes: 512 * 1024 * 1024,
  /** `manifest.json` itself - it is metadata, and a huge one is an attack, not an archive. */
  manifestBytes: 4 * 1024 * 1024,
} as const;

/**
 * Bounds on the text a bundle contributes to the index.
 *
 * A manifest is untrusted input even when this daemon wrote it, so every string that
 * reaches a row is truncated here rather than at the display edge: an index that stored
 * whatever a foreign manifest claimed would make a 100 MiB "title" a database problem.
 */
export const ARCHIVE_TEXT_LIMITS = {
  title: 200,
  question: 1_000,
  summary: 4_000,
  tag: 64,
  tags: 24,
  label: 200,
  /** Visible text extracted from `report/report.html`, in total. */
  reportText: 256 * 1024,
  /** One `archive_search_segments` row. */
  segment: 8 * 1024,
  /** A safe diagnostic stored against an unreadable bundle. */
  error: 500,
  /** A search snippet returned to the browser. */
  snippet: 240,
} as const;

/** Bounds the list route enforces on its own query string. */
export const ARCHIVE_SEARCH_LIMITS = {
  queryChars: 200,
  defaultLimit: 30,
  maxLimit: 100,
} as const;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The separator between the producer and archive components of an archive key.
 *
 * `~` rather than `:` or `/`: it is an RFC 3986 *unreserved* character, so it survives
 * `encodeURIComponent` unchanged in a path segment, a query value, and a hash route, and
 * every client that percent-encodes defensively still produces the same string. A UUID
 * contains only hex and `-`, so the separator is unambiguous.
 */
export const ARCHIVE_KEY_SEPARATOR = "~";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether a value is a generated archive identity component.
 *
 * LOWERCASE ONLY, and that is load-bearing rather than tidy: these strings are directory
 * names, and macOS's default filesystem is case-insensitive, so accepting `A1B2…` beside
 * `a1b2…` would make one bundle addressable under two keys that cannot both exist on
 * disk. `randomUUID()` emits lowercase, so nothing this app writes is affected.
 */
export function isArchiveId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** A bundle's global identity: the producer that made it, and the archive itself. */
export interface ArchiveIdentity {
  producerId: string;
  archiveId: string;
}

/** The composite key routes, SQLite, and the browser all address an archive by. */
export function archiveKey(producerId: string, archiveId: string): string {
  return `${producerId}${ARCHIVE_KEY_SEPARATOR}${archiveId}`;
}

/**
 * Decode an archive key, or null when it is not one.
 *
 * This runs BEFORE any path is joined, on every route, which is the whole point: the two
 * components become directory names, so "is this a generated UUID" is the check that stops
 * a request naming `..` or an absolute path from reaching the filesystem at all.
 */
export function parseArchiveKey(key: unknown): ArchiveIdentity | null {
  if (typeof key !== "string") return null;
  const parts = key.split(ARCHIVE_KEY_SEPARATOR);
  if (parts.length !== 2) return null;
  const [producerId, archiveId] = parts;
  if (!isArchiveId(producerId) || !isArchiveId(archiveId)) return null;
  return { producerId, archiveId };
}

/** Generated repository slots (`repo-01`), the only directory component under `artifacts/`. */
const REPO_SLOT_RE = /^repo-[0-9]{2,3}$/;

export function isArchiveRepoSlot(value: unknown): value is string {
  return typeof value === "string" && REPO_SLOT_RE.test(value);
}

/** The slot for the nth attached repository, one-based. */
export function archiveRepoSlot(ordinal: number): string {
  return `repo-${String(ordinal).padStart(2, "0")}`;
}

/** Generated artifact ids: `report` for the primary, `artifact-01` onward for the rest. */
const ARTIFACT_ID_RE = /^(?:report|artifact-[0-9]{2,4})$/;

export function isArchiveArtifactId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_ID_RE.test(value);
}

/** The generated id for the nth non-primary artifact, one-based. */
export function archiveArtifactId(ordinal: number): string {
  return `artifact-${String(ordinal).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MAX_ARCHIVE_PATH_CHARS = 1024;
const MAX_ARCHIVE_PATH_SEGMENT_CHARS = 255;

/**
 * Validate one bundle-relative content path, returning it unchanged or null.
 *
 * Deliberately a VALIDATOR rather than a normalizer. A path that needs normalizing - a
 * `..`, a doubled slash, a backslash, a trailing dot - is not a path this app wrote, and
 * quietly repairing one would mean the string in the manifest and the string a reader
 * resolves are different, which is exactly the gap a traversal lives in. The rules are:
 *
 * - relative, POSIX separators, no drive letters and no leading `/`;
 * - every segment non-empty, not `.`, not `..`, and not starting with `.` (a hidden entry
 *   inside a bundle has no legitimate use and lets a payload hide from a human `ls`);
 * - no NUL and no control characters, which is what makes the string safe to store, log,
 *   and put in a header;
 * - rooted at `report/` or `artifacts/`, so a manifest cannot claim `manifest.json` or an
 *   unmanaged sibling as content.
 */
export function validateArchivePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_ARCHIVE_PATH_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return null;
  if (raw.startsWith("/")) return null;
  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > MAX_ARCHIVE_PATH_SEGMENT_CHARS) return null;
    if (segment === "." || segment === "..") return null;
    if (segment.startsWith(".")) return null;
  }
  const root = segments[0];
  if (root !== ARCHIVE_REPORT_DIR && root !== ARCHIVE_ARTIFACTS_DIR) return null;
  if (segments.length < 2) return null;
  if (root === ARCHIVE_ARTIFACTS_DIR && !isArchiveRepoSlot(segments[1])) return null;
  return raw;
}

/** Whether an archive path lives inside the report directory. */
export function isArchiveReportPath(archivePath: string): boolean {
  return archivePath.startsWith(`${ARCHIVE_REPORT_DIR}/`);
}

// ---------------------------------------------------------------------------
// Canonical content digest
// ---------------------------------------------------------------------------

/** One row of the canonical content table: what a file is, by identity rather than by name. */
export interface ArchiveContentEntry {
  archivePath: string;
  bytes: number;
  sha256: string;
}

/** How a SHA-256 is written everywhere in this format. */
export const ARCHIVE_DIGEST_PREFIX = "sha256:";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** `sha256:<64 lowercase hex>` from bare hex, or null when the hex is not one. */
export function formatArchiveDigest(hex: string): string | null {
  return SHA256_HEX_RE.test(hex) ? `${ARCHIVE_DIGEST_PREFIX}${hex}` : null;
}

/** The bare hex of a `sha256:` digest string, or null when it is not one. */
export function archiveDigestHex(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(ARCHIVE_DIGEST_PREFIX)) return null;
  const hex = value.slice(ARCHIVE_DIGEST_PREFIX.length);
  return SHA256_HEX_RE.test(hex) ? hex : null;
}

/**
 * The exact bytes a v1 `content_digest` is taken over.
 *
 * Split from the hashing itself so this module stays browser-safe and, more importantly,
 * so the encoding is something another implementation can reproduce without running any of
 * this code: sort the content table by archive path ascending, drop `manifest.json`, and
 * write one `<sha256-hex> <bytes> <archive-path>\n` line per entry in UTF-8. The digest is
 * SHA-256 over the resulting bytes.
 *
 * `manifest.json` is excluded because the digest lives IN it. The path comes LAST on each
 * line - `sha256sum`'s own layout - because it is the only field that may contain a space,
 * so no entry can forge a field boundary; a newline cannot appear in one at all
 * (`validateArchivePath` refuses control characters), so no entry can forge a row
 * boundary either. Sorting is by UTF-16 code unit (`<`), which is what
 * `Array.prototype.sort` does with no comparator and what every JS implementation agrees
 * on; paths are ASCII-dominant in practice and the rule is stated rather than inferred.
 *
 * Golden vectors live in `test/fixtures/scout-archive/golden-digests.json`.
 */
export function canonicalArchiveContentPayload(entries: readonly ArchiveContentEntry[]): string {
  const rows = entries
    .filter((entry) => entry.archivePath !== ARCHIVE_MANIFEST_FILENAME)
    .map((entry) => ({
      path: entry.archivePath,
      bytes: entry.bytes,
      hex: archiveDigestHex(entry.sha256) ?? entry.sha256,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows.map((row) => `${row.hex} ${row.bytes} ${row.path}\n`).join("");
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** Who made the archive. The label is an unverified, informational claim. */
export interface ArchiveManifestProducer {
  id: string;
  label: string | null;
}

/** One repository the archived work looked at. Informational: no checkout has to exist. */
export interface ArchiveManifestRepository {
  slot: string;
  label: string | null;
  head: string | null;
}

/** What the archived work was asked, what it answered, and when. */
export interface ArchiveManifestArchive {
  id: string;
  createdAt: string;
  completedAt: string | null;
  captureStatus: ArchiveCaptureStatus;
  title: string;
  question: string | null;
  summary: string | null;
  tags: string[];
}

/** Where the archived work ran. Every field is nullable: a foreign bundle may know none. */
export interface ArchiveManifestOrigin {
  agent: string | null;
  model: string | null;
  source: string | null;
  repositories: ArchiveManifestRepository[];
}

/** One archived file. */
export interface ArchiveManifestArtifact {
  id: string;
  role: ArchiveArtifactRole;
  repoSlot: string | null;
  originalPath: string | null;
  archivePath: string;
  mediaType: string | null;
  bytes: number;
  sha256: string;
}

/** One honest omission in a partial archive. */
export interface ArchiveManifestMissing {
  kind: ArchiveMissingKind;
  expectedSource: string | null;
  reason: string;
}

/** A parsed, internally consistent v1 manifest. Byte-level verification is the server's. */
export interface ArchiveManifest {
  formatVersion: ArchiveFormatVersion;
  /**
   * What this bundle preserves.
   *
   * Always present after parsing, including for a legacy `mission-control/scout-archive`
   * manifest that predates the field - one of those reads as `scout`, which is what it is.
   */
  kind: ArchiveKind;
  producer: ArchiveManifestProducer;
  archive: ArchiveManifestArchive;
  origin: ArchiveManifestOrigin;
  primaryArtifactId: string | null;
  artifacts: ArchiveManifestArtifact[];
  missing: ArchiveManifestMissing[];
  contentDigest: string;
}

/**
 * Why a manifest was refused. Persisted nowhere; carried into a safe index diagnostic.
 *
 * APPEND-ONLY: a member is added at the end, never reordered, because a test and a
 * diagnostic both name these by value.
 */
export const ARCHIVE_MANIFEST_PROBLEMS = [
  "not_an_object",
  "wrong_format",
  "unsupported_version",
  "schema",
  "path",
  "identity",
  "primary_report",
  "limits",
  "wrong_kind",
] as const;
export type ArchiveManifestProblem = (typeof ARCHIVE_MANIFEST_PROBLEMS)[number];

export type ArchiveManifestParseResult =
  | { ok: true; manifest: ArchiveManifest }
  | {
      ok: false;
      problem: ArchiveManifestProblem;
      reason: string;
      /** The version the manifest claimed, when it claimed a readable number. */
      formatVersion: number | null;
    };

const NonEmpty = z.string().min(1);
const Timestamp = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-8601 instant");

/**
 * The v1 wire shape, in the snake_case the file actually uses.
 *
 * NOT `.strict()`: unknown fields are ignored rather than refused, which is what lets a
 * newer build add a field inside version 1 without making its bundles unreadable here.
 * Ignoring is the whole permission - nothing downstream may read an unknown field, because
 * a reader that acted on one would be honouring a contract it does not have.
 */
const ManifestV1Schema = z.object({
  producer: z.object({
    id: NonEmpty,
    label: z.string().max(ARCHIVE_TEXT_LIMITS.label).nullish(),
  }),
  archive: z.object({
    id: NonEmpty,
    created_at: Timestamp,
    completed_at: Timestamp.nullish(),
    capture_status: z.enum(ARCHIVE_CAPTURE_STATUSES),
    title: z.string().min(1).max(ARCHIVE_TEXT_LIMITS.title),
    question: z.string().max(ARCHIVE_TEXT_LIMITS.question).nullish(),
    summary: z.string().max(ARCHIVE_TEXT_LIMITS.summary).nullish(),
    tags: z.array(z.string().min(1).max(ARCHIVE_TEXT_LIMITS.tag)).max(ARCHIVE_TEXT_LIMITS.tags).default([]),
  }),
  origin: z
    .object({
      agent: z.string().max(ARCHIVE_TEXT_LIMITS.label).nullish(),
      model: z.string().max(ARCHIVE_TEXT_LIMITS.label).nullish(),
      source: z.string().max(ARCHIVE_TEXT_LIMITS.label).nullish(),
      repositories: z
        .array(
          z.object({
            slot: NonEmpty,
            label: z.string().max(ARCHIVE_TEXT_LIMITS.label).nullish(),
            head: z.string().max(64).nullish(),
          }),
        )
        .max(64)
        .default([]),
    })
    .default({ repositories: [] }),
  content: z.object({
    primary_artifact_id: z.string().max(64).nullish(),
    artifacts: z
      .array(
        z.object({
          id: NonEmpty,
          role: z.enum(ARCHIVE_ARTIFACT_ROLES),
          repo_slot: z.string().max(64).nullish(),
          original_path: z.string().max(MAX_ARCHIVE_PATH_CHARS).nullish(),
          archive_path: NonEmpty,
          media_type: z.string().max(128).nullish(),
          bytes: z.number().int().nonnegative(),
          sha256: NonEmpty,
        }),
      )
      .max(ARCHIVE_LIMITS.entries),
  }),
  missing: z
    .array(
      z.object({
        kind: z.enum(ARCHIVE_MISSING_KINDS),
        expected_source: z.string().max(MAX_ARCHIVE_PATH_CHARS).nullish(),
        reason: z.string().min(1).max(ARCHIVE_TEXT_LIMITS.error),
      }),
    )
    .max(64)
    .default([]),
  content_digest: NonEmpty,
});

function refuse(
  problem: ArchiveManifestProblem,
  reason: string,
  formatVersion: number | null = null,
): ArchiveManifestParseResult {
  return { ok: false, problem, reason, formatVersion };
}

/**
 * Read a `manifest.json` value into a checked v1 manifest.
 *
 * FORMAT is settled first, then the kind, then the version, and only then the shape - so a
 * bundle from a stranger's tool, a bundle of a kind this build has no name for, and a
 * version-2 bundle each get the answer that is actually true about them rather than fifty
 * schema errors about a shape none of them claimed to have.
 *
 * Reading is a UNION of two formats and writing is one of them, which is what keeps the
 * append-only promise concrete. `mission-control/archive` carries an explicit `kind`;
 * `mission-control/scout-archive` predates the discriminator and reads as `scout`, because
 * that is the only thing it was ever used for and its meaning is frozen. A legacy manifest
 * that carries a `kind` field anyway is not consulted about it - unknown fields are ignored
 * in version 1 by design, and honouring one here would let the old identifier be redefined
 * by whoever wrote the file.
 *
 * What this proves is everything decidable from the file alone: the format, the kind, the
 * version, generated identities, path legality and uniqueness, the primary-report rule, and
 * the declared totals against the hard limits. What it deliberately does NOT prove is
 * anything about the filesystem - that the files exist, that their bytes match, that the
 * content digest is right. Those need the bundle, and they belong to the server-side
 * verifier, so this function stays usable in a browser and in a test with no directory.
 */
export function parseArchiveManifest(value: unknown): ArchiveManifestParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse("not_an_object", "manifest is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  let kind: ArchiveKind;
  if (record.format === ARCHIVE_FORMAT) {
    const claimed = record.kind;
    if (typeof claimed !== "string" || !(ARCHIVE_KINDS as readonly string[]).includes(claimed)) {
      return refuse(
        "wrong_kind",
        typeof claimed === "string"
          ? `this build has no name for a ${claimed} archive`
          : "manifest does not say what kind of archive it is",
      );
    }
    kind = claimed as ArchiveKind;
  } else if (record.format === SCOUT_ARCHIVE_FORMAT) {
    kind = "scout";
  } else {
    return refuse("wrong_format", "manifest is not a Mission Control archive");
  }
  const rawVersion = record.format_version;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
    return refuse("schema", "manifest format_version is not an integer");
  }
  if (!(ARCHIVE_FORMAT_VERSIONS as readonly number[]).includes(rawVersion)) {
    return refuse(
      "unsupported_version",
      `archive format version ${rawVersion} is newer than this build understands`,
      rawVersion,
    );
  }
  const formatVersion = rawVersion as ArchiveFormatVersion;

  const parsed = ManifestV1Schema.safeParse(record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return refuse("schema", `${where}${issue?.message ?? "manifest does not match version 1"}`, formatVersion);
  }
  const data = parsed.data;

  if (!isArchiveId(data.producer.id)) {
    return refuse("identity", "producer id is not a generated identifier", formatVersion);
  }
  if (!isArchiveId(data.archive.id)) {
    return refuse("identity", "archive id is not a generated identifier", formatVersion);
  }
  if (!archiveDigestHex(data.content_digest)) {
    return refuse("schema", "content_digest is not a sha256 digest", formatVersion);
  }

  const slots = new Set<string>();
  for (const repository of data.origin.repositories) {
    if (!isArchiveRepoSlot(repository.slot)) {
      return refuse("identity", `repository slot ${repository.slot} is not generated`, formatVersion);
    }
    if (slots.has(repository.slot)) {
      return refuse("identity", `repository slot ${repository.slot} appears twice`, formatVersion);
    }
    slots.add(repository.slot);
  }

  const artifacts: ArchiveManifestArtifact[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  let reportBytes = 0;
  let reportEntries = 0;
  for (const artifact of data.content.artifacts) {
    if (!isArchiveArtifactId(artifact.id)) {
      return refuse("identity", `artifact id ${artifact.id} is not generated`, formatVersion);
    }
    if (seenIds.has(artifact.id)) {
      return refuse("identity", `artifact id ${artifact.id} appears twice`, formatVersion);
    }
    seenIds.add(artifact.id);
    const archivePath = validateArchivePath(artifact.archive_path);
    if (!archivePath) {
      return refuse("path", `artifact ${artifact.id} has an unusable archive path`, formatVersion);
    }
    if (seenPaths.has(archivePath)) {
      return refuse("path", `two artifacts claim ${archivePath}`, formatVersion);
    }
    seenPaths.add(archivePath);
    if (!archiveDigestHex(artifact.sha256)) {
      return refuse("schema", `artifact ${artifact.id} has no sha256 digest`, formatVersion);
    }
    if (artifact.repo_slot != null && !isArchiveRepoSlot(artifact.repo_slot)) {
      return refuse("identity", `artifact ${artifact.id} names an ungenerated repo slot`, formatVersion);
    }
    if (!isArchiveReportPath(archivePath)) {
      const slot = archivePath.split("/")[1];
      if (artifact.repo_slot != null && slot !== artifact.repo_slot) {
        return refuse(
          "path",
          `artifact ${artifact.id} is stored under ${slot} but claims ${artifact.repo_slot}`,
          formatVersion,
        );
      }
    }
    totalBytes += artifact.bytes;
    if (isArchiveReportPath(archivePath)) {
      reportBytes += artifact.bytes;
      reportEntries += 1;
    }
    if (artifact.role === "supporting" && artifact.bytes > ARCHIVE_LIMITS.supportingFileBytes) {
      return refuse("limits", `artifact ${artifact.id} exceeds the supporting-file limit`, formatVersion);
    }
    artifacts.push({
      id: artifact.id,
      role: artifact.role,
      repoSlot: artifact.repo_slot ?? null,
      originalPath: artifact.original_path ?? null,
      archivePath,
      mediaType: artifact.media_type ?? null,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  }

  if (reportEntries > ARCHIVE_LIMITS.reportDirectoryEntries) {
    return refuse("limits", "the report directory declares too many files", formatVersion);
  }
  if (reportBytes > ARCHIVE_LIMITS.reportDirectoryBytes) {
    return refuse("limits", "the report directory exceeds its size limit", formatVersion);
  }
  if (totalBytes > ARCHIVE_LIMITS.bundleBytes) {
    return refuse("limits", "the bundle exceeds its size limit", formatVersion);
  }

  const primaryArtifactId = data.content.primary_artifact_id ?? null;
  const primary = primaryArtifactId
    ? artifacts.find((artifact) => artifact.id === primaryArtifactId)
    : undefined;
  if (primaryArtifactId && !primary) {
    return refuse("primary_report", "the primary artifact id names nothing", formatVersion);
  }
  if (primary) {
    if (primary.role !== "primary_report") {
      return refuse("primary_report", "the primary artifact is not the primary report", formatVersion);
    }
    if (primary.archivePath !== ARCHIVE_PRIMARY_REPORT_PATH) {
      return refuse(
        "primary_report",
        `the primary report must be ${ARCHIVE_PRIMARY_REPORT_PATH}`,
        formatVersion,
      );
    }
    if (primary.bytes > ARCHIVE_LIMITS.primaryReportBytes) {
      return refuse("limits", "the primary report exceeds its size limit", formatVersion);
    }
  }
  const primaryRoles = artifacts.filter((artifact) => artifact.role === "primary_report");
  if (primaryRoles.length > 1) {
    return refuse("primary_report", "an archive has more than one primary report", formatVersion);
  }
  if (data.archive.capture_status === "complete" && !primary) {
    return refuse("primary_report", "a complete archive has no primary report", formatVersion);
  }
  if (data.archive.capture_status === "partial" && !primary && data.missing.length === 0) {
    return refuse(
      "primary_report",
      "a partial archive without a report must say what is missing",
      formatVersion,
    );
  }

  return {
    ok: true,
    manifest: {
      formatVersion,
      kind,
      producer: { id: data.producer.id, label: data.producer.label ?? null },
      archive: {
        id: data.archive.id,
        createdAt: data.archive.created_at,
        completedAt: data.archive.completed_at ?? null,
        captureStatus: data.archive.capture_status,
        title: data.archive.title,
        question: data.archive.question ?? null,
        summary: data.archive.summary ?? null,
        tags: data.archive.tags,
      },
      origin: {
        agent: data.origin.agent ?? null,
        model: data.origin.model ?? null,
        source: data.origin.source ?? null,
        repositories: data.origin.repositories.map((repository) => ({
          slot: repository.slot,
          label: repository.label ?? null,
          head: repository.head ?? null,
        })),
      },
      primaryArtifactId,
      artifacts,
      missing: data.missing.map((entry) => ({
        kind: entry.kind,
        expectedSource: entry.expected_source ?? null,
        reason: entry.reason,
      })),
      contentDigest: data.content_digest,
    },
  };
}

/**
 * Serialize a manifest back to its wire shape, in the ONE format this build writes.
 *
 * Never `SCOUT_ARCHIVE_FORMAT`. A published bundle is never rewritten, so nothing calls this
 * with a legacy manifest it read; a manifest that came in as legacy and went out as new
 * would be a rewrite of somebody's evidence, which the format forbids.
 *
 * Pretty-printed with two spaces and a trailing newline so a human can read one in a
 * terminal, but readers use FIELDS: nothing in this format depends on byte-for-byte JSON
 * formatting, and a reader that compared serialized text would break the moment a key was
 * added inside version 1.
 */
export function serializeArchiveManifest(manifest: ArchiveManifest): string {
  const body = {
    format: ARCHIVE_FORMAT,
    format_version: manifest.formatVersion,
    kind: manifest.kind,
    producer: { id: manifest.producer.id, label: manifest.producer.label },
    archive: {
      id: manifest.archive.id,
      created_at: manifest.archive.createdAt,
      completed_at: manifest.archive.completedAt,
      capture_status: manifest.archive.captureStatus,
      title: manifest.archive.title,
      question: manifest.archive.question,
      summary: manifest.archive.summary,
      tags: manifest.archive.tags,
    },
    origin: {
      agent: manifest.origin.agent,
      model: manifest.origin.model,
      source: manifest.origin.source,
      repositories: manifest.origin.repositories.map((repository) => ({
        slot: repository.slot,
        label: repository.label,
        head: repository.head,
      })),
    },
    content: {
      primary_artifact_id: manifest.primaryArtifactId,
      artifacts: manifest.artifacts.map((artifact) => ({
        id: artifact.id,
        role: artifact.role,
        repo_slot: artifact.repoSlot,
        original_path: artifact.originalPath,
        archive_path: artifact.archivePath,
        media_type: artifact.mediaType,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      })),
    },
    missing: manifest.missing.map((entry) => ({
      kind: entry.kind,
      expected_source: entry.expectedSource,
      reason: entry.reason,
    })),
    content_digest: manifest.contentDigest,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The read model the daemon serves
// ---------------------------------------------------------------------------

/** One archived file, as the API describes it. Bodies are served by their own route. */
export interface ArchiveArtifactView {
  id: string;
  role: ArchiveArtifactRole;
  repoSlot: string | null;
  originalPath: string | null;
  archivePath: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

/** Why a list row matched, and the text around the match. */
export interface ArchiveSearchSnippet {
  kind: ArchiveSearchSegmentKind;
  text: string;
}

/** The compact row the list route returns. */
export interface ArchiveSummary {
  key: string;
  producerId: string;
  producerLabel: string | null;
  archiveId: string;
  /**
   * What this bundle preserves, or null when this build could not read its manifest.
   *
   * Nullable rather than defaulted, because an unreadable bundle is exactly the case where
   * nothing about its contents is known - and a row that guessed `scout` about a directory
   * whose manifest was refused would be an index that invents provenance.
   */
  kind: ArchiveKind | null;
  status: ArchiveIndexStatus;
  captureStatus: ArchiveCaptureStatus | null;
  title: string;
  question: string | null;
  summary: string | null;
  tags: string[];
  agent: string | null;
  model: string | null;
  source: string | null;
  repositories: ArchiveManifestRepository[];
  createdAt: number | null;
  completedAt: number | null;
  indexedAt: number;
  artifactCount: number;
  bytes: number;
  hasPrimaryReport: boolean;
  missingCount: number;
  error: string | null;
  snippet: ArchiveSearchSnippet | null;
}

/** Everything the detail route adds on top of a summary. */
export interface ArchiveDetail extends ArchiveSummary {
  formatVersion: number;
  contentDigest: string | null;
  /** The absolute directory on THIS machine, for an operator who wants the files. */
  bundlePath: string;
  /** Where it sits under the library root - what stays true when the library moves. */
  relativePath: string;
  primaryArtifactId: string | null;
  artifacts: ArchiveArtifactView[];
  missing: ArchiveManifestMissing[];
}

/** One page of the list route. */
export interface ArchivePage {
  archives: ArchiveSummary[];
  nextCursor: string | null;
  /**
   * Where archives this daemon publishes are written, so a UI can say it without a second
   * route. A bundle discovered under a legacy root carries its own directory on its detail
   * row; this is the one root new work lands in.
   */
  libraryPath: string;
}

/** The bounded query the list route accepts. */
export interface ArchiveSearchQuery {
  q: string | null;
  producer: string | null;
  repo: string | null;
  agent: string | null;
  /** One kind, or null for every kind. An unreadable bundle has none and is filtered out. */
  kind: ArchiveKind | null;
  status: ArchiveIndexStatus | null;
  from: number | null;
  to: number | null;
  cursor: string | null;
  limit: number;
}

/**
 * The list cursor: the sort position of the last row of the previous page.
 *
 * Plain text rather than base64 because every character in it is already URL-safe, and an
 * opaque-looking blob that decodes to the same two fields buys nothing but a decode step.
 * It is still validated strictly on the way in - a cursor is a filter, and a malformed one
 * is refused rather than silently ignored, because paging past a window without noticing
 * is worse than an error the caller can see.
 */
export interface ArchiveListCursor {
  sortAt: number;
  key: string;
}

export function encodeArchiveCursor(cursor: ArchiveListCursor): string {
  return `${cursor.sortAt}.${cursor.key}`;
}

export function decodeArchiveCursor(raw: unknown): ArchiveListCursor | null {
  if (typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const sortAt = Number(raw.slice(0, dot));
  // Negative is legal: a manifest may honestly carry a pre-1970 timestamp, and a decoder that
  // refused one would reject a cursor this module had just produced - a page boundary that
  // 400s only for the operator whose clock or archive is old enough to reach it.
  if (!Number.isSafeInteger(sortAt)) return null;
  const key = raw.slice(dot + 1);
  return parseArchiveKey(key) ? { sortAt, key } : null;
}
