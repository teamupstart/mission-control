import type { Ref, RefObject } from "react";

import type { AwayConfig } from "@shared/protocol.ts";
import type { AwayBufferSummary } from "@shared/away-buffer.ts";
import type { FleetCost, KeepAwakeStatus } from "@shared/types.ts";
import type { AlertSettings } from "../lib/alertSettings.ts";
import { formatChord, useKeybindingHints, useKeybindings } from "../lib/keybindings.ts";
import type { Tone } from "../lib/format.ts";
import type { SettingsDotTone } from "../lib/settings-dots.ts";
import {
  isTopbarItemCompact,
  isTopbarItemShown,
  PAGE_SEGMENTS,
  type PageSegmentId,
  type TopbarLayout,
} from "../lib/topbar-items.ts";
import type { ForemanState } from "../useForeman.ts";
import { AlertBar } from "./AlertBar.tsx";
import { ForemanBar } from "./ForemanBar.tsx";
import { KeepAwakeControl } from "./KeepAwakeControl.tsx";
import { Keycap } from "./Keycap.tsx";
import { SpendChip } from "./SpendChip.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The topbar, as one component with everything it draws handed in.
 *
 * Lifted out of `App` so the Display category's Top bar panel can mount the REAL bar against
 * a fixture, the way the Board card panel mounts the real `SessionTile` - a drawing of the bar
 * would be a second source of truth for the thing being configured, and it would drift on the
 * first change to it. `App` still owns every piece of state below; this file owns markup.
 *
 * `layout` is the operator's Top bar preference (`lib/topbar-items.ts`). An optional item it
 * hides is not rendered at all, so it costs no width and the ladder never has to shed it. A
 * control it minimizes carries `.tb-compact`, which draws it the way ladder rungs 1 and 4 do
 * at every width; the ladder still applies on top of that as the window narrows.
 *
 * `preview` renders a `<div>` rather than the page's `<header>` landmark, because the preview
 * is a picture of the bar inside Settings rather than a second banner on the page.
 */
export interface TopbarProps {
  layout: TopbarLayout;
  preview?: boolean;
  barRef?: Ref<HTMLElement>;
  page: string;
  onNavigatePage: (page: PageSegmentId) => void;
  filter: string;
  onFilterChange: (value: string) => void;
  filterRef?: RefObject<HTMLInputElement | null>;
  connected: boolean;
  keepAwake: KeepAwakeStatus | null;
  sessions: number;
  attention: number;
  working: number;
  inbox: number;
  onOpenInbox: () => void;
  launcherFocusError?: string | null;
  fleetCost: FleetCost | null;
  costView: "usd" | "plan";
  onOpenCostSettings: () => void;
  scheduleAttentionCount: number;
  onOpenMissions: () => void;
  foreman: ForemanState;
  foremanOpenRequest?: number;
  onOpenModels: () => void;
  onOpenForemanSettings: () => void;
  onOpenDispatch: () => void;
  dispatchRef?: Ref<HTMLButtonElement>;
  onOpenFeedback: () => void;
  gearDot: SettingsDotTone | null;
  gearPhrase: string | null;
  onGear: () => void;
  gearRef?: Ref<HTMLButtonElement>;
  alertSettings: AlertSettings;
  updateAlerts: (patch: Partial<AlertSettings>) => void;
  away: AwayConfig | null;
  setAway: (patch: Partial<AwayConfig>) => Promise<void>;
  buffered: AwayBufferSummary | null;
}

