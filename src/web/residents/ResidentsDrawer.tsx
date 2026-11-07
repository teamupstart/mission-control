import { useEffect, useRef, type CSSProperties } from "react";
import type { ResidentProfile, ResidentRunSummary } from "@shared/residents.ts";
import type { Session } from "@shared/types.ts";
import { OVERLAY_IDS, Overlay } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { stateDisplay } from "../lib/format.ts";
import { formatChord, isTypingTarget, useKeybindings } from "../lib/keybindings.ts";
import { ResidentChip } from "./ResidentChip.tsx";
import { ResidentControlStatus } from "./ResidentControlStatus.tsx";
import { ResidentLoopControls, ResidentLoopStatusLine } from "./ResidentLoopControls.tsx";
import { ResidentProfileLaunchList } from "./ResidentProfileLaunchList.tsx";
import { residentAccentStyle, residentSessionMark, type ResidentSessionMark } from "./marker.ts";
import type { ResidentLaunches } from "./useResidentLaunches.ts";

/** One live resident as the drawer lists it, in the dock's order. */
export interface ResidentDrawerEntry {
  run: ResidentRunSummary;
  mark: ResidentSessionMark;
  /** Null while its session has not started: it is listed, but there is nothing to open yet. */
  session: Session | null;
  /** 1-based `⌥`-number, or null past the ninth. */
  shortcut: number | null;
}

/**
 * The live residents in the order the drawer, the dock and `⌥1`…`⌥9` all share: `runs` order,
 * oldest launch first. One derivation, so the keycap a card prints is the key that opens it.
 */
export function residentDrawerEntries(
  runs: readonly ResidentRunSummary[],
  profiles: readonly ResidentProfile[],
  sessions: readonly Session[],
): ResidentDrawerEntry[] {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const sessionByTask = new Map<string, Session>();
  for (const session of sessions) if (session.task) sessionByTask.set(session.task.id, session);
  return runs.map((run, index) => ({
    run,
    mark: residentSessionMark(run, profileById.get(run.profileId) ?? null),
    session: sessionByTask.get(run.taskId) ?? null,
    shortcut: index < 9 ? index + 1 : null,
  }));
}

/**
 * Which card the drawer selects when it opens with no live selection: the first resident that
 * needs you, else the first that has a session to open.
 */
export function defaultResidentSelection(entries: readonly ResidentDrawerEntry[]): string | null {
  const live = entries.filter((entry) => entry.session !== null);
  const pick = live.find((entry) => stateDisplay(entry.session!).tone === "attention") ?? live[0];
  return pick?.session?.id ?? null;
}

/** The keycap spelling of resident N's jump. */
export function residentShortcutLabel(n: number): string {
  return `⌥${n}`;
}

export interface ResidentsDrawerProps {
  entries: readonly ResidentDrawerEntry[];
  profiles: readonly ResidentProfile[];
  /** Pinned as a column beside the fleet, rather than floating over the page. */
  pinned: boolean;
  /** The selected resident's session id: its card is expanded. */
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** Open a resident's full detail, from this drawer. */
  onOpen: (sessionId: string) => void;
  /** Close the floating drawer. */
  onClose: () => void;
  onPinnedChange: (pinned: boolean) => void;
  launcher: ResidentLaunches;
  /** Open Dispatch > Resident on a profile, for a launch that needs a repository chosen. */
  onOpenLaunch: (profileId: string) => void;
  /** Open `#/residents`. */
  onManage: () => void;
  /**
   * A changed value moves focus onto that resident's card: the pinned drawer's answer to
   * Escape out of a detail opened from it.
   */
  focusRequest?: { sessionId: string; nonce: number } | null;
}

/**
 * The Residents drawer: every live resident as a card in its marker color, the selected one
 * expanded, and the profiles with Launch underneath.
 *
 * Floating, it is a right-aligned `<Overlay>` like Sitrep, so the page behind it dims, Escape
 * and a click outside close it, and the fleet's keys stand down while it is up. Pinned, the
 * same content is a non-modal column beside the fleet, so the Board narrows instead of being
 * covered and its keys stay live.
 */
