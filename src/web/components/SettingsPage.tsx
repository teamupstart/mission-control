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
import { checksArmedReading } from "../lib/trust.ts";
import { WorkflowSettingsPanel } from "./WorkflowSettingsPanel.tsx";
import { useWorkflowSettings } from "../useWorkflowSettings.ts";
import type { WorkflowRunFilters } from "../workflows/useWorkflowRoute.ts";
import { LayoutPanel } from "./LayoutPanel.tsx";
import { AppearancePanel } from "./AppearancePanel.tsx";
import { useHarnesses } from "../useHarnesses.ts";
import { useTaskSources } from "../useTaskSources.ts";
import { formatChord, useKeybindingHints, useKeybindings } from "../lib/keybindings.ts";
import type { LayoutMode } from "../lib/layout.ts";
import type { ForemanState } from "../useForeman.ts";
import type { CostState } from "../useCost.ts";
import type { LlmState } from "../useLlm.ts";
import type { SettingsStatus } from "@shared/types.ts";
import type { WorkflowSummary } from "@shared/workflow.ts";
import { repoAllowlisted } from "@shared/allowlist.ts";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_GROUPS,
  SETTINGS_SCOPES,
  settingsCategoriesIn,
  settingsCategory,
  type SettingsCategoryId,
} from "../lib/settings-registry.ts";
import { settingsRailDot, type SettingsDotTone } from "../lib/settings-dots.ts";
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

/**
 * How long a deep link waits for its control to appear before giving up on it.
 *
 * A panel that fetches its config renders its fields only after the read returns, so an
 * anchor arriving from off the page is routinely asked for before it exists. Generous enough
 * to cover a slow local round trip, short enough that a control this build simply does not
 * render stops being watched for.
 */
const ANCHOR_WAIT_MS = 5000;

/** How far this category's writes reach, as the badge the rail and the panel head carry. */
function ScopeBadge({ scope }: { scope: keyof typeof SETTINGS_SCOPES }): React.JSX.Element {
  const { label, hint } = SETTINGS_SCOPES[scope];
  return (
    <Tooltip label={hint}>
      <span className={`settings-scope settings-scope-${scope}`}>{label}</span>
    </Tooltip>
  );
}

/** What one rail dot means, for the title and screen-reader label the colour alone can't. */
function dotLabel(
  tone: SettingsDotTone,
  status: SettingsStatus | null,
  /**
   * Which row the dot sits on. Needed because `armed` stopped meaning one thing when Trust
   * gained the check-execution input: a Trust dot can now be amber with YOLO switched off
   * entirely, and the tone alone cannot tell you which of the two lit it. Without this, a
   * screen reader announced "YOLO mode is armed" on a fleet where YOLO was off and the real
   * cause was a workflow that may execute branch code - the one reading a sighted operator
   * gets from the panel and a blind one could not.
   */
  category: SettingsCategoryId,
): string {
  switch (tone) {
    case "live":
      return "Inspector is live - reviews post to GitHub";
    case "armed":
      return category === "trust"
        ? "Trust needs a look - a repository grant is armed"
        : "YOLO mode is armed - clean pull requests may merge themselves";
    case "failing": {
      const n = status?.taskSources.failing ?? 0;
      return `${n} task source${n === 1 ? "" : "s"} failed their last sweep`;
    }
    case "foreman":
      return "Foreman is on";
  }
}

/**
 * The status dot at a rail item's trailing edge, or nothing when it has nothing to flag.
 *
 * Colour alone is not a signal a screen reader can hear, so `role="img"` plus an
 * `aria-label` names what it flags - which also folds the status into the tab's accessible
 * name ("Inspector, Inspector is live ..."). No native `title`: the house rule is one
 * tooltip mechanism, and this dot lives inside a button already carrying the category's
 * hover blurb, so a second bubble here would be a theme the stylesheet does not reach.
 */
