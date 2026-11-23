import { BLOCKED_PLACEMENTS, type BlockedPlacement } from "@shared/protocol.ts";
import { updateUiConfig, useUiConfig } from "../lib/uiConfig.ts";
import { Tooltip } from "./Tooltip.tsx";

const PLACEMENT_COPY: Record<BlockedPlacement, { label: string; description: string }> = {
  "needs-you": {
    label: "In Needs you",
    description:
      "Blocked sessions get their own lane under Needs you, scrolled on its own, always showing at "
      + "least one card.",
  },
  idle: {
    label: "At the top of Idle",
    description: "Blocked sessions sit in a red frame above the idle cards, folded or open.",
  },
  column: {
    label: "Own column",
    description: "Blocked sessions get a column between Needs you and Working, hidden when empty.",
  },
};

/**
 * Reads and writes the shared store directly, as `ResidentPlacementPanel` does, so it is correct
 * on the first paint and the static settings-search harness can render it with no props.
 */
export function BlockedPlacementPanel(): React.JSX.Element {
  const { blockedPlacement } = useUiConfig();
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>Blocked sessions</h3>
      </div>
      <div
        className="layout-picker"
        role="radiogroup"
        aria-label="Where blocked sessions appear"
        data-anchor="display/blocked"
      >
        {BLOCKED_PLACEMENTS.map((id) => (
          <label key={id} className={`layout-option${blockedPlacement === id ? " is-on" : ""}`}>
            <Tooltip label={PLACEMENT_COPY[id].description}>
              <input
                type="radio"
                name="blocked-placement"
                value={id}
                aria-label={PLACEMENT_COPY[id].label}
                checked={blockedPlacement === id}
                onChange={() => void updateUiConfig({ blockedPlacement: id })}
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
        A blocked session that is asking you stays in Needs you, and one that is working stays in
        Working. The Console rail and the arrow keys follow the same placement.
      </p>
    </section>
  );
}
