import { useEffect, useRef, type CSSProperties } from "react";
import type { ResidentProfile, ResidentRunSummary } from "@shared/residents.ts";
import { activePaneDialog } from "@shared/session.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import { PaneDialogPrompt } from "../components/PaneDialogPrompt.tsx";
import { RepoGroupCaret } from "../components/session-bits.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { stateDisplay } from "../lib/format.ts";
import { formatChord, isTypingTarget, useKeybindings } from "../lib/keybindings.ts";
import { toggleResidentCardCollapsed, useResidentCardsCollapsed } from "./card-fold.ts";
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
  /**
   * Pinned: stored, so the drawer is still open after a reload or a restart. Unpinned, it is
   * the same column, open for this page load only. Only the Pin button reads this.
   */
  pinned: boolean;
  /**
   * The selected resident's session id: the card the arrow keys stand on and Enter opens. Whether
   * a card is open or compressed is its own fold (`card-fold.ts`), not this.
   */
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** Open a resident's full detail, from this drawer. */
  onOpen: (sessionId: string) => void;
  /** Close the drawer, pinned or not. */
  onClose: () => void;
  onPinnedChange: (pinned: boolean) => void;
  launcher: ResidentLaunches;
  /** Open Dispatch > Resident on a profile, for a launch that needs a repository chosen. */
  onOpenLaunch: (profileId: string) => void;
  /** Open `#/residents`. */
  onManage: () => void;
  /**
   * A changed value moves focus onto that resident's card: how the drawer takes the keyboard
   * when it is opened, and the answer to Escape out of a detail opened from it. A null
   * `sessionId` means the selected card, or the first that needs you, whenever one exists; so
   * does one naming a resident that is no longer listed.
   */
  focusRequest?: { sessionId: string | null; nonce: number } | null;
  /** The request above has been applied; App clears it so a remount does not replay it. */
  onFocusRequestHandled?: () => void;
  /** Every pending review; the selected card answers the ones its resident raised. */
  reviews: readonly ReviewItem[];
  /**
   * Draw one pending review through the app's `ReviewCard`. Injected rather than imported:
   * `ReviewModal.tsx` pulls in react-diff-view's stylesheet, which Node cannot load, and this
   * drawer is rendered by unit tests.
   */
  renderReview: (review: ReviewItem, session: Session) => React.ReactNode;
}

/**
 * The Residents drawer: every live resident as a card in its marker color, each open or
 * compressed by a click on its title, and the profiles with Launch underneath.
 *
 * Always a non-modal column beside the fleet, so the Board or Console narrows instead of being
 * covered or dimmed, and the fleet's keys stay live. Pinned or not, it looks and behaves the same;
 * the pin only decides whether it is still open after a reload.
 */
