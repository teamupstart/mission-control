import { z } from "zod";

/**
 * The portable scout-archive contract: what a completed scout IS, independently of the
 * task, session, worktree, or database that produced it.
 *
 * A scout archive is a directory - `scouts/<producer-id>/<archive-id>/` - holding a
 * `manifest.json`, a `report/` folder whose `report.html` is the answer, and an
 * `artifacts/` folder of explicitly submitted supporting evidence. Everything a reader
 * needs to display, search, and verify one is in those files. SQLite is a disposable
 * projection of them, never the other way round.
 *
 * This module is the format owner and is browser-safe on purpose (no `node:` imports):
 * the daemon writes and verifies bundles with it, the dashboard decodes their keys with
 * it, and a non-TypeScript implementation can reproduce the identity rules from it plus
 * the golden vectors in `test/fixtures/scout-archive/`.
 *
 * Everything here that is written into a bundle - the format name, the version tuple, the
 * status/role/kind vocabularies, the canonical digest encoding, the path rules - is an
 * APPEND-ONLY portable contract. Bundles produced by this build are read by later builds
 * and by other people's machines; renaming a value orphans evidence that no migration can
 * reach, because the evidence is not in this database.
 */

/** The literal `format` string every scout manifest carries. */
export const SCOUT_ARCHIVE_FORMAT = "mission-control/scout-archive";

/**
 * Every archive format version this build can read, append-only.
 *
 * A manifest naming a version outside this tuple is not a corrupt bundle - it is a bundle
 * from a NEWER Mission Control, and the honest answer is "this build cannot read it yet",
 * not a parse failure that looks like damage. `parseScoutManifest` returns that as its own
 * result code so the index can list the archive as unreadable and leave it untouched.
 */
export const SCOUT_ARCHIVE_FORMAT_VERSIONS = [1] as const;
export type ScoutArchiveFormatVersion = (typeof SCOUT_ARCHIVE_FORMAT_VERSIONS)[number];

/** The version this build writes. */
export const SCOUT_ARCHIVE_FORMAT_VERSION: ScoutArchiveFormatVersion = 1;

/**
 * What the archive itself claims about its own completeness, persisted in the manifest.
 *
 * `unreadable` is deliberately NOT here: that is an index verdict about a bundle this
 * build could not accept, and a manifest must not be able to claim it about itself.
 */
export const SCOUT_CAPTURE_STATUSES = ["complete", "partial"] as const;
export type ScoutCaptureStatus = (typeof SCOUT_CAPTURE_STATUSES)[number];

/** What the local index says about a discovered bundle. Persisted in `scout_archives.status`. */
export const SCOUT_INDEX_STATUSES = ["ready", "partial", "unreadable"] as const;
export type ScoutIndexStatus = (typeof SCOUT_INDEX_STATUSES)[number];

/** What one archived file was to the scout. Persisted in the manifest and the index. */
export const SCOUT_ARTIFACT_ROLES = ["primary_report", "report_companion", "supporting"] as const;
export type ScoutArtifactRole = (typeof SCOUT_ARTIFACT_ROLES)[number];

/** What a partial archive is missing, per entry. */
export const SCOUT_MISSING_KINDS = [
  "primary_report",
  "report_companion",
  "supporting_artifact",
] as const;
export type ScoutMissingKind = (typeof SCOUT_MISSING_KINDS)[number];

/**
 * Where one indexed search segment came from.
 *
 * Persisted in `scout_search_segments.source_kind` and reported back as the snippet's
 * provenance, so a result can say WHY it matched - the difference between "the report says
 * this" and "a file was named this".
 */
export const SCOUT_SEARCH_SEGMENT_KINDS = [
  "title",
  "question",
  "summary",
  "tag",
  "provenance",
  "report_text",
  "artifact_path",
] as const;
export type ScoutSearchSegmentKind = (typeof SCOUT_SEARCH_SEGMENT_KINDS)[number];

