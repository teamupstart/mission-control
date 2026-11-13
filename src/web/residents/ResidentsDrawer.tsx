import { useEffect, useRef, type CSSProperties } from "react";
import type { ResidentProfile, ResidentRunSummary } from "@shared/residents.ts";
import { activePaneDialog } from "@shared/session.ts";
import type { PaneDialog, ReviewItem, Session } from "@shared/types.ts";
import { Keycap } from "../components/Keycap.tsx";
import { RepoGroupCaret } from "../components/session-bits.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { stateDisplay } from "../lib/format.ts";
import { formatChord, isTypingTarget, useKeybindings } from "../lib/keybindings.ts";
import { reviewAskSummary } from "../lib/reviews.ts";
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
 * The live residents in the order the dock and `⌥1`…`⌥9` share, and the drawer keeps within each
 * of its groups: `runs` order, oldest launch first. One derivation, so the keycap a card prints
 * is the key that opens it.
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

/** A listed resident whose session has started and needs you: the Board's Needs you tone. */
function entryNeedsYou(entry: ResidentDrawerEntry): boolean {
  return entry.session !== null && stateDisplay(entry.session).tone === "attention";
}

/**
 * The drawer's two groups, each in the dock's order: residents that need you, drawn first under a
 * Needs you heading, then every other live resident. The `⌥`-numbers stay with the launch order,
 * so a resident that starts asking moves up without renumbering anyone.
 */
export function residentDrawerGroups(entries: readonly ResidentDrawerEntry[]): {
  needsYou: ResidentDrawerEntry[];
  others: ResidentDrawerEntry[];
} {
  const needsYou: ResidentDrawerEntry[] = [];
  const others: ResidentDrawerEntry[] = [];
  for (const entry of entries) (entryNeedsYou(entry) ? needsYou : others).push(entry);
  return { needsYou, others };
}

/**
 * Which card the drawer selects when it opens with no live selection: the first resident that
 * needs you, else the first that has a session to open.
 */
export function defaultResidentSelection(entries: readonly ResidentDrawerEntry[]): string | null {
  const live = entries.filter((entry) => entry.session !== null);
  const pick = live.find(entryNeedsYou) ?? live[0];
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
  /** Every pending review; each card names the ones its resident raised. */
  reviews: readonly ReviewItem[];
  /**
   * Open the review modal on a resident's pending reviews, or the menu it is parked on. The drawer
   * never answers either itself: a card names what is being asked, and the modal answers it.
   */
  onOpenReview: (sessionId: string) => void;
}

/**
 * The Residents drawer: every live resident as a card in its marker color, each open or
 * compressed by a click on its title, and the profiles with Launch underneath. Residents that
 * need you lead it, grouped under a Needs you heading.
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

  const groups = residentDrawerGroups(entries);
  // The arrow keys walk the cards in the order they are drawn: the Needs you group first.
  const openable = [...groups.needsYou, ...groups.others]
    .filter((entry): entry is ResidentDrawerEntry & { session: Session } => entry.session !== null);

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
  const renderCard = (entry: ResidentDrawerEntry): React.JSX.Element => (
    <ResidentDrawerCard
      key={entry.run.id}
      entry={entry}
      selected={entry.session !== null && entry.session.id === selectedId}
      collapsed={entry.session !== null && collapsed.has(entry.session.id)}
      onSelect={props.onSelect}
      onOpen={props.onOpen}
      onOpenReview={props.onOpenReview}
      reviews={props.reviews}
    />
  );
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
          <>
            {/* Residents that need you lead the drawer, in the Board's Needs you color, with the
                review chord's keycap on the heading: after any fleet session asking, `e` addresses
                the first of them - its review queue, or its conversation (`reviewChordTarget`). */}
            {groups.needsYou.length > 0 && (
              <section className="residents-drawer-group is-needs-you" aria-labelledby="residents-drawer-needs-you">
                <h3 className="residents-drawer-group-head" id="residents-drawer-needs-you">
                  Needs you
                  <span className="residents-drawer-group-key"><Keycap action="review" /></span>
                  {/* The list below announces how many; the number is for the eye. */}
                  <span className="residents-drawer-group-n" aria-hidden>{groups.needsYou.length}</span>
                </h3>
                <ul className="residents-drawer-list" aria-label="Residents that need you">
                  {groups.needsYou.map(renderCard)}
                </ul>
              </section>
            )}
            {groups.others.length > 0 && (
              <ul className="residents-drawer-list" aria-label="Live residents">
                {groups.others.map(renderCard)}
              </ul>
            )}
          </>
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
 * and drops the rest - what it is asking and the loop tags - so more residents fit.
 */
