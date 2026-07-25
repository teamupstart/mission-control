import { useEffect, useId, useRef, useState } from "react";
import {
  searchSettings,
  type SettingsBindings,
  type SettingsControl,
} from "../lib/settings-search.ts";
import {
  SETTINGS_SCOPES,
  settingsCategory,
  type SettingsCategoryId,
  type SettingsNavigate,
} from "../lib/settings-registry.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

// The ⌘K settings search palette: a panel over the settings page, matching the approved
// prototype's Mockup D. Type what you remember, land on the control.
//
// It is a screen-owning dialog, so it routes through the shared `<Overlay>` primitive: that
// is what registers it as open (AGENTS.md's overlay contract - membership is not a
// hand-kept list) and gives it the shared backdrop and one-layer Escape. It only ever opens
// on the settings page, where App's grid shortcuts already stand down (`route.page !==
// "fleet"`), so the registry's stand-down is belt-and-suspenders here rather than the thing
// keeping `k` from killing the card behind it - but a screen-owning dialog still belongs in
// the registry by construction.
//
// NOT a compose box. It carries no draft (`lib/drafts.ts`), no attachments, and never
// registers itself as a reply box - the compose-parity rules in AGENTS.md deliberately do
// not apply here. It is a transient search field: cleared every time it opens, gone on
// close, holding nothing between.
//
// Its own keys ride the input's bubble-phase `onKeyDown`, never a capture-phase window
// listener. That keeps the Keyboard panel's chord recorder (a CAPTURE-phase listener that
// swallows keystrokes mid-record) winning. The input's own Escape (preventDefault + close)
// is the primary dismissal - immediate and focus-independent, and its `preventDefault` is
// what makes the page's bubble Escape-to-fleet bail rather than leave the page out from
// under the palette; `Overlay`'s Escape is the shared backup.

/** One selectable row, flattened across the two result groups for roving selection. */
type Row =
  | { kind: "control"; control: SettingsControl }
  | { kind: "category"; id: SettingsCategoryId };