export function ResidentsDrawer(props: ResidentsDrawerProps): React.JSX.Element {
  const { entries, pinned, selectedId } = props;
  const { bindings } = useKeybindings();
  const collapsed = useResidentCardsCollapsed();
  const rootRef = useRef<HTMLElement | null>(null);

  /** The card's head button, when it is mounted and can take focus. */
  const cardHead = (sessionId: string): HTMLButtonElement | null => {
    const head = rootRef.current?.querySelector<HTMLButtonElement>(
      `[data-resident-card="${CSS.escape(sessionId)}"] .residents-drawer-card-head`,
    );
    return head && !head.disabled ? head : null;
  };
  const focusCard = (sessionId: string): void => cardHead(sessionId)?.focus({ preventScroll: false });

  // The drawer never takes focus on its own: it sits beside a live fleet. App asks for it as the
  // drawer is opened, and on the Escape out of a detail opened from it. A request is consumed,
  // not compared: one already set when the drawer mounts (App navigated to Fleet to show it) is
  // applied, and held until a card can take focus - the drawer can open before any resident has
  // arrived, or before the named one's session has started - when App clears it, so a later
  // remount never replays it.
  const { focusRequest, onFocusRequestHandled } = props;
  useEffect(() => {
    if (!focusRequest) return;
    // Only a listed resident is worth waiting for: one whose run has ended has no card to come,
    // so a request naming it - or a selection left on it - falls back to a live card instead.
    const listed = (id: string | null): id is string => id !== null && entries.some((entry) => entry.session?.id === id);
    const target = listed(focusRequest.sessionId)
      ? focusRequest.sessionId
      : listed(selectedId) ? selectedId : defaultResidentSelection(entries);
    if (!target) return;
    const head = cardHead(target);
    if (!head) return;
    head.focus({ preventScroll: false });
    onFocusRequestHandled?.();
  });
  // A request still waiting is dropped the moment the operator does anything else - any key or
  // press, inside the drawer or out on the fleet beside it - so a card that arrives late never
  // pulls the keyboard away from where someone already is.
  const handledRef = useRef(onFocusRequestHandled);
  handledRef.current = onFocusRequestHandled;
  useEffect(() => {
    if (!focusRequest) return;
    const drop = (): void => handledRef.current?.();
    document.addEventListener("keydown", drop, true);
    document.addEventListener("pointerdown", drop, true);
    return () => {
      document.removeEventListener("keydown", drop, true);
      document.removeEventListener("pointerdown", drop, true);
    };
  }, [focusRequest]);

  const openable = entries.filter((entry): entry is ResidentDrawerEntry & { session: Session } => entry.session !== null);

  /**
   * The arrow keys walk the cards and Enter opens the selected one. On the drawer element, so
   * they answer only while the keyboard is inside it, and `preventDefault` tells App's global
   * handler the press is taken - the drawer sits beside a live fleet.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
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
  const closeChord = formatChord(bindings.residentsDock);
  return (
    <aside
      ref={(el) => {
        rootRef.current = el;
      }}
      className="residents-drawer"
      aria-label="Residents"
      onKeyDown={onKeyDown}
    >
      <header className="residents-drawer-head">
        <h2>
          Residents <span className="residents-drawer-count">· {live} live</span>
        </h2>
        <kbd aria-hidden>{closeChord}</kbd>
        <Tooltip label={pinned
          ? "Unpin the drawer: it stays open now, and is closed after a reload or restart"
          : "Pin the drawer, so it is still open after a reload or restart"}
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
        <Tooltip label={`Close the drawer (${closeChord})`}>
          <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </Tooltip>
      </header>
      {/* A row of its own under the title, before the cards: at the foot of the drawer, under
          every card and profile, it was too easy to miss. */}
      <div className="residents-drawer-bar">
        <Tooltip label="Author, edit and archive resident profiles on the Residents page">
          <button type="button" className="btn residents-drawer-manage" onClick={props.onManage}>
            Manage residents <span aria-hidden>→</span>
          </button>
        </Tooltip>
      </div>
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
                collapsed={entry.session !== null && collapsed.has(entry.session.id)}
                onSelect={props.onSelect}
                onOpen={props.onOpen}
                reviews={props.reviews}
                renderReview={props.renderReview}
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
              if (answer === "needs-repository") props.onOpenLaunch(profile.id);
            })}
          />
        )}
      </footer>
    </aside>
  );
}

/**
 * One live resident. The head line is the card's title and its button: a click (or Space)
 * selects the card and folds it, open to compressed and back, the way a Board repository frame
 * folds; Enter or a double-click opens the resident. Open, the card carries its loop facts and
 * `ResidentDrawerCardBody` in full. Compressed, it keeps the live status line and the controls
 * and drops the rest - the question and the loop tags - so more residents fit.
 */
