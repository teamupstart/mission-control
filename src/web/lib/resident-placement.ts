import type { ResidentPlacement } from "@shared/protocol.ts";
import type { Session } from "@shared/types.ts";
import type { Tone } from "./format.ts";

/**
 * Which residents are placed on the fleet, decided once.
 *
 * The one place the Residents drawer's placement rule lives. App applies `excluded` where the
 * fleet list is built, before `orderSessions`, so the Board columns, the Console rail, the arrow
 * keys and the ⌘-numbers all inherit it and no view branches on placement of its own.
 */
export interface ResidentPlacementInput {
  placement: ResidentPlacement;
  /** The live residents' session ids - the keys of App's `residentBySession` join. */
  residentIds: Iterable<string>;
  /** A resident's tone: the same tone `orderSessions` groups the fleet by. */
  toneOf: (sessionId: string) => Tone | null;
  /** The drawer is on screen: floating open, or pinned as a column. */
  drawerOpen: boolean;
  /**
   * The session whose detail is open, if any. Derived from the selection and the layout, never
   * from the fleet list this result filters, so the rule cannot depend on its own output.
   */
  openDetailId: string | null;
}

export interface ResidentPlacementResult {
  /** Residents kept off the fleet entirely. */
  excluded: ReadonlySet<string>;
  /** Residents drawn as a visitor card in Needs you, standing in for the drawer while it is shut. */
  visitors: ReadonlySet<string>;
  /**
   * Residents that need you, drawn as ordinary rows in the Needs you rail while a detail is
   * open, so a click or an arrow key swaps the conversation between them like any other session.
   */
  asking: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * In `fleet` placement nothing moves. In `drawer` placement every resident leaves the fleet,
 * except one that needs you:
 *
 * - While a detail is open - the Board drill-in or a Console selection - it is an ordinary row
 *   in the Needs you rail, the open resident included, so the rail lists everything asking and
 *   the conversation can move between them. The drawer being on screen does not change that: the
 *   rail is where the operator is answering from.
 * - With no detail open, it leaves for the drawer's Needs you group while the drawer is on
 *   screen, and stands in Needs you as a visitor card while the drawer is closed.
 */
export function residentPlacement(input: ResidentPlacementInput): ResidentPlacementResult {
  if (input.placement === "fleet") return { excluded: NONE, visitors: NONE, asking: NONE };
  const excluded = new Set<string>();
  const visitors = new Set<string>();
  const asking = new Set<string>();
  const detailOpen = input.openDetailId !== null;
  for (const id of input.residentIds) {
    if (input.toneOf(id) !== "attention") excluded.add(id);
    else if (detailOpen) asking.add(id);
    else (input.drawerOpen ? excluded : visitors).add(id);
  }
  return { excluded, visitors, asking };
}

/**
 * Residents the ⌘-numbers step over: a visitor card and a resident asking in the rail. Residents
 * have `⌥1`…`⌥9` of their own, and skipping them keeps the fleet's numbers from shifting while an
 * ask is open or as a detail opens and closes. `residentPlacement` fills at most one of the two
 * sets, by whether a detail is open, so the populated one is the answer.
 */
export function unnumberedResidents(result: ResidentPlacementResult): ReadonlySet<string> {
  return result.asking.size > 0 ? result.asking : result.visitors;
}

/**
 * The session whose detail is open: the fleet list first, and otherwise, in Drawer placement,
 * the live resident with that id. A resident that needs you is on the fleet while its detail is
 * open (see `residentPlacement`); any other open resident is read from here and never added to a
 * fleet list, so the detail pane shows it while the Board columns and rails stay fleet-only.
 */
export function detailSessionLookup(input: {
  id: string | null;
  fleet: readonly Session[];
  sessions: readonly Session[];
  placement: ResidentPlacement;
  isResident: (sessionId: string) => boolean;
}): Session | null {
  const { id } = input;
  if (!id) return null;
  const onFleet = input.fleet.find((session) => session.id === id);
  if (onFleet) return onFleet;
  if (input.placement !== "drawer" || !input.isResident(id)) return null;
  return input.sessions.find((session) => session.id === id) ?? null;
}
