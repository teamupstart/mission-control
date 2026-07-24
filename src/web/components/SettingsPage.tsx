import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardPanel } from "./KeyboardPanel.tsx";
import { SkillsPanel } from "./SkillsPanel.tsx";
import { useSkills } from "../useSkills.ts";
import { useInspector } from "../useInspector.ts";
import { ForemanSettingsPanel } from "./ForemanSettingsPanel.tsx";
import { CostSettingsPanel } from "./CostSettingsPanel.tsx";
import { InspectorSettingsPanel } from "./InspectorSettingsPanel.tsx";
import { LlmSettingsPanel } from "./LlmSettingsPanel.tsx";
import { ShippingSettingsPanel } from "./ShippingSettingsPanel.tsx";
import { useShipping } from "../useShipping.ts";
import { HarnessesPanel } from "./HarnessesPanel.tsx";
import { TaskSourcesPanel } from "./TaskSourcesPanel.tsx";
import { TrustPanel } from "./TrustPanel.tsx";
import { LayoutPanel } from "./LayoutPanel.tsx";
import { AppearancePanel } from "./AppearancePanel.tsx";
import { useHarnesses } from "../useHarnesses.ts";
import { useTaskSources } from "../useTaskSources.ts";
import type { LayoutMode } from "../lib/layout.ts";
import type { ForemanState } from "../useForeman.ts";
import type { CostState } from "../useCost.ts";
import type { LlmState } from "../useLlm.ts";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_GROUPS,
  SETTINGS_SCOPES,
  settingsCategoriesIn,
  settingsCategory,
  type SettingsCategoryId,
} from "../lib/settings-registry.ts";
import { Tooltip } from "./Tooltip.tsx";

/** Stable per-tab id, so the pane can name its tab as its `aria-labelledby` label. */
function tabDomId(id: SettingsCategoryId): string {
  return `settings-tab-${id}`;
}

/**
 * How long the `settings-flash` class stays on a deep-linked control - the full length of
 * its CSS animation (two 1.6s passes), matched here so the class is not stripped mid-fade.
 */
const FLASH_MS = 3200;

/** How far this category's writes reach, as the badge the rail and the panel head carry. */
function ScopeBadge({ scope }: { scope: keyof typeof SETTINGS_SCOPES }): React.JSX.Element {
  const { label, hint } = SETTINGS_SCOPES[scope];
  return (
    <Tooltip label={hint}>
      <span className={`settings-scope settings-scope-${scope}`}>{label}</span>
    </Tooltip>
  );
}

/**
 * App settings, as a routed page (`#/settings/<category>`) rather than a modal.
 *
 * A two-pane surface at page width: a category rail on the left, the selected category's
 * panel on the right. Only the active category renders, so no setting is ever buried below
 * another - Skills is one click from open, not the tail of a scroll. The panels themselves
 * are unchanged; this component only arranges them and says which one is showing.
 *
 * The rail groups by BLAST RADIUS, from *This screen* down to *Leaves the machine*, and
 * every group carries a scope badge. Eleven flat peers said nothing about which settings
 * stay in this browser and which merge code under your GitHub account; the groups are that
 * sentence, drawn. Groups and their members both come from the registry
 * (`lib/settings-registry.ts`) - never from a list written out here - so a new category
 * cannot appear in the nav without declaring what it reaches.
 *
 * `LayoutPanel`, `AppearancePanel`, and `KeyboardPanel` are the page's local-only,
 * synchronous settings (localStorage). Skills is the one that leaves this machine: it
 * writes to the daemon, and through it to `~/.claude/skills`, so it is also the first that
 * can fail asynchronously. `SkillsPanel` owns that error path. `useSkills` lives here
 * rather than inside the Skills panel so the catalog keeps polling (and `pending` keeps
 * moving) while you're on another category.
 */
