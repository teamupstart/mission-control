import { useRef, useState } from "react";
import { KeyboardPanel } from "./KeyboardPanel.tsx";
import { SkillsPanel } from "./SkillsPanel.tsx";
import { useSkills } from "../useSkills.ts";
import { useInspector } from "../useInspector.ts";
import { ForemanSettingsPanel } from "./ForemanSettingsPanel.tsx";
import { CostSettingsPanel } from "./CostSettingsPanel.tsx";
import { InspectorSettingsPanel } from "./InspectorSettingsPanel.tsx";
import { HarnessesPanel } from "./HarnessesPanel.tsx";
import { LayoutPanel } from "./LayoutPanel.tsx";
import { AppearancePanel } from "./AppearancePanel.tsx";
import { useHarnesses } from "../useHarnesses.ts";
import type { LayoutMode } from "../lib/layout.ts";
import type { ForemanState } from "../useForeman.ts";
import type { CostState } from "../useCost.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";

/**
 * The settings categories, in rail order. Each is a peer destination in the left nav,
 * so adding one - Notifications, General - is appending an entry here plus a
 * `case` in `renderCategory`, never lengthening a scroll. Keeping the list as data (not
 * inlined JSX) is also what the render test walks to prove every category is reachable.
 */
export const SETTINGS_CATEGORIES = [
  { id: "layout", label: "Layout", icon: "▦" },
  { id: "appearance", label: "Appearance", icon: "◐" },
  { id: "keyboard", label: "Keyboard", icon: "⌨" },
  { id: "skills", label: "Skills", icon: "✦" },
  { id: "harnesses", label: "Harnesses", icon: "⚙" },
  { id: "foreman", label: "Foreman", icon: "●" },
  { id: "cost", label: "Cost", icon: "$" },
  { id: "inspector", label: "Inspector", icon: "⌕" },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]["id"];

/** Stable per-tab id, so the pane can name its tab as its `aria-labelledby` label. */
function tabDomId(id: SettingsCategoryId): string {
  return `settings-tab-${id}`;
}

/**
 * App settings, reached from the topbar gear or the native Settings… menu (⌘,).
 *
 * A two-pane surface: a category rail on the left, the selected category's panel on the
 * right. Only the active category renders, so no setting is ever buried below another -
 * Skills is one click from open, not the tail of a scroll. The panels themselves are
 * unchanged; this component only arranges them and owns which one is showing.
 *
 * `LayoutPanel`, `AppearancePanel`, and `KeyboardPanel` are the modal's local-only,
 * synchronous settings (localStorage). Skills is the one that leaves this machine: it
 * writes to the daemon, and through it to `~/.claude/skills`, so it is also the first
 * that can fail asynchronously. `SkillsPanel` owns that error path. `useSkills` lives
 * here rather than inside the Skills panel so the catalog keeps polling (and `pending`
 * keeps moving) while you're on another category.
 */