function ResidentDrawerCard({ entry, selected, collapsed, onSelect, onOpen, reviews, renderReview }: {
  entry: ResidentDrawerEntry;
  selected: boolean;
  /** Compressed by a click on its title. Never true for a card whose session has not started. */
  collapsed: boolean;
  onSelect: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  reviews: readonly ReviewItem[];
  renderReview: (review: ReviewItem, session: Session) => React.ReactNode;
}): React.JSX.Element {
  const { mark, session, run, shortcut } = entry;
  const state = session ? stateDisplay(session) : { label: "starting", tone: "neutral" as const };
  const needsYou = state.tone === "attention";
  // The tone the Board files this session under, so a working resident's card is edged in the
  // Working column's color and one that needs you in the Needs you column's, in every theme.
  const working = state.tone === "working";
  return (
    <li
      className={`residents-drawer-card${selected ? " is-selected" : ""}${collapsed ? " is-collapsed" : ""}${working ? " is-working" : ""}${needsYou ? " needs-you" : ""}`}
      style={residentAccentStyle(mark.colorId)}
      data-resident-card={session?.id}
    >
      <Tooltip label={session
        ? `${collapsed ? "Expand" : "Compress"} ${mark.name}; Enter or a double-click opens its conversation`
        : `${mark.name} is still starting`}
      >
        <button
          type="button"
          className="residents-drawer-card-head"
          aria-expanded={session ? !collapsed : undefined}
          aria-current={selected ? "true" : undefined}
          aria-label={`${mark.name}, ${state.label}`}
          disabled={!session}
          onClick={() => {
            if (!session) return;
            onSelect(session.id);
            toggleResidentCardCollapsed(session.id);
          }}
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
          {session && <RepoGroupCaret />}
        </button>
      </Tooltip>
      {!collapsed && <ResidentLoopStatusLine loop={run} session={session} tags />}
      {session && (
        <ResidentDrawerCardBody
          session={session}
          name={mark.name}
          compressed={collapsed}
          onOpen={() => onOpen(session.id)}
          reviews={reviews.filter((review) => review.sessionId === session.id && review.status === "pending")}
          renderReview={renderReview}
        >
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
 * A card's region under its title: what the resident is asking or last said, and the card's
 * actions (`children`) under it. There is no reply box: a free-form reply is written in the
 * resident's Conversation, which a click on the latest message opens.
 *
 * `compressed` keeps only the live status line - one line of what the resident is doing, which
 * follows its activity as it changes - and the actions. The question waits for the card to be
 * opened again.
 *
 * Nothing here is a second answering mechanism. A pending review is drawn through the app's
 * `ReviewCard` (`renderReview`), exactly as the attention inbox draws it, and a menu the session
 * is parked on is drawn through `PaneDialogPrompt`, the component the Conversation tab leads with.
 */
export function ResidentDrawerCardBody({ session, name, compressed = false, onOpen, reviews, renderReview, children }: {
  session: Session;
  name: string;
  /** The card is compressed: the status line and the actions only. */
  compressed?: boolean;
  /**
   * Open the resident's conversation: a click on an open card's latest message, which is the
   * text the Conversation continues. The keyboard's way there is Enter on the card's title.
   */
  onOpen?: () => void;
  /** This resident's pending reviews, oldest first. */
  reviews: readonly ReviewItem[];
  renderReview: (review: ReviewItem, session: Session) => React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const dialog = activePaneDialog(session);
  // The line the Console rail prints under a session's name: the last thing it reported.
  const latest = session.activity ?? session.goal?.text ?? null;
  if (compressed) {
    return (
      <div className="residents-drawer-card-body is-compressed">
        <p className="residents-drawer-latest is-compressed" aria-label={`Latest from ${name}`}>
          {latest ?? stateDisplay(session).label}
        </p>
        {children}
      </div>
    );
  }
  return (
    <div className="residents-drawer-card-body">
      {reviews.length > 0 ? (
        <div className="residents-drawer-ask" aria-label={`${name} is asking`}>
          {reviews.map((review) => <div key={review.id}>{renderReview(review, session)}</div>)}
        </div>
      ) : dialog ? (
        <div className="residents-drawer-ask" aria-label={`${name} is asking`}>
          <PaneDialogPrompt sessionId={session.id} dialog={dialog} note={session.note} />
        </div>
      ) : latest ? (
        onOpen ? (
          <Tooltip label={`Open ${name}'s conversation`}>
            <p
              className="residents-drawer-latest is-openable"
              aria-label={`Latest from ${name}`}
              onClick={(e) => {
                // A drag that selected some of the text is reading, not opening.
                const selection = window.getSelection();
                if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return;
                onOpen();
              }}
            >
              {latest}
            </p>
          </Tooltip>
        ) : (
          <p className="residents-drawer-latest" aria-label={`Latest from ${name}`}>{latest}</p>
        )
      ) : null}
      {children}
    </div>
  );
}

/**
 * The tab on the window's right edge while the drawer is closed: ⌂ and the live count, with no
 * number at zero. It lights in the colors of the Board columns its residents sit in: Working's
 * while any resident works, Needs you's while any needs you, and both at once when both are true
 * - Needs you on the tab's own edge and glyph, which it outranks, and Working as a ring outside.
 */
export function ResidentsEdgeTab({ live, needsYou, working, onOpen }: {
  live: number;
  needsYou: boolean;
  /** Any live resident is working. */
  working: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const label = `Open the Residents drawer - ${live} live${needsYou ? ", a resident needs you" : ""}${working ? ", a resident is working" : ""}`;
  return (
    <Tooltip label={label}>
      <button
        type="button"
        className={`residents-edge-tab${needsYou ? " needs-you" : ""}${working ? " is-working" : ""}`}
        aria-label={label}
        onClick={onOpen}
      >
        <span aria-hidden>⌂</span>
        {live > 0 && <span className="residents-edge-count" aria-hidden>{live}</span>}
      </button>
    </Tooltip>
  );
}
