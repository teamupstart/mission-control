import { noteAwaitsYou } from "@shared/foreman.ts";
import { dialogMarker } from "@shared/session.ts";
import type { PaneDialog, ReviewItem, SessionNoteSummary } from "@shared/types.ts";

/** A choice from either a pane dialog or a durable review decision. */
export interface RecommendationChoice {
  /** Stable only inside the form that owns this choice. */
  key: string;
  label: string;
  detail?: string;
  /** Pane menus number their choices. Durable review decisions do not. */
  number?: number;
}

/** A live Foreman note only; answered and skipped notes belong to history. */
function liveNote(note: SessionNoteSummary | null | undefined): SessionNoteSummary | null {
  return note && noteAwaitsYou(note.disposition) ? note : null;
}

/** The optional Foreman context for this exact pane or driver dialog. */
export function foremanNoteForDialog(
  dialog: PaneDialog,
  note: SessionNoteSummary | null | undefined,
): SessionNoteSummary | null {
  const live = liveNote(note);
  return live?.handledMarker === dialogMarker(dialog) ? live : null;
}

/** The optional Foreman context for this exact durable review. */
export function foremanNoteForReview(
  review: Pick<ReviewItem, "id">,
  note: SessionNoteSummary | null | undefined,
): SessionNoteSummary | null {
  const live = liveNote(note);
  return live?.handledMarker === `review:${review.id}` ? live : null;
}

/**
 * Whether the canonical ask should replace the separate Foreman prompt.
 *
 * Marker equality is the safety boundary. A note about some other stalled state remains a
 * decision in its own right even while this session happens to be showing a menu.
 */
export function foremanNoteCompanionsOpenAsk(o: {
  dialog: PaneDialog | null;
  note: SessionNoteSummary | null | undefined;
  pendingReviewIds?: ReadonlySet<string>;
}): boolean {
  const live = liveNote(o.note);
  if (!live) return false;
  if (o.dialog && live.handledMarker === dialogMarker(o.dialog)) return true;
  if (!live.handledMarker?.startsWith("review:")) return false;
  const reviewId = live.handledMarker.slice("review:".length);
  return o.pendingReviewIds?.has(reviewId) ?? false;
}

/** Fold typography without changing the meaningful words in an option label. */
function folded(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parenthetical hints are presentation, and Foreman does not always repeat them. */
function labelsForMatch(label: string): string[] {
  const full = folded(label);
  const withoutHint = full.replace(/\s*\((?:recommended|default)\)\s*$/i, "").trim();
  return withoutHint && withoutHint !== full ? [full, withoutHint] : [full];
}

/**
 * Which offered choices Foreman's prose actually names.
 *
 * Labels are the primary contract: Foreman's prompt tells it to repeat them exactly. A
 * numbered fallback is accepted only when the form has one unambiguous numbered list and
 * the prose explicitly says "option N" or "choice N". Nothing is guessed from semantic
 * similarity; an uncertain match means the sidecar still shows the recommendation and no
 * option receives a false Foreman mark.
 */
export function recommendedChoiceKeys(
  recommendation: string | null | undefined,
  choices: readonly RecommendationChoice[],
): ReadonlySet<string> {
  if (!recommendation?.trim()) return new Set();
  const prose = folded(recommendation);
  const matched = new Set<string>();
  for (const choice of choices) {
    if (labelsForMatch(choice.label).some((label) => label.length > 0 && prose.includes(label))) {
      matched.add(choice.key);
    }
  }
  if (matched.size > 0) return matched;

  const numbered = choices.filter((choice) => choice.number !== undefined);
  const uniqueNumbers = new Set(numbered.map((choice) => choice.number));
  if (numbered.length === 0 || uniqueNumbers.size !== numbered.length) return matched;
  for (const choice of numbered) {
    const number = choice.number!;
    if (new RegExp(`\\b(?:option|choice)\\s*#?\\s*${number}\\b`, "i").test(prose)) {
      matched.add(choice.key);
    }
  }
  return matched;
}