/** The manifest filename, and the one content path excluded from the canonical digest. */
export const SCOUT_MANIFEST_FILENAME = "manifest.json";
/** The report directory, captured as one relative unit so its local links survive. */
export const SCOUT_REPORT_DIR = "report";
/** Explicitly submitted supporting files, below a generated repository slot. */
export const SCOUT_ARTIFACTS_DIR = "artifacts";
/** The only allowable primary-report path in a complete v1 archive. */
export const SCOUT_PRIMARY_REPORT_PATH = "report/report.html";
/** The reserved artifact id of the primary report. */
export const SCOUT_PRIMARY_ARTIFACT_ID = "report";

/**
 * Reserved directories inside the library root. Neither is ever a producer id (both start
 * with a dot, and a producer id is a UUID), and discovery skips them by name anyway.
 */
export const SCOUT_STAGING_DIR = ".staging";
export const SCOUT_TRASH_DIR = ".trash";

/**
 * Hard limits, applied before a bundle is published locally and again before an imported
 * one is indexed. They protect a local daemon from a bundle - ours or somebody else's -
 * that would take the machine down while being hashed.
 *
 * Kept together so the capture path, the importer, and the documentation cannot disagree
 * about what "too big" means.
 */
export const SCOUT_LIMITS = {
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
  /** `manifest.json` itself - it is metadata, and a huge one is an attack, not a scout. */
  manifestBytes: 4 * 1024 * 1024,
} as const;

/**
 * Bounds on the text a bundle contributes to the index.
 *
 * A manifest is untrusted input even when this daemon wrote it, so every string that
 * reaches a row is truncated here rather than at the display edge: an index that stored
 * whatever a foreign manifest claimed would make a 100 MiB "title" a database problem.
 */
export const SCOUT_TEXT_LIMITS = {
  title: 200,
  question: 1_000,
  summary: 4_000,
  tag: 64,
  tags: 24,
  label: 200,
  /** Visible text extracted from `report/report.html`, in total. */
  reportText: 256 * 1024,
  /** One `scout_search_segments` row. */
  segment: 8 * 1024,
  /** A safe diagnostic stored against an unreadable bundle. */
  error: 500,
  /** A search snippet returned to the browser. */
  snippet: 240,
} as const;

/** Bounds the list route enforces on its own query string. */
export const SCOUT_SEARCH_LIMITS = {
  queryChars: 200,
  defaultLimit: 30,
  maxLimit: 100,
} as const;

// ---------------------------------------------------------------------------
// The submission contract: what a scout hands Mission Control
// ---------------------------------------------------------------------------

/**
 * The checkout-relative convention every scout report is written at.
 *
 * `docs/reports/<slug>/report.html` - its own directory so a CSV, a screenshot, or a log
 * can sit beside the page and be linked from it, and so the whole directory can be captured
 * as ONE relative unit whose internal links keep resolving inside the bundle.
 *
 * The daemon's prompt appendix states this, `skills/html-report/SKILL.md` states this, and a
 * submission naming anything else is refused with the required shape spelled out. Keeping the
 * three in step is what `test/scout-prompt.test.ts` exists for.
 */
export const SCOUT_REPORT_ROOT = "docs/reports";
export const SCOUT_REPORT_FILENAME = "report.html";
/** What a refusal quotes back at whoever got the path wrong. */
export const SCOUT_REPORT_PATH_SHAPE = `${SCOUT_REPORT_ROOT}/<slug>/${SCOUT_REPORT_FILENAME}`;

/**
 * Bounds on a submission, applied at the MCP schema edge and again at the daemon.
 *
 * Separate from `SCOUT_TEXT_LIMITS` even where the numbers agree: those bound what an
 * untrusted manifest may contribute to the INDEX, these bound what a live agent may hand the
 * capture path. They are allowed to diverge, and a reader of either should not have to work
 * out which question a shared constant was answering.
 */
export const SCOUT_SUBMISSION_LIMITS = {
  summary: SCOUT_TEXT_LIMITS.summary,
  tag: SCOUT_TEXT_LIMITS.tag,
  tags: SCOUT_TEXT_LIMITS.tags,
  /** How many additional supporting files one submission may name. */
  supportingFiles: 64,
  /** One checkout-relative source path. */
  sourcePathChars: 1_024,
} as const;

