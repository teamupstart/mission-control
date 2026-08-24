import type { StandingInstructionsView } from "@shared/protocol.ts";

// The decisions the Standing instructions panel makes about an ETag'd document it holds
// N+1 drafts over, extracted so they can be tested without rendering a hook - the shape
// `harnesses-reconcile.ts` already established for the same reason.
//
// ---- The one rule this module is built on ----
//
// A response may replace what the operator is looking at ONLY where the operator is not
// in the middle of deciding it.
//
// `useTaskSources.ts:49-60` records four separate defects that were all this sentence being
// missed: a poll response overwriting an in-flight optimistic edit, which the next commit
// then persisted, silently reverting the operator's config. This panel is MORE exposed than
// that one, because its edit is a long free-text field an operator may sit inside for
// minutes while a 4-second poll runs underneath - and what gets reverted is a rule an agent
// will then obey.
//
// So drafts are structurally separate from the baseline here, and no code path in this file
// writes a draft from a server response. A poll can only ever move `loaded`. That is
// stronger than sequencing the reads, and it is why the guard holds for an edit of any
// duration rather than for one that happens to finish between two polls.

/**
 * The card key of the machine-wide default box.
 *
 * The empty string, which `StandingInstructionsRepositoryKeySchema` forbids (`min(1)`), so
 * it can never collide with a repository key - and a bug that let it reach the wire would
 * be refused by the daemon rather than stored.
 */
export const DEFAULT_CARD = "";

export interface StandingInstructionsConflict {
  /** The newer document the daemon holds. */
  view: StandingInstructionsView;
  /** Only the cards this operator is editing whose STORED value actually moved. */
  cards: string[];
}

export interface StandingInstructionsDraftState {
  /** The server baseline: what Revert restores, and what a save compare-and-swaps against. */
  loaded: StandingInstructionsView;
  /**
   * Uncommitted text, one entry per card the operator has typed into. An ABSENT entry means
   * "not being edited" and is not the same as an entry holding the stored text - the
   * presence of an entry is what carries intent, which is what makes an explicit empty
   * override reachable (see `isDirty`).
   */
  drafts: Record<string, string>;
  /** Repositories added through the combobox that have no stored key yet. */
  staged: string[];
  conflict: StandingInstructionsConflict | null;
}

/** The stored value for a card: a string, or `null` for "absent, so inherit". */
export function storedValue(view: StandingInstructionsView, card: string): string | null {
  if (card === DEFAULT_CARD) return view.default;
  return Object.hasOwn(view.repositories, card) ? view.repositories[card]! : null;
}

/** What the textarea shows: the draft if there is one, else the stored text, else empty. */
export function draftValue(state: StandingInstructionsDraftState, card: string): string {
  const draft = state.drafts[card];
  if (draft !== undefined) return draft;
  return storedValue(state.loaded, card) ?? "";
}

/**
 * Whether this card has an unsaved change.
 *
 * `stored` is `null` for an absent key and that null never equals a string, which is what
 * makes "send nothing for this repository" reachable: an operator who opens an inherited
 * box, types, and then clears it has a draft of `""` against a stored `null`, so the card
 * is dirty and Save writes the empty override that beats the machine-wide default. Compare
 * against `stored ?? ""` instead and that gesture becomes a no-op with no other spelling in
 * the panel - the empty-versus-absent distinction the whole store is built on would have no
 * way to be expressed by the person it exists for.
 */
export function isDirty(state: StandingInstructionsDraftState, card: string): boolean {
  const draft = state.drafts[card];
  if (draft === undefined) return false;
  return draft !== storedValue(state.loaded, card);
}

/** Whether this card carries an override, as opposed to inheriting the default. */
export function isOverride(view: StandingInstructionsView, card: string): boolean {
  return card !== DEFAULT_CARD && storedValue(view, card) !== null;
}

/** Every card to draw, in stored order with staged repositories appended. */
export function cardsOf(state: StandingInstructionsDraftState): string[] {
  const stored = Object.keys(state.loaded.repositories);
  const extra = state.staged.filter((key) => !stored.includes(key));
  return [...stored, ...extra];
}

