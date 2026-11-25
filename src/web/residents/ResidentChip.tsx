import { Tooltip } from "../components/Tooltip.tsx";
import { residentAccentStyle, residentChipTitle, type ResidentChipMark } from "./marker.ts";

/**
 * A resident's label chip: the profile's short label in its accent, with `⤒` when the run's
 * pinned revision pins it to the top of its column. The one chip the card, the rail row, the
 * Console band and the dock all draw, so the four cannot come to spell a resident differently.
 *
 * Named for assistive tech by its sentence rather than its three letters: "TRI" alone says
 * nothing to a screen reader.
 */
export function ResidentChip({
  mark,
  title,
  tooltip = true,
  expandedName,
}: {
  mark: ResidentChipMark;
  /**
   * The sentence the chip is named by, when the host knows more than the chip does - a running
   * session's `residentMarkTitle`, which says whether its profile has changed since launch.
   */
  title?: string;
  /**
   * False inside a host that already states the resident - the rail row, whose tooltip and
   * description carry the same sentence. The chip is then decoration only: two tooltips on one
   * hover target fight over one bubble, and a second name inside the row's button would
   * lengthen the name every rail selector reads.
   */
  tooltip?: boolean;
  /**
   * The profile name the chip spells out beside its label while its card is pointed at or
   * focused (the board card's Expanding chip style). Drawn only; the chip is already named by
   * `title`, which says the resident's name.
   */
  expandedName?: string;
}): React.JSX.Element {
  const name = title ?? residentChipTitle(mark);
  const chip = (
    <span
      className={expandedName ? "resident-chip has-expanded-name" : "resident-chip"}
      style={residentAccentStyle(mark.colorId)}
      {...(tooltip ? { role: "img", "aria-label": name } : { "aria-hidden": true })}
    >
      {mark.pin && <span className="resident-chip-pin" aria-hidden>⤒</span>}
      <span aria-hidden>{mark.label}</span>
      {expandedName && (
        <span className="resident-chip-name" aria-hidden>
          <span className="resident-chip-name-sep">·</span>
          {expandedName}
        </span>
      )}
    </span>
  );
  return tooltip ? <Tooltip label={name}>{chip}</Tooltip> : chip;
}