export function Topbar(props: TopbarProps): React.JSX.Element {
  const { layout, page, filter, onFilterChange, filterRef } = props;
  const { bindings } = useKeybindings();
  const [keybindingHints] = useKeybindingHints();
  const compact = (id: Parameters<typeof isTopbarItemCompact>[1]): string =>
    isTopbarItemCompact(layout, id) ? " tb-compact" : "";

  const body = (
    <>
      <div className="brand">
        <img className="brand-mark" src="/favicon.svg" alt="" width={20} height={20} />
        <h1>Mission Control</h1>
      </div>
      {/* The three primary pages as one control: sessions, reusable authoring, and run
          history. Each segment has its own direct chord, so its label and keycap keep
          the same meaning from every page. `aria-current` rather than `aria-pressed`:
          these are navigation, and only one of them is where you are. */}
      <nav className="page-seg" aria-label="Pages">
        {PAGE_SEGMENTS.map(({ id, action, label, glyph, hint }) => {
          const current = page === id;
          const chord = formatChord(bindings[action]);
          return (
            <Tooltip
              key={id}
              label={chord ? `${hint} (${chord})` : hint}
            >
              <button
                className={`page-seg-btn${current ? " is-current" : ""}${compact(id)}`}
                {...(current ? { "aria-current": "page" as const } : {})}
                onClick={() => props.onNavigatePage(id)}
              >
                <span aria-hidden>{glyph}</span>
                <span className="tb-label">{label}</span>
                <Keycap action={action} />
              </button>
            </Tooltip>
          );
        })}
      </nav>
      {/* A <label>, not a <div>: at narrow widths the input collapses to zero and the
          box is just its ⌕, so the click that opens it lands on the glyph rather than
          on the field. An implicit label makes that click focus the input, which is
          what makes the collapse a control instead of a dead icon. */}
      {isTopbarItemShown(layout, "search") && (
        <label className="filter-box">
          <span className="filter-icon" aria-hidden>
            ⌕
          </span>
          <input
            ref={filterRef}
            className="filter-input"
            type="text"
            placeholder={`Filter (${formatChord(bindings.filter)})`}
            aria-label="Filter sessions by title, status, agent, or PR number"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (filter) onFilterChange("");
                else e.currentTarget.blur();
              }
            }}
          />
          {filter && (
            <Tooltip label="Clear the filter">
              <button
                className="filter-clear"
                aria-label="Clear filter"
                onClick={() => {
                  onFilterChange("");
                  filterRef?.current?.focus();
                }}
              >
                ✕
              </button>
            </Tooltip>
          )}
        </label>
      )}
      <FleetPulse
        connected={props.connected}
        keepAwake={props.keepAwake}
        sessions={isTopbarItemShown(layout, "sessions") ? props.sessions : null}
        attention={isTopbarItemShown(layout, "needYou") ? props.attention : 0}
        working={isTopbarItemShown(layout, "working") ? props.working : 0}
        inbox={props.inbox}
        onOpenInbox={props.onOpenInbox}
      />
      {props.launcherFocusError && (
        <span className="launch-flash is-error" role="status">
          {props.launcherFocusError}
        </span>
      )}
      {/* A READOUT, so it sits with the pulse rather than inside the action cluster
          below - which is three ranked groups of CONTROLS, and a figure dropped into
          them would break the rank it teaches. The bar's whole right-hand side is
          this phase's; the page segment arriving on the left is another's. */}
      {isTopbarItemShown(layout, "cost") && (
        <SpendChip
          fleet={props.fleetCost}
          view={props.costView}
          onOpenCostSettings={props.onOpenCostSettings}
        />
      )}
      {/* Twelve peers at one weight is what made this bar unreadable, so the
          cluster is THREE groups with a rank, not one rhythm: destinations you
          navigate to, the two controls that act on the fleet (Foreman's posture and
          the primary Dispatch), and the glyph tools. The groups sit at 16px from each
          other and 8px within, which is what lets the eye find four things instead of
          counting twelve. `live` is no longer stranded past the end of it - it moved
          into the pulse, where the rest of the status lives.

          Each degradable label is a `.tb-label`: at narrow container widths it goes
          visually-hidden rather than `display: none`, so the button keeps its
          accessible name and only its glyph is drawn. Dispatch has no `.tb-label` -
          the one control you would hunt for keeps its word at every width. */}
      <div className="topbar-actions">
        <div className="tb-group">
          <Tooltip label="Recurring missions - schedule tasks on a cadence, preview, and audit run history">
            <button
              className={`ghost-btn missions-btn${compact("missions")}`}
              onClick={props.onOpenMissions}
              aria-label={
                props.scheduleAttentionCount > 0
                  ? `Recurring missions - ${props.scheduleAttentionCount} need attention`
                  : "Recurring missions"
              }
            >
              <span aria-hidden>◷</span> <span className="tb-label">Missions</span>
              {props.scheduleAttentionCount > 0 && (
                <span className="ghost-badge">{props.scheduleAttentionCount}</span>
              )}
            </button>
          </Tooltip>
        </div>
        <div className="tb-group">
          <ForemanBar
            state={props.foreman}
            compact={isTopbarItemCompact(layout, "foreman")}
            {...(props.foremanOpenRequest !== undefined ? { openRequest: props.foremanOpenRequest } : {})}
            onOpenModels={props.onOpenModels}
            onOpenSettings={props.onOpenForemanSettings}
          />
          <Tooltip label={`Dispatch a new agent (${formatChord(bindings.dispatch)})`}>
            <button className="dispatch-btn" onClick={props.onOpenDispatch} ref={props.dispatchRef}>
              {/* The keycap REPLACES the decorative glyph rather than sitting beside
                  it: the default chord is "+", so drawing both put a ＋ on each end of
                  one word and read as a rendering fault. Any other chord takes the
                  same slot, which is the one place on this button an operator is
                  already looking. */}
              {keybindingHints ? <Keycap action="dispatch" /> : <span aria-hidden>＋</span>}
              Dispatch
            </button>
          </Tooltip>
        </div>
        <div className="tb-group tb-tools">
          {/* Glyph-only, like its two peers, and so it adds the same ~30px at every rung
              rather than a word that has to be shed. The accessible name is the same
              phrase the palette row uses, at every width, because this button is the
              one an unhappy person hunts for and it must not go quiet. */}
          {isTopbarItemShown(layout, "feedback") && (
            <Tooltip label="Report product feedback - file a public GitHub issue about Mission Control">
              <button
                className="ghost-btn glyph-btn feedback-btn"
                onClick={props.onOpenFeedback}
                aria-label="Report product feedback"
              >
                <span aria-hidden>☺</span>
              </button>
            </Tooltip>
          )}
          <Tooltip
            label={
              page === "settings"
                ? "Return to the fleet of running sessions"
                : props.gearPhrase
                  ? `Settings (⌘,) - ${props.gearPhrase}`
                  : "Settings (⌘,)"
            }
          >
            <button
              ref={props.gearRef}
              className={`ghost-btn glyph-btn gear-btn${page === "settings" ? " is-active" : ""}`}
              onClick={props.onGear}
              // The label changes with what the click will do, the way the Workflows
              // button's does. No `aria-pressed` beside it: a toggle button that
              // renames itself and reports a pressed state announces the same fact
              // twice, and the second telling contradicts the first ("Return to Fleet,
              // pressed"). The worst-status phrase rides the label so the dot's meaning
              // is not carried by colour alone.
              aria-label={
                page === "settings"
                  ? "Return to Fleet"
                  : props.gearPhrase
                    ? `Settings - ${props.gearPhrase}`
                    : "Settings"
              }
            >
              <span aria-hidden>⚙</span>
              {/* The gear inherits the worst rail dot, so a subsystem needing attention
                  is visible without opening Settings. Purely visual - the phrase above
                  carries it to assistive tech. */}
              {props.gearDot && <span className={`gear-dot settings-dot-${props.gearDot}`} aria-hidden />}
            </button>
          </Tooltip>
          {isTopbarItemShown(layout, "alerts") && (
            <AlertBar
              settings={props.alertSettings}
              update={props.updateAlerts}
              away={props.away}
              setAway={props.setAway}
              buffered={props.buffered}
            />
          )}
        </div>
      </div>
    </>
  );

  return props.preview ? (
    <div className="topbar topbar-preview">{body}</div>
  ) : (
    <header className="topbar" ref={props.barRef}>
      {body}
    </header>
  );
}

