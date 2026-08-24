import { useCallback, useEffect, useRef, useState } from "react";
import type { StandingInstructionsUpdate, StandingInstructionsView } from "@shared/protocol.ts";
import {
  fetchStandingInstructions,
  resolveRepo,
  saveStandingInstructions,
} from "./lib/api.ts";
import { readIsCurrent } from "./harnesses-reconcile.ts";
import {
  DEFAULT_CARD,
  cardsOf,
  dirtyCards,
  draftValue,
  isDirty,
  isOverride,
  keepMine,
  reconcileRefresh,
  reconcileSaved,
  storedValue,
  takeTheirs,
  type StandingInstructionsDraftState,
} from "./standing-instructions-reconcile.ts";

// The "Standing instructions" settings category: the operator's own words, per repository,
// sent to every session Mission Control opens into that checkout.
//
// Polled rather than streamed, for the reason every other config hook here is polled -
// `useTaskSources.ts:11-14` states it: coarse, rarely-edited chrome, not worth another SSE
// channel. Gated on the category being on screen, the way `useConductor` and `useWorktrees`
// are, so opening an unrelated Settings destination does not poll this one.
//
// The decisions worth testing are NOT in this file. They are pure functions in
// `standing-instructions-reconcile.ts`, which is where the poll-versus-draft rule that makes
// this panel safe is written down and pinned.

const POLL_MS = 4000;

export interface StandingInstructionsCard {
  /** The repository key, or `DEFAULT_CARD` for the machine-wide box. */
  key: string;
  /** What the textarea shows right now. */
  value: string;
  /** An unsaved change is pending on this card. */
  dirty: boolean;
  /** This repository carries its own text rather than inheriting the default. */
  override: boolean;
  /** The daemon's newer text for this card, while it is in conflict. */
  theirs: string | null;
}

export interface StandingInstructionsState {
  view: StandingInstructionsView | null;
  /** Every card to draw: the default first, then repositories in stored order. */
  cards: StandingInstructionsCard[];
  /** Type into one card. Never reaches the daemon on its own. */
  edit: (card: string, text: string) => void;
  /** Persist exactly this one card. */
  save: (card: string) => Promise<boolean>;
  /** Throw this card's unsaved text away and show what is stored. */
  revert: (card: string) => void;
  /** Remove this repository's override so it inherits the machine-wide default. */
  useGlobalDefault: (card: string) => Promise<boolean>;
  /** Stage a repository the operator picked, so a card appears for it. */
  addRepository: (path: string) => Promise<string | null>;
  /** Which cards the daemon moved underneath an edit, or null. */
  conflictCards: string[];
  keepMine: () => void;
  takeTheirs: () => void;
  /** The card mid-save, so its buttons can say so. */
  saving: string | null;
  error: string | null;
}

/** Flatten a refusal to one sentence, the way `useTaskSources`' `whyItFailed` does. */
function whyItFailed(error: string): string {
  const flat = error.replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick.";
  return `That change didn't stick: ${flat.length > 120 ? `${flat.slice(0, 119)}…` : flat}`;
}

