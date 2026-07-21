// Foreman predicates that BOTH the server and the dashboard have to agree on,
// defined once - the same reason `noteKeyFor` and `reportBucket` live in
// src/shared rather than being mirrored by hand on each side.

import { repoAllowlisted } from "./allowlist.ts";
import type { NoteDisposition } from "./types.ts";

export { cwdAllowlisted } from "./allowlist.ts";

/**
 * Whether a note is one the human still owes an answer to.
 *
 * The whole lifecycle rule in one predicate, and shared because the two sides act on it
 * rather than merely display it. The dashboard pins a note that awaits you and unmounts one
 * that does not (`ForemanStrip`); the worker re-confirms the session before writing one,
 * because writing it is what puts a decision in front of someone. Those have to be the same
 * set - a disposition the server considers costless to write and the dashboard pins is a
 * decision nobody decided to ask for.
 *
 * `answered` and `skipped` are terminal: the first was delivered, the second was declined,
 * and neither leaves anything to clear. The record of both lives in the episode log, which
 * is where a finished decision belongs.
 */
export function noteAwaitsYou(disposition: NoteDisposition): boolean {
  return disposition === "escalated" || disposition === "pending";
}

/**
 * Whether Foreman may TYPE in a session, given where it's running (`cwd`) and which
 * repo that checkout belongs to (`repoRoot`).
 *
 * A named alias of the shared `repoAllowlisted` rather than a second implementation:
 * the Inspector asks the identical question about the same paths, and this name is
 * what the server's gate (`foremanMayActLive`) and the work-queue panel's explanation
 * both read as. The panel's whole job there is to answer "why is nothing sending?",
 * so a copy that disagreed by a trailing slash would have the panel promise a send
 * that never comes - see `allowlist.ts` for why the boundary match is the way it is.
 */
export function foremanAllowlisted(
  cwd: string | null,
  repoRoot: string | null,
  allowlist: readonly string[],
): boolean {
  return repoAllowlisted(cwd, repoRoot, allowlist);
}
