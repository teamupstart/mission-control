import type { Session } from "@shared/types.ts";
import type { ActionBarHandle } from "../ActionBar.tsx";

/**
 * What every layout gets from App, which stays the single owner of session state.
 * A layout arranges; it never decides.
 *
 * One shared bundle rather than each view growing its own prop list: SessionCard
 * takes eighteen props, and three hand-written copies of that wiring is three
 * places for a layout to quietly stop passing (say) `pendingReviewIds` and start
 * lying about a stale Foreman draft. `cardProps` below is the single spelling.
 */
export interface SessionViewProps {
  /** The visible, sorted sessions - already filtered; layouts render exactly these. */
  sessions: Session[];
  /** Sessions whose parked no-mistakes gate actually needs you (computed cross-session). */
  gateAlerts: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Drop the selection (closes the board's drawer, empties the console's detail). */
  onDeselect: () => void;
  /** Grid focus mode. Meaningless where the detail is always open (console, board). */
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onOpenReviews: (id: string) => void;
  onOpenDiff: (id: string, commit?: string) => void;
  onReset: (id: string) => void;
  /** Per-session counter bumped on each reset, so a card can remount its (uncontrolled)
   *  reply box and clear the text a reset discarded. Absent id means never reset (0). */
  resetNonces: Record<string, number>;
  registerEl: (id: string, el: HTMLElement | null) => void;
  registerActions: (id: string, handle: ActionBarHandle | null) => void;
  renamingId: string | null;
  onRenameStart: (id: string) => void;
  onRenameClose: () => void;
  foremanMode: string;
  foremanEnabled: boolean;
  foremanAllowlist?: string[];
  inputReviewBySession: ReadonlyMap<string, string>;
  pendingReviewIds: ReadonlySet<string>;
}

/**
 * The props for one session's card, spelled once. Views spread this and override
 * only what their shape demands - the console and board pass `expanded` because
 * their detail pane is, by definition, always the expanded card.
 */
export function cardProps(p: SessionViewProps, s: Session) {
  return {
    session: s,
    gateNeedsYou: p.gateAlerts.has(s.id),
    selected: s.id === p.selectedId,
    onSelect: () => p.onSelect(s.id),
    expanded: p.expandedId === s.id,
    onToggleExpand: () => p.onToggleExpand(s.id),
    onOpenReviews: () => p.onOpenReviews(s.id),
    onOpenDiff: (commit?: string) => p.onOpenDiff(s.id, commit),
    onReset: () => p.onReset(s.id),
    resetNonce: p.resetNonces[s.id] ?? 0,
    registerEl: p.registerEl,
    registerActions: p.registerActions,
    renaming: p.renamingId === s.id,
    onRenameStart: () => p.onRenameStart(s.id),
    onRenameClose: p.onRenameClose,
    foremanMode: p.foremanMode,
    foremanEnabled: p.foremanEnabled,
    foremanAllowlist: p.foremanAllowlist,
    inputReviewId: p.inputReviewBySession.get(s.id) ?? null,
    pendingReviewIds: p.pendingReviewIds,
  };
}