export function useStandingInstructions(active: boolean): StandingInstructionsState {
  const [state, setStateRaw] = useState<StandingInstructionsDraftState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // The draft state as last set, readable without making every callback depend on it -
  // which would rebuild all of them on each poll. Same role as `useTaskSources`' `viewRef`.
  const stateRef = useRef<StandingInstructionsDraftState | null>(null);
  /**
   * How many writes have LANDED. A read that left before the newest one describes an older
   * daemon than the client has already been told about, and applying it would put the
   * pre-write document back as the baseline - the poll-versus-confirming-read race
   * `useTaskSources.ts:62-72` records.
   *
   * There is no `editSeq` counterpart here, and its absence is the point. In that hook a
   * response could clobber an edit because the view and the edit were the same object. Here
   * a draft is structurally separate from `loaded` and NOTHING in `reconcileRefresh` writes
   * one, so a poll landing mid-edit cannot revert typed text however long the operator sits
   * in the box. The counter is only guarding which BASELINE wins.
   */
  const writeGen = useRef(0);

  const setState = useCallback((next: StandingInstructionsDraftState | null): void => {
    stateRef.current = next;
    setStateRaw(next);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const genAtRequest = writeGen.current;
    const view = await fetchStandingInstructions();
    if (!view) return;
    if (!readIsCurrent(genAtRequest, writeGen.current)) return;
    const before = stateRef.current;
    setState(
      before
        ? reconcileRefresh(before, view)
        : { loaded: view, drafts: {}, staged: [], conflict: null },
    );
  }, [setState]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      if (alive) await refresh();
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, refresh]);

  const edit = useCallback(
    (card: string, text: string): void => {
      const before = stateRef.current;
      if (!before) return;
      setState({ ...before, drafts: { ...before.drafts, [card]: text } });
    },
    [setState],
  );

  const revert = useCallback(
    (card: string): void => {
      const before = stateRef.current;
      if (!before) return;
      const drafts = { ...before.drafts };
      delete drafts[card];
      setState({ ...before, drafts });
    },
    [setState],
  );

  /**
   * Send ONE card's value, and nothing else.
   *
   * The whole draft map is never sent. Sending every repository's draft while saving one of
   * them persists every OTHER repository's in-progress text as though the operator had
   * committed to it - nothing in the panel would say so, Revert on those cards would then
   * restore text that was silently written rather than text that was last chosen, and the
   * next session dispatched into one of them would receive an instruction nobody meant to
   * save. A standing instruction is a rule an agent obeys; writing one the operator did not
   * commit to is the worst failure this panel has.
   *
   * `retried` bounds the one automatic retry below to a single attempt.
   */
  const submit = useCallback(
    async (card: string, value: string | null, retried = false): Promise<boolean> => {
      const before = stateRef.current;
      if (!before) return false;
      const update: StandingInstructionsUpdate = card === DEFAULT_CARD
        ? { expectedEtag: before.loaded.etag, default: value ?? "" }
        : { expectedEtag: before.loaded.etag, repositories: { [card]: value } };
      const submitted = { [card]: value };

      setSaving(card);
      const res = await saveStandingInstructions(update);
      setSaving(null);

      if (res.ok) {
        // The daemon has moved, so any read already in flight describes an older one.
        writeGen.current += 1;
        const now = stateRef.current ?? before;
        setState(reconcileSaved(now, res.view, submitted));
        setError(null);
        return true;
      }
      if ("conflict" in res) {
        // NOT because this write landed - it did not, and the daemon performed none. The
        // client's picture of the SERVER has still moved forward, so a poll that left before
        // this refusal is now describing an older document and must not be allowed to drag
        // the baseline back over the newer one adopted just below.
        writeGen.current += 1;
        const now = stateRef.current ?? before;
        // Run the SAME reconcile a poll runs. If the card this save was about did not move,
        // the document only changed under some OTHER repository - and because this patch
        // carries one key, that cannot make this save wrong. Adopt the newer ETag and try
        // once more, rather than making a neighbour's edit into a conflict the operator has
        // to clear before they can save a card nobody else touched.
        const reconciled = reconcileRefresh(now, res.conflict);
        setState(reconciled);
        if (!reconciled.conflict && !retried) return submit(card, value, true);
        if (reconciled.conflict) return false;
        setError(whyItFailed("standing instructions changed in another window"));
        return false;
      }
      setError(whyItFailed(res.error));
      return false;
    },
    [setState],
  );

  const save = useCallback(
    async (card: string): Promise<boolean> => {
      const before = stateRef.current;
      if (!before) return false;
      return submit(card, draftValue(before, card));
    },
    [submit],
  );

  const useGlobalDefault = useCallback(
    async (card: string): Promise<boolean> => {
      if (card === DEFAULT_CARD) return false;
      // `null` is the removal spelling. `""` is a real value meaning "send nothing for this
      // repository", which still beats the machine-wide default - so clearing the box and
      // pressing this button are two different gestures with two different outcomes.
      return submit(card, null);
    },
    [submit],
  );

  /**
   * Stage a repository the operator picked from the combobox.
   *
   * Resolved server-side before it can become a card, so a typo cannot enter the panel as a
   * silently inert entry. `resolved.path` and NOT `resolved.repoRoot`: a subdirectory is a
   * legitimate key here, and reading the root would collapse `mono/packages/api` to `mono`
   * before the operator ever pressed Save - which both overwrites the monorepo's rule and
   * makes the longest-match behaviour the store advertises impossible to configure.
   */
  const addRepository = useCallback(
    async (path: string): Promise<string | null> => {
      const trimmed = path.trim();
      if (!trimmed) return "type or pick a repository path";
      const resolved = await resolveRepo(trimmed);
      if (!resolved.ok) return resolved.error;
      const before = stateRef.current;
      if (!before) return "the daemon has not answered yet";
      const key = resolved.path;
      if (cardsOf(before).includes(key)) return null;
      setState({ ...before, staged: [...before.staged, key] });
      return null;
    },
    [setState],
  );

  const cards: StandingInstructionsCard[] = state
    ? [DEFAULT_CARD, ...cardsOf(state)].map((key) => ({
      key,
      value: draftValue(state, key),
      dirty: isDirty(state, key),
      override: isOverride(state.loaded, key),
      theirs: state.conflict?.cards.includes(key)
        ? storedValue(state.conflict.view, key)
        : null,
    }))
    : [];

  return {
    view: state?.loaded ?? null,
    cards,
    edit,
    save,
    revert,
    useGlobalDefault,
    addRepository,
    conflictCards: state?.conflict?.cards ?? [],
    keepMine: () => {
      const before = stateRef.current;
      if (before) setState(keepMine(before));
    },
    takeTheirs: () => {
      const before = stateRef.current;
      if (before) setState(takeTheirs(before));
    },
    saving,
    error,
  };
}

export { DEFAULT_CARD, dirtyCards };
