import { fmtUsd } from "@shared/cost.ts";
import type { Session, SessionCost } from "@shared/types.ts";
import { compactTokens } from "./format.ts";

/**
 * The plain text a session card prints for facts that are not React-specific, shared by the
 * component that draws them (`components/session-bits.tsx`) and the nav-bar search that
 * matches on them (`lib/fleet-filter.ts`). Here rather than in the component module so a pure
 * filter never pulls the component graph in.
 */

/**
 * Where this session was found, phrased for the small grey subtitle.
 *
 * The pane id rides along only for a MULTIPLEXER, and that asymmetry is about the axis
 * rather than about tmux: a multiplexer names a SESSION that may hold many panes, so which
 * pane this card is only answerable by saying it, while an emulator names the tab itself
 * and has nothing left to disambiguate. Both shipped backends read exactly as they always
 * did; a third one inherits whichever rule its axis already states.
 */
export function subtitle(session: Session): string {
  if (session.runtime === "sdk") return RUNTIME_LABEL;
  const namer = session.terminals.find((h) => h.backend === session.nameSource);
  if (namer?.kind === "multiplexer") return `${namer.backend} · ${namer.paneId}`;
  return session.nameSource;
}

/**
 * What an embedded session is called where a pane string would go.
 *
 * "Agent SDK" rather than the `sdk` the `NameSource` spells, because this line answers
 * "where is this session?" for a human, and the honest answer is that there is nowhere to
 * go and look - it runs inside Mission Control. Named once and shared by all four
 * surfaces, so the three mark vocabularies say the same word.
 */
export const RUNTIME_LABEL = "Agent SDK";

/**
 * The text the cost chip prints, or null when it draws nothing. One spelling for the chip and
 * for the nav-bar search, so a query for what the card reads always finds the card.
 */
export function costChipText(cost: SessionCost | null): string | null {
  if (!cost) return null;
  if (cost.costUsd === null) {
    const total = cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
    return total > 0 ? `${compactTokens(total)} tok` : null;
  }
  return cost.costUsd > 0 ? `≈${fmtUsd(cost.costUsd)}` : null;
}
