import { useCallback } from "react";
import type { Session } from "@shared/types.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { ResidentChip } from "./ResidentChip.tsx";
import { residentAccentStyle, type ResidentSessionMark } from "./marker.ts";

/** The line every visitor card carries under the resident's name. */
export const RESIDENT_VISITOR_NOTE = "Resident · opens in the drawer";

/**
 * A resident that needs you, standing in Needs you while the Residents drawer is closed: a
 * dashed outline in its marker color with the chip, its name and where it opens. It is a
 * doorway to the drawer, never a session card - a click or Enter opens the drawer on it.
 *
 * Registered with App like a card or rail row, so the arrow keys reach it, keep it in view and
 * hand it focus. It carries no ⌘-number.
 */
export function ResidentVisitorCard({ session, mark, variant, selected, registerEl, onOpenDrawer }: {
  session: Session;
  mark: ResidentSessionMark;
  /** A Board tile, or a Console (and drill-in) rail row. */
  variant: "tile" | "rail";
  selected: boolean;
  registerEl?: (id: string, el: HTMLElement | null) => void;
  onOpenDrawer: (sessionId: string) => void;
}): React.JSX.Element {
  const setRef = useCallback(
    (el: HTMLElement | null) => registerEl?.(session.id, el),
    [registerEl, session.id],
  );
  const name = mark.name || session.name || "(unnamed)";
  const label = `${name} needs you - resident, opens in the drawer`;
  const open = (): void => onOpenDrawer(session.id);
  const hint = `Open the Residents drawer on ${name}, which needs you`;

  if (variant === "rail") {
    return (
      <Tooltip label={hint}>
        <button
          ref={setRef}
          type="button"
          className={`rail-row tone-attention resident-visitor resident-visitor-rail${selected ? " selected" : ""}`}
          style={residentAccentStyle(mark.colorId)}
          aria-current={selected}
          aria-label={label}
          onClick={open}
        >
          <span className="rail-name">
            <ResidentChip mark={mark} tooltip={false} />
            {name}
          </span>
          <span className="rail-sub resident-visitor-note">{RESIDENT_VISITOR_NOTE}</span>
        </button>
      </Tooltip>
    );
  }
  // The Board tile follows `SessionTile`'s split: the pointer half is the root, the keyboard
  // half a stretched `.tile-open` button App's arrow cursor focuses.
  return (
    <div
      ref={setRef}
      className={`resident-visitor resident-visitor-tile${selected ? " selected" : ""}`}
      style={residentAccentStyle(mark.colorId)}
      onClick={open}
    >
      <Tooltip label={hint}>
        <button
          type="button"
          className="tile-open"
          aria-label={label}
          aria-current={selected}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        />
      </Tooltip>
      <span className="resident-visitor-head">
        <ResidentChip mark={mark} tooltip={false} />
        <span className="resident-visitor-name">{name}</span>
      </span>
      <span className="resident-visitor-note">{RESIDENT_VISITOR_NOTE}</span>
    </div>
  );
}