export function SettingsPage({
  category,
  onNavigate,
  onLeave,
  foreman,
  cost,
  llm,
  layout,
  onLayoutChange,
}: {
  /** Which category is showing, from the route. The page holds no copy of it. */
  category: SettingsCategoryId;
  /** Move to another category - a hash navigation, so back/forward walk the categories. */
  onNavigate: (category: SettingsCategoryId) => void;
  /** Escape, and the page's own way back. App points this at the fleet route. */
  onLeave: () => void;
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
  llm: LlmState;
  /**
   * The live layout, OWNED BY App for the same reason as `foreman`: App renders the
   * layout, so it holds the state and this panel only edits it. A local `useLayoutMode()`
   * here would be a second copy of the same localStorage key.
   */
  layout: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
}): React.JSX.Element {
  const skills = useSkills();
  // Owned here rather than by App, like `skills`: nothing outside this page reads the
  // harnesses config, so it polls only while the page is open.
  const harnesses = useHarnesses();
  // Owned here rather than by App, like `skills` and `harnesses`: nothing outside this
  // page reads the Inspector config, so it polls only while the page is open.
  const inspector = useInspector();
  // Owned here for the same reason as `inspector`: nothing outside this page reads the
  // Shipping config, so it polls only while the page is open.
  const shipping = useShipping();
  // Owned here for the same reason again - and this one's poll is load-bearing rather
  // than merely tidy: it is what keeps each source's last-swept line and its error moving
  // while you watch the panel, including for a sweep the background loop ran.
  const taskSources = useTaskSources();
  const tabRefs = useRef(new Map<SettingsCategoryId, HTMLButtonElement>());

  // Deep-link with a flash: a panel (Shipping's dependency warnings, the outbound panels'
  // "Manage in Trust") asks to move to a category and light up one control there. The route
  // change is App's `onNavigate`; the flash is this page's, because the anchor is a
  // transient pointer at a control and was deliberately kept out of the hash grammar (which
  // is Phase 1's, and category-only). `flashRef` holds the pending anchor and `flashNonce`
  // re-fires the effect. Phase 5's search palette drives the same path.
  const flashRef = useRef<string | null>(null);
  const [flashNonce, setFlashNonce] = useState(0);
  const navigateWithAnchor = useCallback(
    (cat: SettingsCategoryId, anchor?: string): void => {
      onNavigate(cat);
      if (anchor) {
        flashRef.current = anchor;
        setFlashNonce((n) => n + 1);
      }
    },
    [onNavigate],
  );
  useEffect(() => {
    const anchor = flashRef.current;
    if (!anchor) return;
    // A cross-category jump lands here twice: once still on the source category (the anchor
    // prefix won't match, so wait), and once the route caught up and the target panel is
    // mounted (prefix matches, and the control exists to scroll to and flash). Keyed on
    // `category` as well as the nonce so that second render re-runs it.
    if (anchor.split("/")[0] !== category) return;
    flashRef.current = null;
    const el = document.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("settings-flash");
    const timer = window.setTimeout(() => el.classList.remove("settings-flash"), FLASH_MS);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove("settings-flash");
    };
  }, [flashNonce, category]);

  // Escape returns to the fleet, which is the modal's muscle memory kept intact now that
  // there is no backdrop to dismiss.
  //
  // A plain BUBBLE-phase listener, deliberately, and with no "is a shortcut recording?"
  // guard - the same contract `Overlay` had. While KeyboardPanel records a chord its
  // CAPTURE-phase listener swallows the keystroke (stopPropagation) before any
  // bubble-phase handler runs, so Escape cancels the capture instead of leaving the page,
  // and neither side has to know about the other. A capture-phase listener here would
  // break that and navigate away mid-record.
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      // A text box's own Escape (clear, or blur) comes first, exactly as it does on the
      // fleet: leaving the page out from under a half-typed model id is not a back button.
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      leaveRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Arrow/Home/End move the tab set, per the WAI-ARIA tabs pattern: selection follows
  // focus, so a keyboard user lands on the panel the same way a click gets there. It walks
  // the FLAT registry, which is why the registry's order has to match the grouped render
  // order (see `SETTINGS_CATEGORIES`) - otherwise Down moves the selection somewhere the
  // eye is not. The stopPropagation keeps these keys inside the rail.
  function onTablistKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    const last = SETTINGS_CATEGORIES.length - 1;
    const idx = SETTINGS_CATEGORIES.findIndex((c) => c.id === category);
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
    onNavigate(nextId);
    tabRefs.current.get(nextId)?.focus();
  }

  function renderCategory(id: SettingsCategoryId): React.JSX.Element {
    switch (id) {
      case "display":
        // Layout and Appearance stacked, not two rail peers: both are one browser's
        // preference about this screen, and a category holding a single checkbox sat as a
        // visual equal of the one that merges pull requests.
        return (
          <>
            <LayoutPanel layout={layout} onLayoutChange={onLayoutChange} />
            <AppearancePanel />
          </>
        );
      case "keyboard":
        return <KeyboardPanel />;
      case "skills":
        return <SkillsPanel state={skills} />;
      case "harnesses":
        return <HarnessesPanel state={harnesses} />;
      case "task-sources":
        return <TaskSourcesPanel state={taskSources} />;
      case "models":
        return <LlmSettingsPanel state={llm} />;
      case "foreman":
        return <ForemanSettingsPanel state={foreman} onNavigate={navigateWithAnchor} />;
      case "cost":
        return <CostSettingsPanel state={cost} />;
      case "inspector":
        return <InspectorSettingsPanel state={inspector} onNavigate={navigateWithAnchor} />;
      case "shipping":
        // Handed the Inspector's `enabled` because YOLO mode merges what the Inspector
        // reviewed clean: with it off, nothing qualifies and the panel has to say so
        // rather than look armed. `null` before the first poll lands, which is not the
        // same as "off" and must not be drawn as a warning.
        return (
          <ShippingSettingsPanel
            state={shipping}
            inspectorConfig={inspector.config ?? null}
            onNavigate={navigateWithAnchor}
          />
        );
      case "trust":
        // The one view over the three allowlists. It gets all three states rather than its
        // own hooks: Foreman's is App's, the Inspector's and Shipping's are this page's, and
        // a fourth poll of the same routes would let a cell and a panel disagree about a list.
        return <TrustPanel foreman={foreman} inspector={inspector} shipping={shipping} />;
    }
  }

  const active = settingsCategory(category);

  return (
    <main className="settings-page">
      <div className="settings-rail">
        {/* Outside the tablist, deliberately: a tablist's children are its tabs, and a
            heading plus a link in there is two things assistive tech has to announce as
            tabs or skip. */}
        <div className="settings-page-title">
          <h2>Settings</h2>
          <Tooltip label="Back to the fleet (Escape)">
            <button className="settings-leave" onClick={onLeave}>
              ← Fleet
            </button>
          </Tooltip>
        </div>
        <div
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings categories"
          onKeyDown={onTablistKey}
        >
          {SETTINGS_GROUPS.map((group) => (
            <div className="settings-nav-group" key={group.id}>
              <p className="settings-nav-label">
                {group.label}
                <ScopeBadge scope={group.scope} />
              </p>
              {settingsCategoriesIn(group.id).map((c) => (
                <Tooltip key={c.id} label={c.blurb}>
                  <button
                    id={tabDomId(c.id)}
                    type="button"
                    className={`settings-nav-item${category === c.id ? " is-active" : ""}`}
                    role="tab"
                    aria-selected={category === c.id}
                    // Roving tabindex: one Tab stop for the whole rail, arrows move within it.
                    tabIndex={category === c.id ? 0 : -1}
                    ref={(el) => {
                      if (el) tabRefs.current.set(c.id, el);
                      else tabRefs.current.delete(c.id);
                    }}
                    onClick={() => onNavigate(c.id)}
                  >
                    <span className="settings-nav-icon" aria-hidden>
                      {c.icon}
                    </span>
                    {c.label}
                  </button>
                </Tooltip>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="settings-pane" role="tabpanel" aria-labelledby={tabDomId(category)}>
        {/* The precise claim, beside the panel it is about. The rail's badge is its
            group's - a summary that can be gentler than a member's own, which is why the
            header repeats it rather than trusting the nav to have said it. */}
        <div className="settings-panel-head">
          <h2>{active.label}</h2>
          <ScopeBadge scope={active.scope} />
        </div>
        {renderCategory(category)}
      </div>
    </main>
  );
}
