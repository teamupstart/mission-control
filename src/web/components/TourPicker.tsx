import { useCallback, useRef, useState } from "react";
import type { TourCatalogEntry } from "../tour/catalog.ts";
import type { TourId } from "../tour/contracts.ts";
import { containTourTab } from "../tour/focus-containment.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { TOUR_PREFERENCE_ERROR } from "./TourPreferenceNotice.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** Decorative product shapes, with a generic preview for future catalog registrations. */
function TourIllustration({ kind }: { kind: TourCatalogEntry["preview"]["illustration"] }): React.JSX.Element {
  return (
    <svg className="tour-picker-illustration" viewBox="0 0 440 148" aria-hidden="true" focusable="false">
      <rect className="tour-art-panel" x="12" y="8" width="416" height="132" rx="10" />
      <path className="tour-art-line" d="M12 34H428" />
      <circle className="tour-art-accent" cx="27" cy="21" r="3" />
      <path className="tour-art-line" d="M39 21H98" />
      {kind === "setup" ? <>
        {[52, 80, 108].map((y, i) => <g key={y}>
          <rect className="tour-art-accent" x="30" y={y} width="16" height="16" rx="4" />
          <path className="tour-art-check" d={`M34 ${y + 8}l3 3 5-6`} />
          <path className="tour-art-line" d={`M60 ${y + 8}H${[250, 212, 276][i]}`} />
          <rect className="tour-art-panel" x="342" y={y} width="64" height="16" rx="8" />
        </g>)}
      </> : kind === "library" ? <>
        {[30, 158, 286].map((x) => <g key={x}>
          <rect className="tour-art-card" x={x} y="50" width="112" height="72" rx="6" />
          <path className="tour-art-accent" d={`M${x + 14} 64h20v24h-20z`} />
          <path className="tour-art-line" d={`M${x + 14} 102h76M${x + 46} 72h48M${x + 46} 82h30`} />
        </g>)}
      </> : <>
        {[30, 158, 286].map((x, i) => <g key={x}>
          <path className="tour-art-line" d={`M${x} 51h110`} />
          <rect className="tour-art-card" x={x} y="63" width="112" height={48 + i * 6} rx="6" />
          <circle className="tour-art-accent" cx={x + 15} cy="79" r="4" />
          <path className="tour-art-line" d={`M${x + 28} 79h66M${x + 12} 95h76`} />
        </g>)}
      </>}
    </svg>
  );
}

export function TourPicker({ entries, enabled, hydrated, saving, saveError, onSave, onStart, onClose }: {
  entries: readonly TourCatalogEntry[];
  enabled: boolean;
  hydrated: boolean;
  saving: boolean;
  saveError: boolean;
  onSave: (next: boolean) => void;
  onStart: (id: TourId) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState(entries[0]?.id);
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0];
  const surface = useRef<HTMLElement | null>(null);
  const setSurface = useCallback((element: HTMLElement | null) => { surface.current = element; }, []);
  const containTab = useCallback((event: KeyboardEvent) => {
    if (surface.current) containTourTab(event, surface.current);
  }, []);
  return (
    <Overlay id={OVERLAY_IDS.tourPicker} className="modal tour-picker" role="dialog"
      ariaLabel="Explore Mission Control" ariaModal onClose={onClose}
      surfaceRef={setSurface}
      onKeyDown={containTab}>
      <header className="modal-head">
        <div><h2>Explore Mission Control</h2><p>Choose a tour. Start when you’re ready.</p></div>
        <Tooltip label="Close the picker without starting a tour">
          <button className="icon-btn" aria-label="Close tour picker" onClick={onClose}
            autoFocus={!selected}>✕</button>
        </Tooltip>
      </header>
      <div className="modal-bleed tour-picker-content">
        {selected ? <>
          <fieldset className="tour-picker-list">
            <legend className="sr-only">Available tours</legend>
            {entries.map((entry) => (
              <Tooltip key={entry.id} label={`Preview ${entry.title}`}>
                <label className={`tour-picker-row${entry.id === selected.id ? " is-selected" : ""}`}>
                  <input type="radio" name="tour-picker-selection" value={entry.id}
                    checked={entry.id === selected.id} autoFocus={entry.id === entries[0]?.id}
                    onChange={() => setSelectedId(entry.id)} aria-label={entry.title} />
                  <span><strong>{entry.title}</strong><small>{entry.stopCount} stops</small>
                    {entry.recommended && <span className="tour-picker-recommended">Recommended first</span>}
                  </span>
                </label>
              </Tooltip>
            ))}
          </fieldset>
          <section className="tour-picker-preview" aria-label={`${selected.title} preview`}>
            <TourIllustration kind={selected.preview.illustration} />
            <h3>{selected.title}</h3>
            <p>{selected.preview.summary}</p>
            <h4>What you’ll learn</h4>
            <ul>{selected.preview.outcomes.map((outcome) => <li key={outcome}>{outcome}</li>)}</ul>
            <Tooltip label={`Start ${selected.title} from the beginning`}>
              <button className="btn btn-primary" onClick={() => onStart(selected.id)}>Start this tour</button>
            </Tooltip>
          </section>
        </> : <p className="tour-picker-empty">No tours are available.</p>}
      </div>
      <footer className="modal-foot tour-picker-footer">
        <div className="tour-picker-preference">
          <Tooltip label="Offer the tour picker in new dashboard windows and after reloads">
            <label><input type="checkbox" checked={enabled} disabled={!hydrated || saving}
              onChange={(event) => onSave(event.target.checked)} aria-describedby="tour-preference-status" />
              Show tours when Mission Control opens</label>
          </Tooltip>
          <span id="tour-preference-status" role="status">
            {!hydrated ? "Loading your saved preference…" : saving ? "Saving…" : "Applies to new windows and reloads."}
          </span>
          {saveError && <p role="alert">{TOUR_PREFERENCE_ERROR}</p>}
        </div>
        <Tooltip label="Close the picker without changing your startup preference">
          <button className="btn btn-ghost" onClick={onClose}>Dismiss</button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