export function SettingsModal({
  onClose,
  foreman,
  cost,
  layout,
  onLayoutChange,
  initialCategory = "keyboard",
}: {
  onClose: () => void;
  /**
   * Foreman config/status, OWNED BY App - the topbar ForemanBar shares this exact state,
   * so it is passed in rather than re-instantiated here, and an edit in the panel and an
   * edit in the popover can never drift or double-poll. Skills is the opposite: App
   * doesn't use it, so it stays a local `useSkills()` below.
   */
  foreman: ForemanState;
  /**
   * Cost telemetry config, OWNED BY App for the same reason as `foreman`: the topbar's
   * fleet strip reads the same `view` setting this panel edits, so a local copy here
   * would leave the strip on the old choice after an edit, and poll for it twice.
   */
  cost: CostState;
  /**
   * The live layout, OWNED BY App for the same reason as `foreman`: App renders the
   * layout, so it holds the state and this panel only edits it. A local `useLayoutMode()`
   * here would be a second copy of the same localStorage key, and the dashboard behind
   * the modal wouldn't move when you picked one.
   */
  layout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
  /** Which category to open on. Lets the ⌘, menu, the ForemanBar link, or a test deep-link one. */
  initialCategory?: SettingsCategoryId;
}): React.JSX.Element {
  const [active, setActive] = useState<SettingsCategoryId>(initialCategory);
  const skills = useSkills();
  // Owned here rather than by App, like `skills`: nothing outside this modal reads the
  // harnesses config, so it polls only while the modal is open.
  const harnesses = useHarnesses();
  // Owned here rather than by App, like `skills` and `harnesses`: nothing outside this
  // modal reads the Inspector config, so it polls only while the modal is open.
  const inspector = useInspector();
  const tabRefs = useRef(new Map<SettingsCategoryId, HTMLButtonElement>());

  // Escape is Overlay's, and stays a plain BUBBLE-phase listener there with no "is a
  // shortcut recording?" guard - which is what makes this modal work. While
  // KeyboardPanel records a chord its capture-phase listener swallows the keystroke
  // (stopPropagation) before any bubble-phase handler runs, so Escape cancels the
  // capture instead of closing the modal, and neither side has to know about the other.
  // A capture-phase overlay listener would break that and close Settings mid-record.

  // Arrow/Home/End move the tab set, per the WAI-ARIA tabs pattern: selection follows
  // focus, so a keyboard user lands on the panel the same way a click gets there. The
  // stopPropagation keeps these keys inside the rail - the grid's window-level arrow
  // handler stands down while settings is open, but it should not be the only thing
  // standing between the rail and a background card moving under the modal.
  function onTablistKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    const last = SETTINGS_CATEGORIES.length - 1;
    const idx = SETTINGS_CATEGORIES.findIndex((c) => c.id === active);
    let next: number;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowLeft":
        next = idx <= 0 ? last : idx - 1;
        break;
      case "ArrowDown":
      case "ArrowRight":
        next = idx >= last ? 0 : idx + 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const nextId = SETTINGS_CATEGORIES[next]?.id;
    if (!nextId) return;
    setActive(nextId);
    tabRefs.current.get(nextId)?.focus();
  }

  function renderCategory(id: SettingsCategoryId): React.JSX.Element {
    switch (id) {
      case "layout":
        return <LayoutPanel layout={layout} onLayoutChange={onLayoutChange} />;
      case "appearance":
        return <AppearancePanel />;
      case "keyboard":
        return <KeyboardPanel />;
      case "skills":
        return <SkillsPanel state={skills} />;
      case "harnesses":
        return <HarnessesPanel state={harnesses} />;
      case "foreman":
        return <ForemanSettingsPanel state={foreman} />;
      case "cost":
        return <CostSettingsPanel state={cost} />;
      case "inspector":
        return <InspectorSettingsPanel state={inspector} />;
    }
  }

  return (
    <Overlay
      id={OVERLAY_IDS.settings}
      onClose={onClose}
      className="modal settings-modal"
      role="dialog"
      ariaLabel="Settings"
    >
      <header className="modal-head">
        <h2>Settings</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="settings-layout">
        <div
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings categories"
          onKeyDown={onTablistKey}
        >
          {SETTINGS_CATEGORIES.map((c) => (
            <button
              key={c.id}
              id={tabDomId(c.id)}
              type="button"
              className={`settings-nav-item${active === c.id ? " is-active" : ""}`}
              role="tab"
              aria-selected={active === c.id}
              // Roving tabindex: one Tab stop for the whole rail, arrows move within it.
              tabIndex={active === c.id ? 0 : -1}
              ref={(el) => {
                if (el) tabRefs.current.set(c.id, el);
                else tabRefs.current.delete(c.id);
              }}
              onClick={() => setActive(c.id)}
            >
              <span className="settings-nav-icon" aria-hidden>
                {c.icon}
              </span>
              {c.label}
            </button>
          ))}
        </div>

        <div className="settings-pane" role="tabpanel" aria-labelledby={tabDomId(active)}>
          {renderCategory(active)}
        </div>
      </div>
    </Overlay>
  );
}