function ResidentDrawerCard({ entry, selected, collapsed, onSelect, onOpen, onOpenReview, reviews }: {
  entry: ResidentDrawerEntry;
  selected: boolean;
  /** Compressed by a click on its title. Never true for a card whose session has not started. */
  collapsed: boolean;
  onSelect: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onOpenReview: (sessionId: string) => void;
  reviews: readonly ReviewItem[];
}): React.JSX.Element {
  const { mark, session, run, shortcut } = entry;
  const state = session ? stateDisplay(session) : { label: "starting", tone: "neutral" as const };
  const needsYou = state.tone === "attention";
  // The tone the Board files this session under, so a working resident's card is edged in the
  // Working column's color and one that needs you in the Needs you column's, in every theme.
  const working = state.tone === "working";
  const status = collapsed ? null : <ResidentLoopStatusLine loop={run} session={session} tags />;
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
      {session ? (
        <ResidentDrawerCardBody
          session={session}
          name={mark.name}
          compressed={collapsed}
          status={status}
          onOpen={() => onOpen(session.id)}
          onOpenReview={() => {
            onSelect(session.id);
            onOpenReview(session.id);
          }}
          reviews={reviews.filter((review) => review.sessionId === session.id && review.status === "pending")}
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
      ) : status}
    </li>
  );
}

/**
 * Whether a click inside a card's body is a request to open the conversation: one that lands in
 * its main region, or on the body itself - the gap between that region and the actions. A click
 * anywhere in the actions is theirs, even between their buttons; a click on a control inside the
 * main region (an ask row) is that control's; and a drag that selected some text is reading.
 */
function bodyClickOpens(e: React.MouseEvent<HTMLElement>): boolean {
  const target = e.target as Element;
  const main = target.closest?.(".residents-drawer-card-main");
  if (target !== e.currentTarget && !(main && e.currentTarget.contains(main))) return false;
  const control = target.closest?.("button, a[href], input, select, textarea, summary");
  if (control && e.currentTarget.contains(control)) return false;
  const selection = window.getSelection();
  return !(selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode));
}

/**
 * A card's body under its title: the loop facts (`status`), then what the resident is asking or
 * else its latest message, then the card's actions (`children`). A click anywhere between the
 * title and the actions opens the resident's conversation, as **Open** does; the keyboard's way
 * there is Enter on the card's title. There is no reply box: a free-form reply is written in the
 * resident's Conversation.
 *
 * Nothing the resident asks is answered on the card. Each pending review is one row in the Needs
 * you color naming the question, and a click on it opens the review modal, where it is answered.
 * A menu the session is parked on is one such row too, and opens the same modal, which draws the
 * menu with the Conversation's own `PaneDialogPrompt`.
 *
 * `compressed` keeps only the live status line - one line of what the resident is doing, which
 * follows its activity as it changes - and the actions. What it is asking waits for the card to
 * be opened again.
 */