/** How many path segments a slug may occupy - exactly one, directly under `docs/reports`. */
const REPORT_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The slug of a checkout-relative report path, or null when the path is not the convention.
 *
 * Deliberately lenient about the slug's SPELLING and strict about its SHAPE. The slug never
 * becomes a directory name inside a bundle - the report directory is flattened to `report/`,
 * so `docs/reports/Odd_Name/report.html` archives byte-identically to a kebab-case one - and
 * refusing an agent's finished report over a capital letter would cost a completion loop for
 * nothing. What is enforced is what capture and exit recovery actually depend on: exactly
 * three segments, the literal `docs/reports` root, exactly one slug segment that cannot be
 * `.`, `..`, or hidden, and the literal `report.html` leaf.
 */
export function scoutReportSlug(checkoutRelativePath: unknown): string | null {
  if (typeof checkoutRelativePath !== "string") return null;
  if (checkoutRelativePath.length > SCOUT_SUBMISSION_LIMITS.sourcePathChars) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(checkoutRelativePath)) return null;
  const segments = checkoutRelativePath.split("/");
  if (segments.length !== 4) return null;
  const [docs, reports, slug, leaf] = segments as [string, string, string, string];
  if (`${docs}/${reports}` !== SCOUT_REPORT_ROOT) return null;
  if (leaf !== SCOUT_REPORT_FILENAME) return null;
  return REPORT_SLUG_RE.test(slug) ? slug : null;
}

/** The report directory a submitted report path names, e.g. `docs/reports/resume/`. */
export function scoutReportDirectory(checkoutRelativePath: string): string | null {
  const slug = scoutReportSlug(checkoutRelativePath);
  return slug === null ? null : `${SCOUT_REPORT_ROOT}/${slug}`;
}

/**
 * One additional supporting file, located by a SERVER-ISSUED repository slot.
 *
 * The slot is the whole point. A scout may have several checkouts attached and cannot be
 * trusted to name one by path - an absolute path is exactly what capture must never accept -
 * so the task's repository manifest issues `repo-01`, `repo-02`, and a locator is that plus a
 * path relative to the checkout it names.
 */
export interface ScoutSupportingLocator {
  repoSlot: string;
  path: string;
}

/**
 * Everything a scout may say about its own archive, and nothing more.
 *
 * There is no task id, session id, work episode, producer id, archive id, destination,
 * absolute source, digest, or completion status here, by design: all of it is derived from
 * the authenticated session, so a field on the wire could only ever be a field used to
 * archive on somebody else's behalf or to somewhere else.
 */
export interface ScoutSubmissionInput {
  reportPath: string;
  summary: string;
  tags: string[];
  supporting: ScoutSupportingLocator[];
}

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
export const SCOUT_ARCHIVE_KEY_SEPARATOR = "~";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether a value is a generated archive identity component.
 *
 * LOWERCASE ONLY, and that is load-bearing rather than tidy: these strings are directory
 * names, and macOS's default filesystem is case-insensitive, so accepting `A1B2…` beside
 * `a1b2…` would make one bundle addressable under two keys that cannot both exist on
 * disk. `randomUUID()` emits lowercase, so nothing this app writes is affected.
 */
export function isScoutId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** A bundle's global identity: the producer that made it, and the archive itself. */
export interface ScoutArchiveIdentity {
  producerId: string;
  archiveId: string;
}

/** The composite key routes, SQLite, and the browser all address an archive by. */
export function scoutArchiveKey(producerId: string, archiveId: string): string {
  return `${producerId}${SCOUT_ARCHIVE_KEY_SEPARATOR}${archiveId}`;
}

/**
 * Decode an archive key, or null when it is not one.
 *
 * This runs BEFORE any path is joined, on every route, which is the whole point: the two
 * components become directory names, so "is this a generated UUID" is the check that stops
 * a request naming `..` or an absolute path from reaching the filesystem at all.
 */