function RailDot({
  tone,
  status,
  category,
}: {
  tone: SettingsDotTone | null;
  status: SettingsStatus | null;
  category: SettingsCategoryId;
}): React.JSX.Element | null {
  if (!tone) return null;
  return (
    <span
      className={`settings-dot settings-dot-${tone}`}
      role="img"
      aria-label={dotLabel(tone, status, category)}
    />
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
  onOpenRuns,
  onLeave,
  foreman,
  cost,
  llm,
  layout,
  onLayoutChange,
  settingsStatus,
  harnessesRevision = 0,
  workflowSummaries = [],
  onOpenPalette,
  jump = null,
}: {
  /** Which category is showing, from the route. The page holds no copy of it. */
  category: SettingsCategoryId;
  /** Move to another category - a hash navigation, so back/forward walk the categories. */
  onNavigate: (category: SettingsCategoryId) => void;
  /**
   * Leave the settings page for a Workflows run-list view, optionally filtered. Only the
   * Workflows panel's health tiles use it.
   *
   * Deliberately NOT part of `onNavigate`: that one is typed to `SettingsCategoryId`,
   * because every other navigation this page performs stays inside it. Widening it to carry
   * a destination that is not a settings category would make the type stop describing what
   * the rail can reach, so this is a second, honestly-typed prop instead.
   */
  onOpenRuns?: (filters: WorkflowRunFilters) => void;
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
  /**
   * The subsystem status the rail dots read (Inspector live, YOLO armed, failing task
   * sources), from `MissionState` over SSE. Null before the first snapshot - "unknown",
   * so the affected dots stay off rather than claiming an all-clear. The Foreman dot does
   * NOT come from here: it derives from the App-owned `foreman` prop above.
   */
  settingsStatus: SettingsStatus | null;
  /**
   * `MissionState.harnessesRevision` - bumped whenever the daemon announces a change to the
   * per-harness dispatch defaults. Handed to `useHarnesses` so this page reflects an edit
   * made in another tab at once instead of at the end of its backstop poll.
   */
  harnessesRevision?: number;
  /** Published Workflow catalog used by the dispatch-default picker. */
  workflowSummaries?: WorkflowSummary[];
  /**
   * Open the app-wide ⌘K palette. The rail's search box is one of its three doorways (the
   * chord and the topbar are the others), so the box asks App rather than owning a palette
   * of its own - there is one input over everything, and this page is not a second one.
   */
  onOpenPalette?: () => void;
  /**
   * A control to scroll to and flash, handed down by App when the palette lands on a setting.
   *
   * A `{ anchor, nonce }` pair rather than a bare string because the same control can be
   * asked for twice in a row, and the second ask has to flash again: the nonce is what makes
   * a repeat a new request. It rides a prop rather than the route because the settings hash
   * grammar is deliberately category-only - an anchor is a transient pointer at a control,
   * not a location worth a history entry.
   */
  jump?: { anchor: string; nonce: number } | null;
}): React.JSX.Element {
  const skills = useSkills();
  // Owned here rather than by App, like `skills`: nothing outside this page reads the
  // harnesses config, so it polls only while the page is open.
  const harnesses = useHarnesses(harnessesRevision);
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
  // Owned here for the same reason as the four above: nothing outside this page reads the
  // Workflow config, so it polls only while the page is open. Its poll is load-bearing
  // rather than tidy - the health strip, retention readout and health card are what it
  // keeps moving, which is what let the drawer's Refresh health button go.
  const workflowSettings = useWorkflowSettings();
  // The resolved chord for the palette, shown as the rail box's hint so the box and the
  // shortcut always agree even after a rebind.
  const { bindings: keyBindings } = useKeybindings();
  const searchChord = formatChord(keyBindings.settingsSearch);
  const [keybindingHints] = useKeybindingHints();
  const tabRefs = useRef(new Map<SettingsCategoryId, HTMLButtonElement>());

  // Deep-link with a flash: something asks to move to a category and light up one control
  // there. Two callers, one implementation - a panel (Shipping's dependency warnings, the
  // settings consoles' "Manage in Trust") through `navigateWithAnchor`, and the ⌘K palette
  // through the `jump` prop, because App navigated before this page was even mounted. The
  // route change is App's; the flash is this page's, because the anchor is a transient
  // pointer at a control and was deliberately kept out of the hash grammar (which is
  // category-only).
  //
  // The request is STATE carrying its own id, not a ref plus a nonce. It was the latter, and
  // that shape cannot survive a request that has to WAIT for its control (below): bumping a
  // nonce to re-fire the effect also re-runs the effect's CLEANUP, which tore down the wait
  // the previous run had just set up. One `seq` counter for both callers, so an id is unique
  // whichever door the request came through and `handled` can never skip a real one.
  const seq = useRef(0);
  const [pending, setPending] = useState<{ anchor: string; id: number } | null>(null);
  const handled = useRef(0);
  const requestFlash = useCallback((anchor: string): void => {
    seq.current += 1;
    setPending({ anchor, id: seq.current });
  }, []);
  const navigateWithAnchor = useCallback(
    (cat: SettingsCategoryId, anchor?: string): void => {
      onNavigate(cat);
      if (anchor) requestFlash(anchor);
    },
    [onNavigate, requestFlash],
  );
  useEffect(() => {
    if (jump) requestFlash(jump.anchor);
  }, [jump, requestFlash]);
  useEffect(() => {
    // Consumed once, tracked in a ref so recording it cannot re-render and cancel the run it
    // is recording.
    if (!pending || pending.id === handled.current) return;
    // A cross-category jump lands here twice: once still on the source category (the anchor
    // prefix won't match, so wait), and once the route caught up and the target panel is
    // mounted. Keyed on `category` as well, so that second render re-runs it.
    if (pending.anchor.split("/")[0] !== category) return;
    handled.current = pending.id;
    const anchor = pending.anchor;

    let lit: HTMLElement | null = null;
    let fade: number | undefined;
    let giveUp: number | undefined;
    let watcher: MutationObserver | undefined;

    const flash = (el: HTMLElement): void => {
      lit = el;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("settings-flash");
      fade = window.setTimeout(() => el.classList.remove("settings-flash"), FLASH_MS);
    };
    const findAnchor = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);

    const present = findAnchor();
    if (present) {
      flash(present);
    } else {
      // The panel is mounted, but its CONTROL may not be yet: Shipping, Inspector, Trust and
      // Task sources all render their fields only once their config has come back, and half
      // this page's panels behave the same way. A deep link that arrives before that read -
      // which is every link from off the page, because the panel starts fetching as it
      // mounts - would otherwise find nothing and silently flash nothing at all. That was
      // invisible from inside the page (where the config had long since landed) and is
      // exactly what a link from the ⌘K palette does every time.
      //
      // So wait for it, briefly, and stop waiting: a control that never appears is a jump to
      // a setting this build does not render, and an observer left running would sit on
      // every DOM change the dashboard makes for the life of the page.
      watcher = new MutationObserver(() => {
        const late = findAnchor();
        if (!late) return;
        watcher?.disconnect();
        watcher = undefined;
        window.clearTimeout(giveUp);
        flash(late);
      });
      watcher.observe(document.querySelector(".settings-page") ?? document.body, {
        childList: true,
        subtree: true,
      });
      giveUp = window.setTimeout(() => {
        watcher?.disconnect();
        watcher = undefined;
      }, ANCHOR_WAIT_MS);
    }

    return () => {
      watcher?.disconnect();
      window.clearTimeout(fade);
      window.clearTimeout(giveUp);
      lit?.classList.remove("settings-flash");
    };
  }, [pending, category]);

  // Inputs to the rail dots (Phase 4). Foreman is App-owned, not in the status payload. The
  // trust blind spot is a merge-without-review gap - a repo YOLO may merge that the Inspector
  // is not allowlisted to review - computed from the two grant lists the page already holds,
  // through the same `repoAllowlisted` predicate the daemon gates on so the dot cannot mean
  // something different from the panels. It feeds the trust dot, now that Phase 2 has added
  // the `trust` category to the registry the rail draws from.
  const foremanEnabled = !!foreman.config?.enabled;
  // The last CONFIRMED answer to "may a check run branch-authored code somewhere". A ref
  // rather than state: it is written during render from a value already being rendered, so
  // setting state here would be a second pass that produces the identical output.
  const rememberedChecksArmed = useRef(false);
  const inspectorAllow = inspector.config?.repoAllowlist ?? null;
  const shippingAllow = shipping.config?.repoAllowlist ?? null;
  const trustBlindSpot =
    inspectorAllow !== null &&
    shippingAllow !== null &&
    shippingAllow.some((repo) => !repoAllowlisted(repo, null, inspectorAllow));
  // The panel's second amber: checks are switched on and at least one repository holds the
  // Workflows grant, so a Check node may run branch-authored code right now.
  //
  // Remembered ACROSS a failed poll, which is the whole subtlety - see `checksArmedReading`.
  // `useWorkflowSettings` nulls its config on any read that fails, so deriving this straight
  // off `config?.checksEnabled` retired the warning five seconds after the daemon went
  // quiet, while claiming in three places that it could not.
  //
  // Owned HERE rather than inside TrustPanel because this component stays mounted for the
  // whole settings session while TrustPanel mounts only on its own category: a ref in the
  // panel would forget every time you navigated away, so the dot and the footnote would
  // disagree about the same fact the moment you came back with the daemon still down. The
  // panel is handed the reading for the same reason it is handed the four subsystem states.
  const checksReading = checksArmedReading(
    workflowSettings.config,
    rememberedChecksArmed.current,
  );
  // Only a CONFIRMED reading updates the memory; an unconfirmed one must not overwrite the
  // last thing we actually saw with a guess derived from itself.
  if (checksReading.confirmed) rememberedChecksArmed.current = checksReading.armed;
  const trustCheckExecution = checksReading.armed;

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

  // `pending` remains as the record of the latest request after its flash completes. Panels
  // may unmount as the operator changes categories, so only hand Foreman a request this page
  // has not consumed; otherwise a remount would mistake the stale record for a new jump and
  // reopen its old tab.
  const unhandledJump = pending && pending.id !== handled.current ? pending : null;

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
        return (
          <ForemanSettingsPanel
            state={foreman}
            onNavigate={navigateWithAnchor}
            jumpAnchor={unhandledJump?.anchor ?? null}
            jumpRequestId={unhandledJump?.id ?? null}
          />
        );
      case "workflows":
        return (
          <WorkflowSettingsPanel
            state={workflowSettings}
            workflows={workflowSummaries}
            foremanEnabled={foreman.config?.enabled ?? false}
            onNavigate={navigateWithAnchor}
            onOpenRuns={onOpenRuns}
          />
        );
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
        // The one view over the four allowlists. It gets all four states rather than its
        // own hooks: Foreman's is App's, Workflows', the Inspector's and Shipping's are this
        // page's, and a second poll of the same routes would let a cell and a panel disagree
        // about a list.
        return (
          <TrustPanel
            foreman={foreman}
            workflows={workflowSettings}
            inspector={inspector}
            shipping={shipping}
            checks={checksReading}
          />
        );
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
        {/* Phase 1 deliberately shipped no rail box - a dead one would lie. This is that box,
            showing the current chord so it doubles as the shortcut's discovery point. It
            opens the app-wide palette rather than a settings-only one: the same input, from
            this page as from anywhere else. Outside the tablist for the same reason the
            title is. */}
        <Tooltip label={`Search everything (${searchChord})`}>
          <button
            type="button"
            className="settings-rail-search"
            onClick={() => onOpenPalette?.()}
            aria-label="Search everything"
          >
            <span className="settings-rail-search-glyph" aria-hidden>
              ⌕
            </span>
            <span className="settings-rail-search-text">Search everything…</span>
            {/* Answers to "Show keybindings on buttons" like every other on-button
                keycap. Its own class, not `Keycap`: this one is right-aligned in a
                search box rather than annotating a label, so it keeps that shape - the
                switch decides only whether it is drawn. The tooltip still names the
                chord either way. */}
            {keybindingHints && <kbd className="settings-rail-search-kbd">{searchChord}</kbd>}
          </button>
        </Tooltip>
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
                    <RailDot
                      tone={settingsRailDot(c.id, {
                        status: settingsStatus,
                        foremanEnabled,
                        trustBlindSpot,
                        trustCheckExecution,
                      })}
                      status={settingsStatus}
                      category={c.id}
                    />
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