export function ResidentsDrawer(props: ResidentsDrawerProps): React.JSX.Element {
  const { entries, pinned, selectedId } = props;
  const { bindings } = useKeybindings();
  const rootRef = useRef<HTMLElement | null>(null);

  /** The card's head button, when it is mounted and can take focus. */
  const cardHead = (sessionId: string): HTMLButtonElement | null => {
    const head = rootRef.current?.querySelector<HTMLButtonElement>(
      `[data-resident-card="${CSS.escape(sessionId)}"] .residents-drawer-card-head`,
    );
    return head && !head.disabled ? head : null;
  };
  const focusCard = (sessionId: string): void => cardHead(sessionId)?.focus({ preventScroll: false });

  // Floating: the keyboard goes inside as the drawer opens, onto the selected card, so the arrow
  // keys and Enter act on it at once. A pinned drawer never takes focus on its own.
  //
  // Held until it lands rather than tried once on mount: the drawer can open before its cards'
  // sessions have arrived, when their heads are still disabled, and focusing nothing then left the
  // keyboard on the page behind it. Any key or press inside the drawer settles it, so a late
  // session never pulls focus away from where someone already is.
  const focusPending = useRef(!pinned);
  useEffect(() => {
    focusPending.current = !pinned;
  }, [pinned]);
  useEffect(() => {
    if (!focusPending.current) return;
    const live = selectedId !== null && entries.some((entry) => entry.session?.id === selectedId);
    const target = live ? selectedId : defaultResidentSelection(entries);
    if (target) {
      const head = cardHead(target);
      if (!head) return;
      head.focus({ preventScroll: false });
      focusPending.current = false;
      return;
    }
    // Nothing to select yet. With no resident listed at all, the first control takes it.
    if (entries.length > 0) return;
    rootRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    focusPending.current = false;
  });
  const settleFocus = (): void => {
    focusPending.current = false;
  };

  const handledFocus = useRef(props.focusRequest?.nonce);
  useEffect(() => {
    const request = props.focusRequest;
    if (!request || request.nonce === handledFocus.current) return;
    handledFocus.current = request.nonce;
    focusCard(request.sessionId);
  }, [props.focusRequest]);

  const openable = entries.filter((entry): entry is ResidentDrawerEntry & { session: Session } => entry.session !== null);

  /**
   * The arrow keys walk the cards and Enter opens the selected one. On the drawer element, so
   * both placements answer only while the keyboard is inside it, and `preventDefault` tells
   * App's global handler the press is taken - the pinned drawer sits beside a live fleet.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
    settleFocus();
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (openable.length === 0) return;
      e.preventDefault();
      const at = openable.findIndex((entry) => entry.session.id === selectedId);
      const next = at === -1
        ? openable[e.key === "ArrowDown" ? 0 : openable.length - 1]!
        : openable[Math.min(openable.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]!;
      props.onSelect(next.session.id);
      focusCard(next.session.id);
      return;
    }
    if (e.key === "Enter") {
      const target = e.target as HTMLElement;
      const head = target.closest<HTMLElement>(".residents-drawer-card-head");
      // Any other button keeps its own activation: Open, Run now, Pause, Launch.
      if (!head && target.closest("button, a[href]")) return;
      const id = head?.closest<HTMLElement>("[data-resident-card]")?.dataset.residentCard ?? selectedId;
      if (!id || !openable.some((entry) => entry.session.id === id)) return;
      e.preventDefault();
      props.onOpen(id);
    }
  }

  const live = entries.length;
  const body = (
    <>
      <header className="residents-drawer-head">
        <h2>
          Residents <span className="residents-drawer-count">· {live} live</span>
        </h2>
        <kbd aria-hidden>{formatChord(bindings.residentsDock)}</kbd>
        <Tooltip label={pinned
          ? "Unpin the drawer: it closes, and opens over the page next time"
          : "Pin the drawer as a column beside the fleet, so the Board narrows instead of being covered"}
        >
          <button
            type="button"
            className="btn btn-ghost residents-drawer-pin"
            aria-pressed={pinned}
            onClick={() => props.onPinnedChange(!pinned)}
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
        </Tooltip>
        {!pinned && (
          <Tooltip label="Close the drawer (Escape)">
            <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
              ✕
            </button>
          </Tooltip>
        )}
      </header>
      <div className="residents-drawer-body">
        {entries.length === 0 ? (
          <p className="residents-drawer-empty">No residents are running. Launch one from a profile below.</p>
        ) : (
          <ul className="residents-drawer-list" aria-label="Live residents">
            {entries.map((entry) => (
              <ResidentDrawerCard
                key={entry.run.id}
                entry={entry}
                selected={entry.session !== null && entry.session.id === selectedId}
                onSelect={props.onSelect}
                onOpen={props.onOpen}
              />
            ))}
          </ul>
        )}
      </div>
      <footer className="residents-drawer-foot">
        <h3 className="residents-drawer-sec" id="residents-drawer-profiles">Profiles</h3>
        {props.profiles.length === 0 ? (
          <p className="residents-drawer-empty">No resident profiles yet. Author one on the Residents page.</p>
        ) : (
          <ResidentProfileLaunchList
            profiles={props.profiles}
            launches={props.launcher.launches}
            onLaunch={(profile) => void props.launcher.launch(profile).then((answer) => {
              if (answer !== "needs-repository") return;
              if (!pinned) props.onClose();
              props.onOpenLaunch(profile.id);
            })}
          />
        )}
        <Tooltip label="Author, edit and archive resident profiles on the Residents page">
          <button
            type="button"
            className="btn btn-ghost residents-pop-manage"
            onClick={() => {
              if (!pinned) props.onClose();
              props.onManage();
            }}
          >
            Manage residents <span aria-hidden>→</span>
          </button>
        </Tooltip>
      </footer>
    </>
  );

  if (pinned) {
    return (
      <aside
        ref={(el) => {
          rootRef.current = el;
        }}
        className="residents-drawer residents-drawer-pinned"
        aria-label="Residents"
        onKeyDown={onKeyDown}
        onPointerDown={settleFocus}
      >
        {body}
      </aside>
    );
  }
  return (
    <Overlay
      id={OVERLAY_IDS.residentsDrawer}
      onClose={props.onClose}
      as="aside"
      className="residents-drawer"
      role="dialog"
      ariaLabel="Residents"
      surfaceRef={(el) => {
        rootRef.current = el;
      }}
    >
      {/* The key handler sits on a wrapper inside the panel: `<Overlay>` owns the panel's own
          props, and React key events bubble here from every control in the drawer. */}
      <div className="residents-drawer-frame" onKeyDown={onKeyDown} onPointerDown={settleFocus}>
        {body}
      </div>
    </Overlay>
  );
}

