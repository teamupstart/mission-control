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
  /**
   * The question or decision this choice belongs to.
   *
   * One form can ask several questions, and their option lists are flattened into a single
   * list of choices before matching. Without the grouping, two questions that both offer
   * "Yes" are indistinguishable to a matcher reading one blob of prose. Omit it only for a
   * form that asks exactly one question.
   */
  group?: string;
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

/**
 * The transcript entries to draw while the open form already owns this note.
 *
 * The console shows Foreman's turn inline at the point it spoke. When the ask it is about is
 * still open on the same screen, that turn is the same voice a second time, which is the
 * crowding this disclosure exists to remove - so the live entry yields and the recommendation
 * control speaks for it. Only THIS note's entry goes; the rest of the history stays, and the
 * complete episode remains in Foreman history.
 *
 * Equality is safe because both sides are the same string by construction: `classifyPending`
 * mints a marker per waiting episode and the worker stamps that very marker as the note's
 * `handledMarker` for its own idempotency, which is what makes `(note_key, marker)` unique in
 * `foreman_episodes`. Pinned in the tests so a drift in either spelling fails loudly rather
 * than turning this filter into a silent no-op.
 *
 * Exactly ONE entry yields, and it is the newest carrying that marker. The marker digests the
 * dialog's content and nothing instance-unique, so a question asked twice in one session
 * produces two episodes with the same marker - and hiding by marker alone would take the
 * older, already-answered turn out of the history along with the live one.
 */
export function visibleForemanEpisodes<T extends { marker: string; id: number }>(
  episodes: T[],
  o: { companionsOpenAsk: boolean; handledMarker: string | null | undefined },
): T[] {
  // Returned as-is rather than copied when nothing is hidden, which is the overwhelmingly
  // common case: a fresh array on every render would hand the transcript a new identity each
  // tick for no change in content.
  if (!o.companionsOpenAsk || !o.handledMarker) return episodes;
  let live: T | undefined;
  for (const episode of episodes) {
    if (episode.marker === o.handledMarker && (!live || episode.id > live.id)) live = episode;
  }
  if (!live) return episodes;
  return episodes.filter((episode) => episode !== live);
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

/** Escape a label so its own punctuation cannot become regex syntax. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Whether the prose NAMES this label, rather than merely containing its letters.
 *
 * A bare substring test paints a pick out of coincidence: "Go" occurs inside "ongoing", "No"
 * inside "nothing", "Test" inside "testing". Short option labels are common, so this is not a
 * hypothetical - and a mark that means "Foreman chose this" must never come from a spelling
 * accident inside an unrelated word.
 *
 * The boundary is asserted only on a side whose own edge character is alphanumeric. A label
 * like "+ add a step" or "(none)" has punctuation at that edge, and demanding a non-word
 * character beyond it would reject the very sentence that does name it.
 */
function occurrences(prose: string, label: string): Array<[number, number]> {
  if (!label) return [];
  const before = ALPHANUMERIC.test(label[0]!) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = ALPHANUMERIC.test(label[label.length - 1]!) ? "(?![\\p{L}\\p{N}])" : "";
  const pattern = new RegExp(`${before}${escapeRegExp(label)}${after}`, "gu");
  const spans: Array<[number, number]> = [];
  for (const match of prose.matchAll(pattern)) {
    spans.push([match.index, match.index + label.length]);
  }
  return spans;
}

function namesLabel(prose: string, label: string): boolean {
  return occurrences(prose, label).length > 0;
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

  const spellings = choices.map((choice) => ({ choice, labels: labelsForMatch(choice.label) }));

  // Which questions each SPELLING could have come from.
  //
  // A form can ask several questions at once and their options arrive here flattened, so the
  // same wording can belong to two of them - two plain yes/no questions being the obvious
  // case. Prose naming that wording once cannot say which question it meant, and marking both
  // would claim Foreman answered a question it never addressed.
  //
  // Keyed on every spelling rather than on the raw label, because a choice is matchable by
  // more than one: "Deploy now (Recommended)" is also matched as "Deploy now". Keying on raw
  // labels makes that pair look like two distinct, unambiguous options while both are in fact
  // reachable by the single phrase "Deploy now" - so the collision has to be checked against
  // the text that actually does the matching. Ambiguity resolves to NO mark, the same rule
  // the rest of this matcher follows; the sidecar still carries the full reasoning either way.
  const groupsForText = new Map<string, Set<string>>();
  for (const { choice, labels } of spellings) {
    for (const label of labels) {
      const groups = groupsForText.get(label) ?? new Set<string>();
      groups.add(choice.group ?? "");
      groupsForText.set(label, groups);
    }
  }

  // The text that actually matched, per choice, keeping the longest when a choice offers a
  // hinted and unhinted spelling of itself. Ambiguous spellings are dropped individually, so
  // a choice whose hinted spelling is unique is still attributable even when its unhinted one
  // collides with a sibling question.
  const hits = new Map<string, string>();
  for (const { choice, labels } of spellings) {
    const [longest] = labels
      .filter((label) => (groupsForText.get(label)?.size ?? 1) === 1 && namesLabel(prose, label))
      .sort((a, b) => b.length - a.length);
    if (longest) hits.set(choice.key, longest);
  }

  // One label containing another is enough to match both: prose naming "Merge now and notify
  // the team" also names "Merge now", and the boundary after it is a space either way. The
  // shorter one is spurious there - it was never named in its own right, it was read out of
  // the middle of the longer phrase.
  //
  // Decided by WHERE the text occurs, not by which choices matched. A shorter hit is dropped
  // only when EVERY one of its occurrences sits inside an occurrence of a longer hit. If the
  // prose names it anywhere else, it was named, and it keeps its mark.
  //
  // That is why this deliberately does not check `group`, which would be the obvious way to
  // express "mutually exclusive rows". Scoping to one question would restore the mark whenever
  // the two labels live on different questions - including when the shorter one appears only
  // inside the longer one's phrase, which is a FALSE pick, and this matcher's whole contract
  // is that it never paints one. Occurrence coverage gets both cases right without the
  // grouping: two decisions that genuinely name their own options each keep their mark,
  // because each has an occurrence the other's phrase does not cover.
  const texts = [...hits.values()];
  const matched = new Set<string>();
  for (const [key, text] of hits) {
    const mine = occurrences(prose, text);
    const swallowed = mine.every(([start, end]) =>
      texts.some(
        (other) =>
          other.length > text.length &&
          occurrences(prose, other).some(([from, to]) => from <= start && end <= to),
      ),
    );
    if (mine.length > 0 && swallowed) continue;
    matched.add(key);
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