export function ResidentDrawerCardBody({ session, name, compressed = false, status = null, onOpen, onOpenReview, reviews, children }: {
  session: Session;
  name: string;
  /** The card is compressed: the status line and the actions only. */
  compressed?: boolean;
  /** The loop facts, drawn first inside the region a click opens. */
  status?: React.ReactNode;
  /** Open the resident's conversation. Without it, the region is not a way in. */
  onOpen?: () => void;
  /** Open the review modal on this resident's pending reviews or the menu it is parked on. */
  onOpenReview?: () => void;
  /** This resident's pending reviews, oldest first. */
  reviews: readonly ReviewItem[];
  children: React.ReactNode;
}): React.JSX.Element {
  const dialog = activePaneDialog(session);
  // The line the Console rail prints under a session's name: the last thing it reported.
  const latest = session.activity ?? session.goal?.text ?? null;
  // Every requested decision gets a row, in the order the review modal draws them: the menu the
  // session is parked on first, then each pending review. Never one instead of the other, so the
  // card never counts fewer than the modal it opens.
  const asks = compressed || (reviews.length === 0 && !dialog) ? null : (
    <ul className="residents-drawer-asks" aria-label={`${name} is asking`}>
      {dialog && (
        <li key="menu">
          <ResidentAskRow
            kind="menu"
            title={dialog.prompt ?? "Waiting at a menu"}
            detail={paneDialogDetail(dialog)}
            tooltip={`Open the review to answer ${name}`}
            onClick={onOpenReview}
          />
        </li>
      )}
      {reviews.map((review) => {
        const summary = reviewAskSummary(review);
        return (
          <li key={review.id}>
            <ResidentAskRow
              kind={summary.kind}
              title={review.title}
              detail={summary.detail}
              tooltip={`Open the review to answer ${name}`}
              onClick={onOpenReview}
            />
          </li>
        );
      })}
    </ul>
  );
  // Compressed, the line falls back to the state, so the card always says something.
  const text = compressed ? (latest ?? stateDisplay(session).label) : asks ? null : latest;
  const latestLine = text === null ? null : (
    <p className={`residents-drawer-latest${compressed ? " is-compressed" : ""}`} aria-label={`Latest from ${name}`}>{text}</p>
  );
  return (
    // The whole body is the way in - the loop facts, the asks, the latest message and the gap
    // above the actions - and only the actions (`children`) keep their clicks to themselves.
    <div
      className={`residents-drawer-card-body${compressed ? " is-compressed" : ""}${onOpen ? " is-openable" : ""}`}
      onClick={onOpen ? (e) => {
        if (bodyClickOpens(e)) onOpen();
      } : undefined}
    >
      <div className="residents-drawer-card-main">
        {status}
        {(asks || latestLine) && (
          <div className="residents-drawer-card-text">
            {asks}
            {latestLine && onOpen ? <Tooltip label={`Open ${name}'s conversation`}>{latestLine}</Tooltip> : latestLine}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * A menu's rows as one line under its prompt, or, for a form of several questions, how many it
 * asks - the same line a review row prints for a question with options, or for several.
 */
function paneDialogDetail(dialog: PaneDialog): string | null {
  const questions = dialog.questions ?? [];
  if (questions.length > 1) return `${questions.length} questions`;
  const rows = questions.length === 1 ? questions[0]!.options : dialog.options;
  const labels = rows.map((option) => option.label).filter((label) => label.length > 0);
  return labels.length > 0 ? labels.join(" · ") : null;
}

/**
 * One thing a resident is asking: its kind, its title and a line on what answering it takes, in
 * the Needs you color. A click opens where it is answered; nothing is answered on the card.
 */
function ResidentAskRow({ kind, title, detail, tooltip, onClick }: {
  kind: string;
  title: string;
  detail: string | null;
  tooltip: string;
  onClick?: () => void;
}): React.JSX.Element {
  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        className="residents-drawer-ask"
        aria-label={`${kind}: ${title}${detail ? ` - ${detail}` : ""}`}
        disabled={!onClick}
        onClick={onClick}
      >
        <span className="residents-drawer-ask-kind" aria-hidden>{kind}</span>
        <span className="residents-drawer-ask-text" aria-hidden>
          <span className="residents-drawer-ask-title">{title}</span>
          {detail && <span className="residents-drawer-ask-detail">{detail}</span>}
        </span>
        <span className="residents-drawer-ask-go" aria-hidden>→</span>
      </button>
    </Tooltip>
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
