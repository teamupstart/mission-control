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

/**
 * How many episodes the fleet-wide settings ledger carries.
 *
 * Shared so the panel can SAY the number in its footer rather than describing the list as
 * "recent" and leaving the operator to wonder whether an absence means nothing happened or
 * merely that it fell off the end. The table itself is pruned at 30 days
 * (`EPISODE_RETENTION_MS`); this is only the display cap.
 */
export const FOREMAN_EPISODE_LEDGER = 100;

/**
 * What the cheap tier decided, when it was asked at all.
 *
 * The first three are `Verdict.action`; `route-up` is the cheap tier declining to decide
 * and asking for the full review, which is not an action but is the answer to "what did
 * tier 1 do" on a large share of episodes. Kept as one union so the panel can style the
 * decline differently from a decision without re-deriving it from a null.
 */
export const CHEAP_ACTIONS = ["answer", "escalate", "skip", "route-up"] as const;
export type CheapAction = (typeof CHEAP_ACTIONS)[number];

/**
 * How the cheap tier's decision compared with the full reviewer's, under `shadow`.
 *
 * Lives in shared because the browser has to NAME these values to render them, while the
 * classifier that produces them (`classifyDivergence`, `foreman/triage.ts`) stays on the
 * server - the same split `HARNESS_CAPABILITIES` makes against `HARNESSES`.
 *
 * `cheap-over-eager` is the one that matters, and the reason the whole measurement is
 * worth persisting: the cheap tier would have auto-answered where the full review would
 * not. That has to stay near zero before an operator flips the tier to `on`, and until
 * this was a column it could only be counted by tailing the worker's stdout.
 *
 * `deferred` means the cheap tier routed up, so there was nothing to compare - distinct
 * from `agree`, and conflating them would flatter the cheap tier by counting every
 * decline as a match.
 */
export const DIVERGENCE_KINDS = [
  "deferred",
  "agree",
  "cheap-over-eager",
  "cheap-too-cautious",
  "minor",
] as const;
export type Divergence = (typeof DIVERGENCE_KINDS)[number];

/**
 * Read a persisted cheap action back, or null.
 *
 * Null is "not measured", which is what every row written before the shadow columns
 * existed says, and what every `off`/`on` posture writes. An unrecognised value - a row
 * from a newer build - is also null rather than a nearest match, the rule the schedule
 * store states: a divergence this build cannot read must not be rendered as one it can.
 */
export function readCheapAction(v: unknown): CheapAction | null {
  return CHEAP_ACTIONS.includes(v as CheapAction) ? (v as CheapAction) : null;
}

/** The same, for the divergence. See `readCheapAction`. */
export function readDivergence(v: unknown): Divergence | null {
  return DIVERGENCE_KINDS.includes(v as Divergence) ? (v as Divergence) : null;
}