/** Which of `cards` hold a different stored value in `next` than they do in `before`. */
function movedCards(
  before: StandingInstructionsView,
  next: StandingInstructionsView,
  cards: readonly string[],
): string[] {
  return cards.filter((card) => storedValue(before, card) !== storedValue(next, card));
}

/** Every card the operator currently has an unsaved change in. */
export function dirtyCards(state: StandingInstructionsDraftState): string[] {
  return Object.keys(state.drafts).filter((card) => isDirty(state, card));
}

/**
 * Apply a poll, or the `current` view a `409` carried.
 *
 * Three outcomes, and the middle one is the one the shared ETag makes possible:
 *
 *  - **Same ETag.** Nothing moved; adopt it and change nothing else.
 *  - **Moved, but not under any card being edited.** Adopt it in full. Non-dirty cards
 *    follow the daemon, dirty drafts stay exactly as typed, and the NEW ETag is adopted
 *    deliberately - a save sends only its own repository's key, so a concurrent change to a
 *    different repository cannot make this operator's pending save wrong. Refusing to adopt
 *    here would turn every neighbour's edit into a conflict this operator has to clear
 *    before they can save a card nobody else touched.
 *  - **Moved under a card being edited.** Freeze the baseline, park the newer view, and let
 *    the operator choose. `loaded` is deliberately NOT advanced: it is what Revert restores
 *    and what the save compare-and-swaps against, so adopting it here would both destroy the
 *    "what was actually stored" answer and guarantee the next save silently wins a race the
 *    operator has not been told about.
 *
 * In none of the three does a draft change. That is the invariant, stated as code.
 */
export function reconcileRefresh(
  state: StandingInstructionsDraftState,
  current: StandingInstructionsView,
): StandingInstructionsDraftState {
  if (current.etag === state.loaded.etag) return { ...state, loaded: current };
  const moved = movedCards(state.loaded, current, dirtyCards(state));
  if (moved.length === 0) return { ...state, loaded: current };
  return { ...state, conflict: { view: current, cards: moved } };
}

/**
 * Adopt a `200` from a save of exactly `cards`, carrying `submitted` as sent.
 *
 * A saved card goes clean only if its draft still holds the text that was actually sent. An
 * operator who kept typing while the PUT was in flight keeps their newer text and keeps the
 * card dirty - the generation check `reconcileForemanProfileMutation` performs, expressed
 * against the submitted value rather than a counter because the value is the exact fact.
 *
 * Every OTHER card's draft survives untouched, which is the visible half of the rule that
 * a save sends one repository. The baseline advances for all of them, so Revert on a
 * neighbour now restores what is genuinely stored rather than a snapshot taken before this
 * save happened.
 */
export function reconcileSaved(
  state: StandingInstructionsDraftState,
  saved: StandingInstructionsView,
  submitted: Record<string, string | null>,
): StandingInstructionsDraftState {
  const drafts = { ...state.drafts };
  for (const [card, sent] of Object.entries(submitted)) {
    // A removal (`null`) always goes clean: there is no submitted text to still be holding,
    // and the card is back to inheriting.
    if (sent === null || drafts[card] === sent) delete drafts[card];
  }
  return { ...state, loaded: saved, drafts, conflict: null };
}

/** Keep my text, on top of the newer document. The card stays dirty and is now a decision. */
export function keepMine(state: StandingInstructionsDraftState): StandingInstructionsDraftState {
  if (!state.conflict) return state;
  return { ...state, loaded: state.conflict.view, conflict: null };
}

/** Take theirs: drop only the drafts that were actually in conflict. */
export function takeTheirs(state: StandingInstructionsDraftState): StandingInstructionsDraftState {
  if (!state.conflict) return state;
  const drafts = { ...state.drafts };
  for (const card of state.conflict.cards) delete drafts[card];
  return { ...state, loaded: state.conflict.view, drafts, conflict: null };
}