export function SettingsSearch({
  open,
  onClose,
  onNavigate,
  bindings,
}: {
  /** Whether the palette is showing. App owns this; the shortcut and the rail box set it. */
  open: boolean;
  /** Close without navigating (Escape, veil click, ⌘K again). */
  onClose: () => void;
  /**
   * Jump to a category, optionally flashing one anchored control there. This is the page's
   * `navigateWithAnchor`, so a jump reuses the exact same scroll-and-flash path the panels'
   * "Manage in Trust" links do - the Phase 1 anchor contract's second consumer.
   */
  onNavigate: SettingsNavigate;
  /**
   * Runtime get/set for the bindable boolean controls, built by the page from the hooks it
   * owns. A control with no binding here (every risky one, and any toggle the page did not
   * wire) renders as a jump - never a dead switch.
   */
  bindings: SettingsBindings;
}): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Fresh every open: a query left over from last time would be the palette showing results
  // for something the operator did not just type. Focus follows, so the shortcut lands you
  // typing.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSel(0);
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const { controls, categories } = searchSettings(query);
  const rows: Row[] = [
    ...controls.map((control) => ({ kind: "control" as const, control })),
    ...categories.map((id) => ({ kind: "category" as const, id })),
  ];
  // Clamp rather than store a clamped value: the result set shrinks as the query narrows,
  // so the live selection is always re-derived against the current rows.
  const active = rows.length === 0 ? -1 : Math.min(sel, rows.length - 1);
  const optionId = (index: number): string => `${listId}-opt-${index}`;

  function move(delta: number): void {
    if (rows.length === 0) return;
    setSel((s) => Math.max(0, Math.min(rows.length - 1, Math.min(s, rows.length - 1) + delta)));
  }

  function activate(index: number): void {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "category") {
      onClose();
      onNavigate(row.id);
      return;
    }
    const c = row.control;
    const binding = c.kind === "toggle" && !c.risky ? bindings.get(c.id) : undefined;
    if (binding) {
      // Flip in place and stay open. The switch re-reads `get()` on the page's next
      // render, so a daemon round-trip that has not landed shows honestly as "not moved
      // yet" rather than an optimistic guess the palette invented.
      binding.set(!binding.get());
      return;
    }
    onClose();
    onNavigate(c.category, c.anchor);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setSel(0);
        break;
      case "End":
        e.preventDefault();
        setSel(Math.max(0, rows.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        activate(active);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }

  return (
    <Overlay
      id={OVERLAY_IDS.settingsSearch}
      onClose={onClose}
      className="pal"
      role="dialog"
      ariaLabel="Search settings"
    >
        <div className="pal-in">
          <span className="pal-glass" aria-hidden>
            ⌕
          </span>
          <input
            ref={inputRef}
            className="pal-input"
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-label="Search settings"
            placeholder="Search settings… (soak, model, skills, merge)"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="pal-results" id={listId} role="listbox" aria-label="Settings search results">
          {rows.length === 0 ? (
            <div className="pal-empty">Nothing matches. Try "soak", "model", or "merge".</div>
          ) : (
            <>
              {controls.length > 0 && <div className="pal-glabel">Settings</div>}
              {controls.map((control, i) => {
                const binding =
                  control.kind === "toggle" && !control.risky ? bindings.get(control.id) : undefined;
                const on = binding ? binding.get() : false;
                const cat = settingsCategory(control.category);
                return (
                  <Tooltip
                    key={control.id}
                    label={
                      binding
                        ? `${on ? "Switch off" : "Switch on"} here - ${control.description}`
                        : `Open in ${cat.label} - ${control.description}`
                    }
                  >
                    <button
                      type="button"
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === active}
                      aria-label={binding ? `${control.label}, ${on ? "on" : "off"}` : control.label}
                      className={`pal-row${i === active ? " is-active" : ""}`}
                      // Keep the caret in the search field: a bare button click would move
                      // focus here and the operator could not keep typing after an inline
                      // flip. onClick still fires - preventDefault only cancels the focus.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => {
                        if (active !== i) setSel(i);
                      }}
                      onClick={() => activate(i)}
                    >
                      <span className="pal-row-text">
                        <span className="pal-row-label">{control.label}</span>
                        <span className="pal-row-desc">
                          {cat.label} · {control.description}
                        </span>
                      </span>
                      {binding ? (
                        <span className="pal-switch" data-on={on ? "true" : "false"} aria-hidden />
                      ) : (
                        <span className="pal-badge">open ↵</span>
                      )}
                    </button>
                  </Tooltip>
                );
              })}
              {categories.length > 0 && <div className="pal-glabel">Jump to</div>}
              {categories.map((id, j) => {
                const index = controls.length + j;
                const cat = settingsCategory(id);
                return (
                  <Tooltip key={id} label={`Open ${cat.label} settings`}>
                    <button
                      type="button"
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === active}
                      aria-label={`${cat.label} settings`}
                      className={`pal-row pal-row-cat${index === active ? " is-active" : ""}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => {
                        if (active !== index) setSel(index);
                      }}
                      onClick={() => activate(index)}
                    >
                      <span className="pal-row-icon" aria-hidden>
                        {cat.icon}
                      </span>
                      <span className="pal-row-text">
                        <span className="pal-row-label">{cat.label}</span>
                      </span>
                      <span className={`settings-scope settings-scope-${cat.scope}`}>
                        {SETTINGS_SCOPES[cat.scope].label}
                      </span>
                    </button>
                  </Tooltip>
                );
              })}
            </>
          )}
        </div>
        <div className="pal-foot">
          <span>
            <b>↑↓</b> navigate
          </span>
          <span>
            <b>↵</b> open / toggle
          </span>
          <span>
            <b>esc</b> close
          </span>
        </div>
    </Overlay>
  );
}