/**
 * One segment of the fleet pulse: a tone dot, a figure, and a word.
 *
 * The word is a `.tb-label`, so the narrow ladder can take it away and leave a dot and a
 * number - which is why every segment carries a Tooltip whether or not it is clickable.
 * Tooltip always renders its label into a hidden `aria-describedby` node, so the meaning
 * survives the collapse for a screen reader as well as for a pointer.
 */
function PulseStat({
  n,
  label,
  tip,
  tone,
  onClick,
}: {
  n: number;
  label: string;
  tip: string;
  tone?: Tone;
  onClick?: () => void;
}): React.JSX.Element {
  const cls = `pulse-seg${tone ? ` pulse-${tone}` : ""}`;
  const body = (
    <>
      <span className="pulse-dot" aria-hidden />
      <span className="pulse-n">{n}</span>
      <span className="tb-label">{label}</span>
    </>
  );
  return (
    <Tooltip label={tip}>
      {onClick ? (
        <button type="button" className={`${cls} pulse-btn`} onClick={onClick}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </Tooltip>
  );
}

/**
 * The fleet's state as ONE readout.
 *
 * This was four separately-bordered pills plus a `live` indicator stranded on the far side
 * of the action cluster - five bordered boxes for one idea, at the same visual weight as
 * the seven buttons beside them, and the widest thing in the bar. One container with
 * hairline-separated segments says the same in roughly two thirds the width and one
 * border, which is most of what buys the single row at half screen.
 *
 * The connection state leads the readout rather than trailing the actions, because that is
 * what it qualifies: every figure to its right came over the stream, so when the stream is
 * down they are stale and `.is-down` dims them to say so. That is also why the down state
 * keeps its word while the counts give theirs up on the narrow ladder - a lone red dot is
 * the one thing here you cannot afford to have to hover.
 */
function FleetPulse({
  connected,
  keepAwake,
  sessions,
  attention,
  working,
  inbox,
  onOpenInbox,
}: {
  connected: boolean;
  /** The daemon's Keep Awake observation; null while unknown (pre-snapshot, or SSE down). */
  keepAwake: KeepAwakeStatus | null;
  /** Null when the operator hid the session count; the figure is still a fact, just not drawn. */
  sessions: number | null;
  attention: number;
  working: number;
  /**
   * How many answers the operator owes - the attention fold's total, not a review count.
   *
   * A separate segment from `attention`, which counts SESSIONS in an attention tone. The two
   * are different UNITS of one set, not different sets: `attention` is how many agents are
   * blocked, `inbox` is how many replies it takes to unblock them, so one session holding
   * three questions reads `1 need you` beside `3 to answer`. It reads "to answer" rather than
   * borrowing "need you" because two segments carrying the same word in one readout is a
   * figure nobody can attribute.
   *
   * `inbox >= attention` always, and `attention-pill-invariant.test.ts` holds the fold to it.
   * The reverse used to be reachable - a session parked on a permission prompt, or one whose
   * `awaiting_input` came from a hook that files no review, counted in `attention` and
   * produced no inbox row - which put `1 need you` next to a click that opened an empty list.
   */
  inbox: number;
  onOpenInbox: () => void;
}): React.JSX.Element {
  return (
    <div className={`pulse${connected ? "" : " is-down"}`}>
      {/* The connection segment, now the Keep Awake control. It keeps the leading
          position and the live/reconnecting word because the connection fact still
          qualifies every figure to its right; the dropdown it opens is the one place
          host power state is controlled from. */}
      <KeepAwakeControl connected={connected} status={keepAwake} />
      {sessions !== null && (
        <PulseStat
          n={sessions}
          label={sessions === 1 ? "session" : "sessions"}
          tip={`${sessions} session${sessions === 1 ? "" : "s"} on the fleet`}
        />
      )}
      {attention > 0 && (
        <PulseStat
          n={attention}
          label="need you"
          tone="attention"
          tip={`${attention} session${attention === 1 ? " is" : "s are"} waiting on you`}
        />
      )}
      {working > 0 && (
        <PulseStat
          n={working}
          label="working"
          tone="working"
          tip={`${working} session${working === 1 ? " is" : "s are"} working`}
        />
      )}
      {inbox > 0 && (
        <PulseStat
          n={inbox}
          label="to answer"
          tone="attention"
          onClick={onOpenInbox}
          tip={`${inbox} thing${inbox === 1 ? " is" : "s are"} waiting on you - agents' questions, ensemble decisions and parked gates. Open the inbox`}
        />
      )}
    </div>
  );
}