/**
 * One live resident. The head line is the card's button: a click or Enter on it selects the
 * card, and Enter on the selected card opens it. The selected card expands into
 * `ResidentDrawerCardBody`.
 */
function ResidentDrawerCard({ entry, selected, onSelect, onOpen }: {
  entry: ResidentDrawerEntry;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
}): React.JSX.Element {
  const { mark, session, run, shortcut } = entry;
  const state = session ? stateDisplay(session) : { label: "starting", tone: "neutral" as const };
  const needsYou = state.tone === "attention";
  return (
    <li
      className={`residents-drawer-card${selected ? " is-selected" : ""}${needsYou ? " needs-you" : ""}`}
      style={residentAccentStyle(mark.colorId)}
      data-resident-card={session?.id}
    >
      <Tooltip label={session ? `Select ${mark.name}; Enter or a double-click opens its conversation` : `${mark.name} is still starting`}>
        <button
          type="button"
          className="residents-drawer-card-head"
          aria-expanded={session ? selected : undefined}
          aria-label={`${mark.name}, ${state.label}`}
          disabled={!session}
          onClick={() => session && onSelect(session.id)}
          onDoubleClick={() => session && onOpen(session.id)}
        >
          <ResidentChip mark={mark} tooltip={false} />
          <span className="residents-drawer-name">{mark.name}</span>
          <span
            className="residents-drawer-dot"
            style={{ "--tone": `var(--${state.tone})` } as CSSProperties}
            aria-hidden
          />
          {shortcut !== null && <kbd className="residents-drawer-key" aria-hidden>{residentShortcutLabel(shortcut)}</kbd>}
        </button>
      </Tooltip>
      <ResidentLoopStatusLine loop={run} session={session} tags />
      {selected && session && (
        <ResidentDrawerCardBody>
          <div className="residents-drawer-actions">
            <Tooltip label={`Open ${mark.name}'s conversation${shortcut !== null ? ` (${residentShortcutLabel(shortcut)})` : ""}`}>
              <button
                type="button"
                className="btn residents-pop-action"
                aria-label={`Open ${mark.name}`}
                onClick={() => onOpen(session.id)}
              >
                Open
              </button>
            </Tooltip>
            <ResidentLoopControls mark={mark} />
            <span className="residents-pop-spacer" aria-hidden />
            {(mark.controlOtherSessions || session.sessionControlEnabled === true) && (
              <ResidentControlStatus session={session} name={mark.name} badge />
            )}
          </div>
        </ResidentDrawerCardBody>
      )}
    </li>
  );
}

/**
 * The selected card's expanded region. Phase 1 holds the card's actions here; Phase 2 adds
 * the latest message or open question, its options and a reply box inside it, above them.
 */
export function ResidentDrawerCardBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="residents-drawer-card-body">{children}</div>;
}

/**
 * The tab on the window's right edge while the drawer is closed: ⌂ and the live count, with no
 * number at zero, amber while any resident needs you.
 */
export function ResidentsEdgeTab({ live, needsYou, onOpen }: {
  live: number;
  needsYou: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const label = `Open the Residents drawer - ${live} live${needsYou ? ", a resident needs you" : ""}`;
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className={`residents-edge-tab${needsYou ? " needs-you" : ""}`}
        aria-label={label}
        onClick={onOpen}
      >
        <span aria-hidden>⌂</span>
        {live > 0 && <span className="residents-edge-count" aria-hidden>{live}</span>}
      </button>
    </Tooltip>
  );
}
