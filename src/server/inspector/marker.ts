import { createHash } from "node:crypto";

// How the Inspector recognises its own comments on a pull request.
//
// This is the load-bearing piece of the whole feature. The Inspector pushes under the
// operator's GitHub identity, so on the wire its comments are indistinguishable from
// the human's, from another agent's running as the same user, and from a second
// Mission Control on another machine. It resolves threads and answers follow-ups, and
// both of those are wrong - visibly, publicly wrong - if it mistakes someone else's
// comment for its own.
//
// So identity travels IN THE COMMENT, not in our database. The DB is an index over
// what GitHub holds; GitHub is the record. That ordering survives a wiped state dir, a
// fresh clone, a different machine, and a restore from backup, none of which the
// database does.

/**
 * The marker prefix. APPEND-ONLY, like the skill directory prefixes and the env
 * fallback chain: comments carrying `v1` are live on GitHub right now and will be for
 * as long as those PRs exist. Changing this string doesn't migrate them, it ORPHANS
 * them - every one becomes unrecognisable, so it is never resolved and its issue is
 * re-posted as a duplicate on the next round. A new format gets a new version tag
 * parsed ALONGSIDE this one, never instead of it.
 */
const MARKER_PREFIX = "mission-inspector:v1";

/**
 * Matches our marker ONLY at the very start of a body.
 *
 * The anchor is the point, not decoration. GitHub's quote-reply prefixes every line
 * with "> ", so a human replying to one of our comments produces a body that CONTAINS
 * the marker verbatim. A substring test reads that reply as ours, and the Inspector
 * then sees a thread whose newest comment is its own, concludes nobody is waiting, and
 * silently never answers the question it was asked. That is the failure this anchor
 * exists to prevent, and it is the one this file's test suite leads with.
 */
const MARKER_RE = new RegExp(`^<!-- ${MARKER_PREFIX} id=(\\S+) fp=(\\S+) r=(\\d+) -->`);

export interface Marker {
  id: string;
  fingerprint: string;
  round: number;
}

/** Render the marker line. Always first, always column 0 - see `MARKER_RE`. */
export function formatMarker(m: Marker): string {
  return `<!-- ${MARKER_PREFIX} id=${m.id} fp=${m.fingerprint} r=${m.round} -->`;
}

/** Parse our marker off the front of a comment body, or null when it isn't ours. */
export function parseMarker(body: string): Marker | null {
  const m = MARKER_RE.exec(body);
  if (!m) return null;
  return { id: m[1]!, fingerprint: m[2]!, round: Number(m[3]) };
}

/**
 * Whether this comment is one WE wrote.
 *
 * Note what this deliberately does NOT consult: the comment's author. Every comment in
 * play here has the same author - the operator - because that is whose `gh` credential
 * posts them. Author tells us nothing; the marker tells us everything.
 */
export function isOurs(body: string): boolean {
  return parseMarker(body) !== null;
}

/**
 * The identity of an ISSUE on a PR: its file plus its normalized title.
 *
 * Excluding the line number is the whole design. A review comment is anchored to a
 * line, and the next push moves that line - so a fingerprint over the location would
 * change every round and the reviewer would re-raise all of its own findings on every
 * commit, which is the single most obnoxious thing an automated reviewer can do.
 *
 * Normalizing the title (case, whitespace, trailing punctuation) absorbs the small
 * rewordings a model produces when asked the same question twice about the same code.
 * It cannot absorb a genuine rephrase, and that is accepted: the cost is one duplicate
 * comment, against a cost of never noticing an issue came back.
 *
 * Computed HERE, never supplied by the model. The fingerprint is what decides whether
 * to post and what to resolve; a model that could choose it could resolve anything.
 */
export function fingerprint(path: string, title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[`"'*_]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "")
    .trim();
  return createHash("sha1").update(`${path}\n${normalized}`).digest("hex").slice(0, 12);
}
