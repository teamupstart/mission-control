import { ARCHIVE_TEXT_LIMITS } from "./archives.ts";

/**
 * The scout submission contract: what a live scout hands Mission Control, and where it
 * writes the page it hands over.
 *
 * Split from `archives.ts` deliberately. That module owns the BUNDLE - identity, paths,
 * digests, the manifest - and says nothing about scouting, because a bundle's kind is the
 * only thing that differs between one kind of archive and another. This module owns the one
 * thing that is genuinely scout-shaped: the checkout convention a scout's report is written
 * at, and the shape of the call that submits it. A second kind captured into the same
 * library brings its own module beside this one; neither reaches into the other.
 *
 * Browser-safe (no `node:` imports) for `archives.ts`'s reason: `protocol.ts` builds the MCP
 * submission schema from these bounds and the dashboard bundle imports it.
 */

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
 * Separate from `ARCHIVE_TEXT_LIMITS` even where the numbers agree: those bound what an
 * untrusted manifest may contribute to the INDEX, these bound what a live agent may hand the
 * capture path. They are allowed to diverge, and a reader of either should not have to work
 * out which question a shared constant was answering.
 */
export const SCOUT_SUBMISSION_LIMITS = {
  summary: ARCHIVE_TEXT_LIMITS.summary,
  tag: ARCHIVE_TEXT_LIMITS.tag,
  tags: ARCHIVE_TEXT_LIMITS.tags,
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
