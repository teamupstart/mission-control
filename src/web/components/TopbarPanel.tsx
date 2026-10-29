import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { UI_CONFIG_DEFAULTS } from "@shared/protocol.ts";
import {
  isTopbarItemCompact,
  isTopbarItemShown,
  resetTopbarLayout,
  setTopbarItemCompact,
  setTopbarItemShown,
  TOPBAR_ITEMS,
  useTopbarLayout,
  type CompactableTopbarItemId,
  type OptionalTopbarItemId,
  type TopbarLayout,
} from "../lib/topbar-items.ts";
import { PREVIEW_FOREMAN, PREVIEW_TOPBAR_FLEET, previewFleetCost } from "../lib/topbar-preview.ts";
import { Tooltip } from "./Tooltip.tsx";
import { Topbar } from "./Topbar.tsx";

const noop = (): void => {};
const noopAsync = async (): Promise<void> => {};

/**
 * The real `Topbar`, against a fixture fleet, drawn at its natural one-row width and zoomed
 * down to the stage.
 *
 * Zoomed rather than scrolled or squeezed. Squeezing would run the bar into wrapping, which
 * is the ladder's business on the page and has nothing to say about the operator's choices;
 * scrolling would hide half of the thing being compared. The ratio is re-measured after every
 * render, because hiding or minimizing an item is exactly a change in the bar's width.
 *
 * `inert` and `aria-hidden` both, unlike the card preview's `inert` alone: this copy carries
 * every one of the bar's named controls - Dispatch, Settings, the Pages navigation - and a
 * second "Dispatch" button in the accessibility tree is a second answer to "where is
 * Dispatch". The checklist beside it is the accessible statement of the same choices.
 */
function TopbarPreview({ layout }: { layout: TopbarLayout }): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const fleetCost = useMemo(() => previewFleetCost(Date.now()), []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const inner = zoomRef.current;
    if (!stage || !inner) return;
    const fit = (): void => {
      const current = Number(inner.style.zoom || 1);
      const natural = inner.getBoundingClientRect().width / current;
      const room = stage.clientWidth;
      if (natural <= 0 || room <= 0) return;
      const next = Math.min(1, room / natural);
      if (Math.abs(next - current) > 0.002) setZoom(next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  });

  return (
    <div className="topbar-preview-wrap">
      <span className="board-card-preview-cap" aria-hidden>
        Preview
      </span>
      <div className="board-card-preview-stage topbar-preview-stage" ref={stageRef} inert aria-hidden>
        <div ref={zoomRef} style={{ zoom, width: "max-content" }}>
          <Topbar
            preview
            layout={layout}
            page="fleet"
            onNavigatePage={noop}
            filter=""
            onFilterChange={noop}
            connected
            keepAwake={null}
            {...PREVIEW_TOPBAR_FLEET}
            onOpenInbox={noop}
            fleetCost={fleetCost}
            costView="usd"
            onOpenCostSettings={noop}
            scheduleAttentionCount={0}
            onOpenMissions={noop}
            foreman={PREVIEW_FOREMAN}
            onOpenModels={noop}
            onOpenForemanSettings={noop}
            onOpenDispatch={noop}
            onOpenFeedback={noop}
            gearDot={null}
            gearPhrase={null}
            onGear={noop}
            alertSettings={UI_CONFIG_DEFAULTS.alerts}
            updateAlerts={noop}
            away={null}
            setAway={noopAsync}
            buffered={null}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Display > Top bar: which optional items the bar draws, and which of its controls stay
 * minimized.
 *
 * Two lists because they are two questions about two kinds of item (`lib/topbar-items.ts`).
 * An optional item is a checkbox, as on the Board card panel. A control that cannot be removed
 * gets an Expanded / Minimized pair instead of a checkbox, because "unchecked" would read as
 * "gone" - which is the one thing that control can never be.
 *
 * No props and no fetch, like `BoardCardPanel`: `useUiConfig()` is synchronous with shipped
 * defaults, so every control is present on the first paint.
 */
export function TopbarPanel(): React.JSX.Element {
  const layout = useTopbarLayout();
  const optional = TOPBAR_ITEMS.filter((item) => item.kind === "optional");
  const compactable = TOPBAR_ITEMS.filter((item) => item.kind === "compactable");
  const customized = layout.hidden.length > 0 || layout.compact.length > 0;

  return (
    <section className="settings-section" data-anchor="display/topbar">
      <div className="settings-section-head">
        <h3>Top bar</h3>
        {customized && (
          <Tooltip label="Show every item and expand every control, as the bar shipped">
            <button type="button" className="btn btn-ghost" onClick={resetTopbarLayout}>
              Reset all
            </button>
          </Tooltip>
        )}
      </div>
      <p className="settings-hint settings-blurb">
        Choose what the bar across the top of every page draws. However you set it, the bar
        still minimizes what is left when the window runs out of room.
      </p>

      <TopbarPreview layout={layout} />

      <div className="topbar-customizer">
        <div className="board-card-checklist">
          <h4 className="settings-subhead">Show or hide</h4>
          {optional.map((item) => {
            const id = item.id as OptionalTopbarItemId;
            const on = isTopbarItemShown(layout, id);
            return (
              <label key={item.id} className={`settings-toggle${on ? " is-on" : ""}`}>
                <Tooltip label={on ? `Hide ${item.label} from the top bar` : `Show ${item.label} on the top bar`}>
                  {/* Named explicitly for the reason the Board card checklist gives: the
                      label's whole sentence would otherwise be every checkbox's name. */}
                  <input
                    type="checkbox"
                    aria-label={item.label}
                    checked={on}
                    onChange={(e) => setTopbarItemShown(layout.hidden, id, e.target.checked)}
                  />
                </Tooltip>
                <span className="settings-toggle-text">
                  <span className="settings-toggle-label">{item.label}</span>
                  <span className="settings-toggle-desc">{item.description}</span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="board-card-checklist">
          <h4 className="settings-subhead">Expanded or minimized</h4>
          <p className="settings-hint settings-blurb">
            These are always on the bar. Minimized hides the text label at every window width
            and keeps the glyph; any count on the control stays visible.
          </p>
          {compactable.map((item) => {
            const id = item.id as CompactableTopbarItemId;
            const minimized = isTopbarItemCompact(layout, id);
            return (
              <div key={item.id} className="display-choice">
                <span className="settings-toggle-text">
                  <span className="settings-toggle-label">{item.label}</span>
                  <span className="settings-toggle-desc">{item.description}</span>
                </span>
                <div
                  className="display-choice-options"
                  role="radiogroup"
                  aria-label={`Top bar: ${item.label}`}
                >
                  {(["expanded", "minimized"] as const).map((size) => {
                    const checked = (size === "minimized") === minimized;
                    return (
                      <Tooltip
                        key={size}
                        label={size === "minimized"
                          ? `Always draw ${item.label} as its glyph`
                          : `Draw ${item.label} in full while the window has room`}
                      >
                        <label className={`display-choice-option${checked ? " is-on" : ""}`}>
                          <input
                            type="radio"
                            name={`topbar-size-${item.id}`}
                            value={size}
                            checked={checked}
                            onChange={() => setTopbarItemCompact(layout.compact, id, size === "minimized")}
                          />
                          {size === "minimized" ? "Minimized" : "Expanded"}
                        </label>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

    </section>
  );
}