export function parseScoutArchiveKey(key: unknown): ScoutArchiveIdentity | null {
  if (typeof key !== "string") return null;
  const parts = key.split(SCOUT_ARCHIVE_KEY_SEPARATOR);
  if (parts.length !== 2) return null;
  const [producerId, archiveId] = parts;
  if (!isScoutId(producerId) || !isScoutId(archiveId)) return null;
  return { producerId, archiveId };
}

/** Generated repository slots (`repo-01`), the only directory component under `artifacts/`. */
const REPO_SLOT_RE = /^repo-[0-9]{2,3}$/;

export function isScoutRepoSlot(value: unknown): value is string {
  return typeof value === "string" && REPO_SLOT_RE.test(value);
}

/** The slot for the nth attached repository, one-based. */
export function scoutRepoSlot(ordinal: number): string {
  return `repo-${String(ordinal).padStart(2, "0")}`;
}

/** Generated artifact ids: `report` for the primary, `artifact-01` onward for the rest. */
const ARTIFACT_ID_RE = /^(?:report|artifact-[0-9]{2,4})$/;

export function isScoutArtifactId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_ID_RE.test(value);
}

/** The generated id for the nth non-primary artifact, one-based. */
export function scoutArtifactId(ordinal: number): string {
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
export function validateScoutArchivePath(raw: unknown): string | null {
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
  if (root !== SCOUT_REPORT_DIR && root !== SCOUT_ARTIFACTS_DIR) return null;
  if (segments.length < 2) return null;
  if (root === SCOUT_ARTIFACTS_DIR && !isScoutRepoSlot(segments[1])) return null;
  return raw;
}

/** Whether an archive path lives inside the report directory. */
export function isScoutReportPath(archivePath: string): boolean {
  return archivePath.startsWith(`${SCOUT_REPORT_DIR}/`);
}

// ---------------------------------------------------------------------------
// Canonical content digest
// ---------------------------------------------------------------------------

/** One row of the canonical content table: what a file is, by identity rather than by name. */
export interface ScoutContentEntry {
  archivePath: string;
  bytes: number;
  sha256: string;
}

/** How a SHA-256 is written everywhere in this format. */
export const SCOUT_DIGEST_PREFIX = "sha256:";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** `sha256:<64 lowercase hex>` from bare hex, or null when the hex is not one. */
export function formatScoutDigest(hex: string): string | null {
  return SHA256_HEX_RE.test(hex) ? `${SCOUT_DIGEST_PREFIX}${hex}` : null;
}

/** The bare hex of a `sha256:` digest string, or null when it is not one. */
export function scoutDigestHex(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith(SCOUT_DIGEST_PREFIX)) return null;
  const hex = value.slice(SCOUT_DIGEST_PREFIX.length);
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
 * (`validateScoutArchivePath` refuses control characters), so no entry can forge a row
 * boundary either. Sorting is by UTF-16 code unit (`<`), which is what
 * `Array.prototype.sort` does with no comparator and what every JS implementation agrees
 * on; paths are ASCII-dominant in practice and the rule is stated rather than inferred.
 *
 * Golden vectors live in `test/fixtures/scout-archive/golden-digests.json`.
 */
export function canonicalScoutContentPayload(entries: readonly ScoutContentEntry[]): string {
  const rows = entries
    .filter((entry) => entry.archivePath !== SCOUT_MANIFEST_FILENAME)
    .map((entry) => ({
      path: entry.archivePath,
      bytes: entry.bytes,
      hex: scoutDigestHex(entry.sha256) ?? entry.sha256,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows.map((row) => `${row.hex} ${row.bytes} ${row.path}\n`).join("");
}

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** Who made the archive. The label is an unverified, informational claim. */
export interface ScoutManifestProducer {
  id: string;
  label: string | null;
}

/** One repository the scout looked at. Informational: no checkout has to exist to read this. */
export interface ScoutManifestRepository {
  slot: string;
  label: string | null;
  head: string | null;
}

/** What the scout was asked, what it found, and when. */
export interface ScoutManifestArchive {
  id: string;
  createdAt: string;
  completedAt: string | null;
  captureStatus: ScoutCaptureStatus;
  title: string;
  question: string | null;
  summary: string | null;
  tags: string[];
}

/** Where the scout ran. Every field is nullable: a foreign bundle may know none of it. */
export interface ScoutManifestOrigin {
  agent: string | null;
  model: string | null;
  source: string | null;
  repositories: ScoutManifestRepository[];
}

/** One archived file. */
export interface ScoutManifestArtifact {
  id: string;
  role: ScoutArtifactRole;
  repoSlot: string | null;
  originalPath: string | null;
  archivePath: string;
  mediaType: string | null;
  bytes: number;
  sha256: string;
}

/** One honest omission in a partial archive. */
export interface ScoutManifestMissing {
  kind: ScoutMissingKind;
  expectedSource: string | null;
  reason: string;
}

/** A parsed, internally consistent v1 manifest. Byte-level verification is the server's. */
export interface ScoutManifest {
  formatVersion: ScoutArchiveFormatVersion;
  producer: ScoutManifestProducer;
  archive: ScoutManifestArchive;
  origin: ScoutManifestOrigin;
  primaryArtifactId: string | null;
  artifacts: ScoutManifestArtifact[];
  missing: ScoutManifestMissing[];
  contentDigest: string;
}

/** Why a manifest was refused. Persisted nowhere; carried into a safe index diagnostic. */
export const SCOUT_MANIFEST_PROBLEMS = [
  "not_an_object",
  "wrong_format",
  "unsupported_version",
  "schema",
  "path",
  "identity",
  "primary_report",
  "limits",
] as const;
export type ScoutManifestProblem = (typeof SCOUT_MANIFEST_PROBLEMS)[number];

export type ScoutManifestParseResult =
  | { ok: true; manifest: ScoutManifest }
  | {
      ok: false;
      problem: ScoutManifestProblem;
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
    label: z.string().max(SCOUT_TEXT_LIMITS.label).nullish(),
  }),
  archive: z.object({
    id: NonEmpty,
    created_at: Timestamp,
    completed_at: Timestamp.nullish(),
    capture_status: z.enum(SCOUT_CAPTURE_STATUSES),
    title: z.string().min(1).max(SCOUT_TEXT_LIMITS.title),
    question: z.string().max(SCOUT_TEXT_LIMITS.question).nullish(),
    summary: z.string().max(SCOUT_TEXT_LIMITS.summary).nullish(),
    tags: z.array(z.string().min(1).max(SCOUT_TEXT_LIMITS.tag)).max(SCOUT_TEXT_LIMITS.tags).default([]),
  }),
  origin: z
    .object({
      agent: z.string().max(SCOUT_TEXT_LIMITS.label).nullish(),
      model: z.string().max(SCOUT_TEXT_LIMITS.label).nullish(),
      source: z.string().max(SCOUT_TEXT_LIMITS.label).nullish(),
      repositories: z
        .array(
          z.object({
            slot: NonEmpty,
            label: z.string().max(SCOUT_TEXT_LIMITS.label).nullish(),
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
          role: z.enum(SCOUT_ARTIFACT_ROLES),
          repo_slot: z.string().max(64).nullish(),
          original_path: z.string().max(MAX_ARCHIVE_PATH_CHARS).nullish(),
          archive_path: NonEmpty,
          media_type: z.string().max(128).nullish(),
          bytes: z.number().int().nonnegative(),
          sha256: NonEmpty,
        }),
      )
      .max(SCOUT_LIMITS.entries),
  }),
  missing: z
    .array(
      z.object({
        kind: z.enum(SCOUT_MISSING_KINDS),
        expected_source: z.string().max(MAX_ARCHIVE_PATH_CHARS).nullish(),
        reason: z.string().min(1).max(SCOUT_TEXT_LIMITS.error),
      }),
    )
    .max(64)
    .default([]),
  content_digest: NonEmpty,
});

function refuse(
  problem: ScoutManifestProblem,
  reason: string,
  formatVersion: number | null = null,
): ScoutManifestParseResult {
  return { ok: false, problem, reason, formatVersion };
}

/**
 * Read a `manifest.json` value into a checked v1 manifest.
 *
 * Version is settled BEFORE the shape is parsed, so a version-2 bundle is reported as
 * unsupported rather than as fifty schema errors about a shape it never claimed to have.
 *
 * What this proves is everything decidable from the file alone: the format, the version,
 * generated identities, path legality and uniqueness, the primary-report rule, and the
 * declared totals against the hard limits. What it deliberately does NOT prove is anything
 * about the filesystem - that the files exist, that their bytes match, that the content
 * digest is right. Those need the bundle, and they belong to the server-side verifier, so
 * this function stays usable in a browser and in a test with no directory at all.
 */
export function parseScoutManifest(value: unknown): ScoutManifestParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse("not_an_object", "manifest is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.format !== SCOUT_ARCHIVE_FORMAT) {
    return refuse("wrong_format", "manifest is not a Mission Control scout archive");
  }
  const rawVersion = record.format_version;
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
    return refuse("schema", "manifest format_version is not an integer");
  }
  if (!(SCOUT_ARCHIVE_FORMAT_VERSIONS as readonly number[]).includes(rawVersion)) {
    return refuse(
      "unsupported_version",
      `archive format version ${rawVersion} is newer than this build understands`,
      rawVersion,
    );
  }
  const formatVersion = rawVersion as ScoutArchiveFormatVersion;

  const parsed = ManifestV1Schema.safeParse(record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return refuse("schema", `${where}${issue?.message ?? "manifest does not match version 1"}`, formatVersion);
  }
  const data = parsed.data;

  if (!isScoutId(data.producer.id)) {
    return refuse("identity", "producer id is not a generated identifier", formatVersion);
  }
  if (!isScoutId(data.archive.id)) {
    return refuse("identity", "archive id is not a generated identifier", formatVersion);
  }
  if (!scoutDigestHex(data.content_digest)) {
    return refuse("schema", "content_digest is not a sha256 digest", formatVersion);
  }

  const slots = new Set<string>();
  for (const repository of data.origin.repositories) {
    if (!isScoutRepoSlot(repository.slot)) {
      return refuse("identity", `repository slot ${repository.slot} is not generated`, formatVersion);
    }
    if (slots.has(repository.slot)) {
      return refuse("identity", `repository slot ${repository.slot} appears twice`, formatVersion);
    }
    slots.add(repository.slot);
  }

  const artifacts: ScoutManifestArtifact[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  let totalBytes = 0;
  let reportBytes = 0;
  let reportEntries = 0;
  for (const artifact of data.content.artifacts) {
    if (!isScoutArtifactId(artifact.id)) {
      return refuse("identity", `artifact id ${artifact.id} is not generated`, formatVersion);
    }
    if (seenIds.has(artifact.id)) {
      return refuse("identity", `artifact id ${artifact.id} appears twice`, formatVersion);
    }
    seenIds.add(artifact.id);
    const archivePath = validateScoutArchivePath(artifact.archive_path);
    if (!archivePath) {
      return refuse("path", `artifact ${artifact.id} has an unusable archive path`, formatVersion);
    }
    if (seenPaths.has(archivePath)) {
      return refuse("path", `two artifacts claim ${archivePath}`, formatVersion);
    }
    seenPaths.add(archivePath);
    if (!scoutDigestHex(artifact.sha256)) {
      return refuse("schema", `artifact ${artifact.id} has no sha256 digest`, formatVersion);
    }
    if (artifact.repo_slot != null && !isScoutRepoSlot(artifact.repo_slot)) {
      return refuse("identity", `artifact ${artifact.id} names an ungenerated repo slot`, formatVersion);
    }
    if (!isScoutReportPath(archivePath)) {
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
    if (isScoutReportPath(archivePath)) {
      reportBytes += artifact.bytes;
      reportEntries += 1;
    }
    if (artifact.role === "supporting" && artifact.bytes > SCOUT_LIMITS.supportingFileBytes) {
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

  if (reportEntries > SCOUT_LIMITS.reportDirectoryEntries) {
    return refuse("limits", "the report directory declares too many files", formatVersion);
  }
  if (reportBytes > SCOUT_LIMITS.reportDirectoryBytes) {
    return refuse("limits", "the report directory exceeds its size limit", formatVersion);
  }
  if (totalBytes > SCOUT_LIMITS.bundleBytes) {
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
    if (primary.archivePath !== SCOUT_PRIMARY_REPORT_PATH) {
      return refuse(
        "primary_report",
        `the primary report must be ${SCOUT_PRIMARY_REPORT_PATH}`,
        formatVersion,
      );
    }
    if (primary.bytes > SCOUT_LIMITS.primaryReportBytes) {
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
 * Serialize a manifest back to its wire shape.
 *
 * Pretty-printed with two spaces and a trailing newline so a human can read one in a
 * terminal, but readers use FIELDS: nothing in this format depends on byte-for-byte JSON
 * formatting, and a reader that compared serialized text would break the moment a key was
 * added inside version 1.
 */
export function serializeScoutManifest(manifest: ScoutManifest): string {
  const body = {
    format: SCOUT_ARCHIVE_FORMAT,
    format_version: manifest.formatVersion,
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
export interface ScoutArtifactView {
  id: string;
  role: ScoutArtifactRole;
  repoSlot: string | null;
  originalPath: string | null;
  archivePath: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

/** Why a list row matched, and the text around the match. */
export interface ScoutSearchSnippet {
  kind: ScoutSearchSegmentKind;
  text: string;
}

/** The compact row the list route returns. */
export interface ScoutArchiveSummary {
  key: string;
  producerId: string;
  producerLabel: string | null;
  archiveId: string;
  status: ScoutIndexStatus;
  captureStatus: ScoutCaptureStatus | null;
  title: string;
  question: string | null;
  summary: string | null;
  tags: string[];
  agent: string | null;
  model: string | null;
  source: string | null;
  repositories: ScoutManifestRepository[];
  createdAt: number | null;
  completedAt: number | null;
  indexedAt: number;
  artifactCount: number;
  bytes: number;
  hasPrimaryReport: boolean;
  missingCount: number;
  error: string | null;
  snippet: ScoutSearchSnippet | null;
}

/** Everything the detail route adds on top of a summary. */
export interface ScoutArchiveDetail extends ScoutArchiveSummary {
  formatVersion: number;
  contentDigest: string | null;
  /** The absolute directory on THIS machine, for an operator who wants the files. */
  bundlePath: string;
  /** Where it sits under the library root - what stays true when the library moves. */
  relativePath: string;
  primaryArtifactId: string | null;
  artifacts: ScoutArtifactView[];
  missing: ScoutManifestMissing[];
}

/** One page of the list route. */
export interface ScoutArchivePage {
  archives: ScoutArchiveSummary[];
  nextCursor: string | null;
  /** Where the library lives, so a UI can say it without a second route. */
  libraryPath: string;
}

/** The bounded query the list route accepts. */
export interface ScoutSearchQuery {
  q: string | null;
  producer: string | null;
  repo: string | null;
  agent: string | null;
  status: ScoutIndexStatus | null;
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
export interface ScoutListCursor {
  sortAt: number;
  key: string;
}

export function encodeScoutCursor(cursor: ScoutListCursor): string {
  return `${cursor.sortAt}.${cursor.key}`;
}

export function decodeScoutCursor(raw: unknown): ScoutListCursor | null {
  if (typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const sortAt = Number(raw.slice(0, dot));
  // Negative is legal: a manifest may honestly carry a pre-1970 timestamp, and a decoder that
  // refused one would reject a cursor this module had just produced - a page boundary that
  // 400s only for the operator whose clock or archive is old enough to reach it.
  if (!Number.isSafeInteger(sortAt)) return null;
  const key = raw.slice(dot + 1);
  return parseScoutArchiveKey(key) ? { sortAt, key } : null;
}
