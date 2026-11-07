import { RESIDENT_PLACEMENTS, type ResidentPlacement } from "@shared/protocol.ts";
import { updateUiConfig, useUiConfig } from "../lib/uiConfig.ts";
import { Tooltip } from "./Tooltip.tsx";

/** The two answers, in the words the setting is asked in. */
const PLACEMENT_COPY: Record<ResidentPlacement, { label: string; description: string }> = {
  drawer: {
    label: "Drawer",
    description:
      "Residents live in a drawer on the right edge, opened from the top bar, ⇧H or the edge tab. "
      + "The Board and Console hold task sessions only; a resident that needs you shows a visitor "
      + "card in Needs you while the drawer is closed.",
  },
  fleet: {
    label: "Board and Console",
    description:
      "Residents sit in the Board columns and the Console rail beside every other session, with "
      + "their marker, and the top bar's Residents button opens the dock.",
  },
};

/**
 * Settings → Display → Residents: where live residents are drawn. A preference about this
 * screen, persisted per machine beside Layout, and applied live behind the settings page.
 *
 * Reads and writes the shared store directly, as `LayoutPanel`'s toggles do, so it is correct
 * on the first paint and the static settings-search harness can render it with no props.
 */
export function ResidentPlacementPanel(): React.JSX.Element {
  const { residentPlacement } = useUiConfig();
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Residents</h3>
      </div>
      <div
        className="layout-picker"
        role="radiogroup"
        aria-label="Where residents live"
        data-anchor="display/residents"
      >
        {RESIDENT_PLACEMENTS.map((id) => (
          <label key={id} className={`layout-option${residentPlacement === id ? " is-on" : ""}`}>
            <Tooltip label={PLACEMENT_COPY[id].description}>
              <input
                type="radio"
                name="resident-placement"
                value={id}
                aria-label={PLACEMENT_COPY[id].label}
                checked={residentPlacement === id}
                onChange={() => void updateUiConfig({ residentPlacement: id })}
              />
            </Tooltip>
            <span className="layout-option-text">
              <span className="layout-option-label">{PLACEMENT_COPY[id].label}</span>
              <span className="layout-option-desc">{PLACEMENT_COPY[id].description}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        Either way a resident opens on the same full detail, by click, <kbd>Enter</kbd>,{" "}
        <kbd>⌥1</kbd>…<kbd>⌥9</kbd> or the <kbd>⌘K</kbd> palette, and the Need you count, desktop
        alerts and the chime still include residents.
      </p>
    </section>
  );
}

/**
 * The one line a setting that acts on residents' place in the fleet shows while residents live
 * in the drawer, where there is no Board card or rail row for it to act on.
 */
export function ResidentDrawerInertNote({ what }: { what: string }): React.JSX.Element | null {
  const { residentPlacement } = useUiConfig();
  if (residentPlacement !== "drawer") return null;
  return (
    // A span drawn as a block, so it can sit inside a toggle's inline description as well as
    // under a fieldset.
    <span className="resident-inert-note" role="note">
      {what} applies only when residents live on the Board and Console (Settings → Display →
      Residents). In the drawer there is no Board card or rail row for it to act on.
    </span>
  );
}
