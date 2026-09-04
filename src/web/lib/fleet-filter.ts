import type { Session } from "../../shared/types.ts";
import { stateDisplay } from "./format.ts";

/**
 * True when a session matches the normalized nav-bar query. Matches on the session title,
 * its human status label, the agent type, and the pull-request label visible on its card.
 * Deliberately uses the display label instead of raw `state`: a passively discovered
 * session's raw state is "working" while its badge reads "running", so indexing raw state
 * would make "working" match every live session rather than what the operator can see.
 */
export function matchesSessionFilter(session: Session, query: string): boolean {
  const pullRequestLabel = session.prUrl && session.prNumber !== null
    ? `PR #${session.prNumber}`
    : "";
  const haystack = [
    session.name,
    stateDisplay(session).label,
    session.agent,
    pullRequestLabel,
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}
