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
}

const NONE: ReadonlySet<string> = new Set();

/**
 * In `fleet` placement nothing moves. In `drawer` placement every resident leaves the fleet,
 * except one that needs you while the drawer is closed: it stays as a visitor card. Its own open
 * detail already shows its ask, so that resident is not a visitor while its detail is open.
 */
export function residentPlacement(input: ResidentPlacementInput): ResidentPlacementResult {
  if (input.placement === "fleet") return { excluded: NONE, visitors: NONE };
  const excluded = new Set<string>();
  const visitors = new Set<string>();
  for (const id of input.residentIds) {
    const visitor = !input.drawerOpen
      && id !== input.openDetailId
      && input.toneOf(id) === "attention";
    (visitor ? visitors : excluded).add(id);
  }
  return { excluded, visitors };
}

/**
 * The session whose detail is open: the fleet list first, and otherwise, in Drawer placement,
 * the live resident with that id. An open resident is read from here and never added to a fleet
 * list, so the detail pane shows it while the Board columns and rails stay fleet-only.
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
