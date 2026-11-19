import type { ReviewItem } from "@shared/types.ts";

/**
 * Is `newer` the same decision as `older`, asked again in different words?
 *
 * An agent whose blocking `request_input` call timed out reissues the decision, usually
 * reworded, and usually saying so ("The previous prompt timed out..."). Not always: it can also
 * just rephrase. So there are two ways to qualify, and one way to be disqualified whatever the
 * wording says:
 *
 * - ANNOUNCED retry (`RETRY_ANNOUNCEMENT`): the newer ask says it is one, and shares at least
 *   `ANNOUNCED_RETRY_MIN_OVERLAP` of its words with the older. An announcement alone is not
 *   enough, because an agent can mention that an earlier question timed out and then ask about
 *   something else entirely.
 * - UNANNOUNCED rewording: no announcement, so the wording has to carry the whole case, at
 *   `REWORDED_MIN_OVERLAP`. Below that, a similar question is as likely a follow-up as a retry.
 * - DISQUALIFIED either way when the newer ask swaps what the older one is about. Two such asks
 *   share nearly every word and are still two decisions the operator owes separate answers:
 *   - a labelled number moves (`changedIdentifiers`): "Phase 1" to "Phase 2", PR #101 to #102;
 *   - a name is substituted (`substitutedNames`): "grant Alice access" to "grant Bob access";
 *   - a few words are swapped for others inside otherwise identical wording (`swappedWord`),
 *     which is how a lower-case subject changes: "grant alice access" to "grant bob access", or
 *     to "grant bob temporary access";
 *   - the question, once any retry announcement is set aside, was edited in one place
 *     (`editedQuestion`): one subject substituted, however short ("Grant alice access?" to "The
 *     earlier request timed out. Grant bob access?"), or wording added or removed ("Should I
 *     deploy to production?" to "...deploy to production and delete the database?");
 *   - the context, the background beneath the question, was edited in one place the same way
 *     (`editedContext`): "Should I ship?" over "Deploy to staging." then over "Deploy to
 *     production.";
 *   - the question (not its context or its retry announcement) gains, loses or moves a negation
 *     (`changedNegation`): "Should I
 *     grant alice access" to "Should I not grant alice access" reverses what an approval means;
 *   - the choices change at all (`changedChoices`): any option's label or detail, or how many
 *     options there are. Only the question may be reworded.
 *
 * An unannounced paraphrase below `REWORDED_MIN_OVERLAP` ("Which linter should this repository
 * use?" then "Choose a linting tool for this project") deliberately keeps both cards; the
 * operator accepted that edge when choosing wording matching for issue #1527. Wording alone
 * cannot tell it from a different question - Alice and Bob share far more of theirs - and a
 * card withdrawn wrongly is a question the operator never sees again, while a card kept wrongly
 * is one extra answer. The `request_input` description asks an agent that re-asks to say so,
 * and the same paraphrase with that announcement is matched.
 *
 * Calibrated on every `request_input` ask in the live database (about 250) in November 2026.
 * Every announced retry was a real one, with overlap between 0.56 and 0.88 and no changed
 * number or name. Every unannounced pair at 0.8 or above was the same decision re-asked, except
 * two phase-numbered requests ("Please review Phase 1 PR" then "Phase 2 PR", 0.95), which the
 * number check separates. The name check flags one real pair, two diagnostic asks that swapped
 * "Other" for "Notification Center" - keeping both is the safe way to be wrong. The swapped-word
 * check, at `SWAP_CONTEXT_WORDS`, flags no real retry; at two words of context it flagged three,
 * because rewording swaps synonyms ("preserve" for "keep") inside shared phrases.
 */
export function isRewordedRetry(older: ReviewItem, newer: ReviewItem): boolean {
  const before = askText(older);
  const after = askText(newer);
  const announced = RETRY_ANNOUNCEMENT.test(newer.body);
  if (
    changedIdentifiers(before, after) ||
    substitutedNames(older, newer) ||
    swappedWord(before, after) ||
    changedNegation(decisionText(older), decisionText(newer)) ||
    editedQuestion(older, newer) ||
    editedContext(older, newer) ||
    changedChoices(older, newer)
  ) {
    return false;
  }
  const overlap = wordOverlap(before, after);
  return announced ? overlap >= ANNOUNCED_RETRY_MIN_OVERLAP : overlap >= REWORDED_MIN_OVERLAP;
}

/**
 * How agents announce a retry, from the asks that did: "The previous prompt timed out", "the
 * earlier request timed out", "The restart interrupted the pending contract choice", "The
 * capability decision is still unresolved".
 */
const RETRY_ANNOUNCEMENT =
  /\b(?:timed?[ -]?out|interrupted|(?:earlier|previous|prior|last)\s+(?:\w+\s+){0,2}?(?:request|prompt|question|ask|choice|decision)s?|still\s+(?:unresolved|unanswered)|re-?ask(?:ed|ing)?|ask(?:ed|ing)?\s+(?:this\s+|it\s+)?again)\b/i;

/** Lowest real announced retry measured 0.56; the margin below it is deliberate. */
export const ANNOUNCED_RETRY_MIN_OVERLAP = 0.35;

/** With no announcement, only a near-restatement counts. */
export const REWORDED_MIN_OVERLAP = 0.8;

const STOPWORDS = new Set(
  ("the and for that this with you your are was were has have had not but can should would will " +
    "from into what which when then than they them their its our out all any one two may there " +
    "here about only also just more most some such each been being does did doing over under very")
    .split(" "),
);

/** Everything the operator reads on the card: question and context, then each option. */
function askText(review: ReviewItem): string {
  const options = (review.decisions ?? []).flatMap((d) => d.options.map((o) => `${o.label} ${o.detail ?? ""}`));
  return [review.body, ...options].join(" ");
}

function contentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

/**
 * Shared words over the smaller ask's words. Over the SMALLER rather than the union, because a
 * retry is usually a shortened version ("I'll reissue a shorter version"), and the union would
 * count every word the agent dropped against it.
 */
function wordOverlap(a: string, b: string): number {
  return setOverlap(contentWords(a), contentWords(b));
}

function setOverlap(left: Set<string>, right: Set<string>): number {
  const smaller = Math.min(left.size, right.size);
  if (smaller === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / smaller;
}

/**
 * The numbers an ask names, keyed by what they number: "phase 1", "pull 101", "revision 16",
 * "#1264". These are what tells two otherwise identical asks apart, and they are exactly what
 * `contentWords` cannot see, since it drops every token shorter than three characters.
 */
function labelledNumbers(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (label: string, value: string) => {
    let values = out.get(label);
    if (!values) out.set(label, (values = new Set()));
    values.add(value);
  };
  for (const m of text.toLowerCase().matchAll(/(\p{L}+)[\s/:-]+#?(\d+(?:\.\d+)*)\b|#(\d+)\b/gu)) {
    if (m[3] !== undefined) add("#", m[3]);
    else add(m[1]!, m[2]!);
  }
  return out;
}

/**
 * Does `after` name, under a label `before` also numbers, a value `before` never named?
 *
 * A number that only one side mentions is not a change: a shortened retry drops details, and a
 * fuller one adds them. Only a label both sides number, with a new value on the newer side,
 * says the ask is about a different thing.
 */
function changedIdentifiers(before: string, after: string): boolean {
  const older = labelledNumbers(before);
  for (const [label, values] of labelledNumbers(after)) {
    const known = older.get(label);
    if (!known) continue;
    for (const value of values) if (!known.has(value)) return true;
  }
  return false;
}

/** The pieces of an ask that each start a sentence of their own: the body, then every option. */
function askSegments(review: ReviewItem): string[] {
  return [
    review.body,
    ...(review.decisions ?? []).flatMap((d) => d.options.flatMap((o) => [o.label, o.detail ?? ""])),
  ];
}

/** What starts a sentence or a list item: a capital after one of these is grammar, not a name. */
const SENTENCE_START = /(?:^|[.!?:;\n]|\n\s*(?:[-*\u2022]|\d+[.)]))\s*["'\u201c(]?$/u;

/**
 * The names an ask uses: words capitalised in mid-sentence ("grant Alice access", "the Codex
 * overlay"), lower-cased. Single letters are dropped, which keeps the pronoun "I" out.
 */
function names(review: ReviewItem): Set<string> {
  const out = new Set<string>();
  for (const segment of askSegments(review)) {
    for (const m of segment.matchAll(/(^|[^\p{L}\p{N}])(\p{Lu}\p{L}*)/gu)) {
      if (m[2]!.length < 2) continue;
      if (SENTENCE_START.test(segment.slice(0, m.index + m[1]!.length))) continue;
      out.add(m[2]!.toLowerCase());
    }
  }
  return out;
}

function everyWord(review: ReviewItem): Set<string> {
  return new Set(askSegments(review).join(" ").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/**
 * Did `newer` swap one of `older`'s names for one of its own?
 *
 * Both halves are required. A retry that drops a name ("Claude 2.1.310 and Codex 0.160.0" becomes
 * "both harnesses") or adds one is still restating; only a name that left AND a name that
 * arrived says the subject changed.
 */
function substitutedNames(older: ReviewItem, newer: ReviewItem): boolean {
  const olderWords = everyWord(older);
  const newerWords = everyWord(newer);
  const left = [...names(older)].some((name) => !newerWords.has(name));
  const arrived = [...names(newer)].some((name) => !olderWords.has(name));
  return left && arrived;
}

/**
 * One option as the operator reads it: its label and detail, lower-cased, punctuation dropped,
 * and without the "(Recommended)" marker an agent may add or drop between asks.
 */
function choice(label: string, detail: string | undefined): string {
  const words = (text: string) => text.toLowerCase().replace(/\(recommended\)/g, " ").match(/[\p{L}\p{N}]+/gu) ?? [];
  return `${words(label).join(" ")}\n${words(detail ?? "").join(" ")}`;
}

function choices(review: ReviewItem): string[] {
  return (review.decisions ?? []).flatMap((d) => d.options.map((o) => choice(o.label, o.detail)));
}

/**
 * Do the two asks offer different choices? Any difference at all, in any option's label or
 * detail, counts.
 *
 * The options are what the operator is choosing between, so withdrawing a card whose choices
 * differ from its retry's would hide a decision the operator still owes. Review rounds kept
 * finding rewordings that changed what a choice does while keeping most of its words - "Ship:
 * deploy to staging" became "Ship: roll out to production" - and no wording threshold told those
 * apart from a retry merely restating its options. So the operator chose identical choices: only
 * the question may be reworded, and only case, punctuation and "(Recommended)" are ignored in the
 * options.
 *
 * The cost is stated plainly. Every real retry in the live database reworded at least one
 * option's detail, so a retry that rewords its options keeps both cards. The `request_input`
 * description asks an agent that re-asks to offer the same options, which is what collapses it.
 */
function changedChoices(older: ReviewItem, newer: ReviewItem): boolean {
  const a = choices(older);
  const b = choices(newer);
  return a.length !== b.length || a.some((option, index) => option !== b[index]);
}

/**
 * The most words the longer side of a swap may have. One side is always exactly one word: a
 * subject replaced, perhaps with a qualifier ("alice" to "bob temporary"). Two words for two
 * ("the old link" to "an existing link") is how a retry rewords, and flagging it blocked a real
 * retry.
 */
export const MAX_SWAP_WORDS = 3;

/**
 * How many identical words must stand on EACH side of a replacement for it to count as a changed
 * subject. "Should I grant [alice] access to the production repository" has three before
 * and many after. A reworded retry replaces words too, but inside phrases it has also reworded:
 * at two words of context, three of the six real retries were wrongly flagged; at three, none.
 */
export const SWAP_CONTEXT_WORDS = 3;

/** Bounds the word diff below. Asks are capped at a few thousand characters anyway. */
const MAX_DIFF_WORDS = 1_500;

/**
 * Did `after` replace one of `before`'s words with up to `MAX_SWAP_WORDS` others, or up to that
 * many with one, inside at least `SWAP_CONTEXT_WORDS` identical words on each side?
 *
 * "alice" to "bob" and "alice" to "bob temporary" are both a subject replaced. The word-level
 * diff is a longest common subsequence, so wording the newer ask added or dropped elsewhere does
 * not hide the replacement. Each side must hold a content word: a swap of stopwords ("the" for
 * "this") is phrasing, and a pure insertion ("temporary" added, nothing removed) changes no
 * subject.
 */
function swappedWord(before: string, after: string): boolean {
  const a = (before.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_DIFF_WORDS);
  const b = (after.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_DIFF_WORDS);
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  // Walk the diff, collecting each run of differences as one hunk.
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const startA = i;
    const startB = j;
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) j++;
      else i++;
    }
    const removed = a.slice(startA, i);
    const added = b.slice(startB, j);
    if (Math.min(removed.length, added.length) !== 1) continue;
    if (Math.max(removed.length, added.length) > MAX_SWAP_WORDS) continue;
    const content = (w: string) => !STOPWORDS.has(w);
    if (!removed.some(content) || !added.some(content)) continue;
    if (matchingRun(a, b, startA - 1, startB - 1, -1) && matchingRun(a, b, i, j, 1)) return true;
  }
  return false;
}

/** Are there `SWAP_CONTEXT_WORDS` identical words starting at (i, j), stepping by `step`? */
function matchingRun(a: string[], b: string[], i: number, j: number, step: 1 | -1): boolean {
  for (let k = 0; k < SWAP_CONTEXT_WORDS; k++, i += step, j += step) {
    if (i < 0 || j < 0 || i >= a.length || j >= b.length || a[i] !== b[j]) return false;
  }
  return true;
}

/**
 * Words that reverse what a question asks. "not" is also a stopword, which is exactly why it
 * needs its own check: word overlap ignores it, and the word-swap check ignores insertions.
 */
const NEGATIONS = new Set(["not", "no", "never", "nor", "cannot"]);

/** Negative contractions as agents also write them, without an apostrophe. */
const BARE_CONTRACTIONS = new Set([
  "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "wont", "cant", "couldnt",
  "shouldnt", "wouldnt", "mustnt", "neednt", "hasnt", "havent", "hadnt", "shant",
]);

const isNegation = (w: string) => NEGATIONS.has(w) || BARE_CONTRACTIONS.has(w) || /n['\u2019]t$/u.test(w);

/**
 * A text split into its negations and everything else: `words` is the text with every negation
 * removed, and `at` says where each negation stood, as the number of other words before it.
 */
function negations(text: string): { words: string[]; at: number[] } {
  const words: string[] = [];
  const at: number[] = [];
  for (const w of text.toLowerCase().match(/\p{L}+(?:['\u2019]\p{L}+)?|\p{N}+/gu) ?? []) {
    if (isNegation(w)) at.push(words.length);
    else words.push(w);
  }
  return { words, at };
}

/**
 * The question itself, without its context: the decision's own question, or the body's leading
 * paragraph for a free-text ask (`inputReviewBody` puts the context after a blank line).
 */
function questionText(review: ReviewItem): string {
  return review.decisions?.[0]?.question ?? review.body.split(/\n\s*\n/)[0] ?? "";
}

/**
 * Did the question gain, lose or move a negation?
 *
 * Gained or lost: the counts differ. Moved: the questions are word for word the same once their
 * negations are removed, but a negation stands somewhere else - "Should I not deploy to staging
 * and deploy to production?" then "Should I deploy to staging and not deploy to production?"
 * reverses both actions with the same words. A question reworded around a negation ("cannot
 * atomically replace a path" became "cannot atomically compare an inode") is left to the other
 * checks: comparing what each negation governs flagged two real retries.
 *
 * Read over the question only. Its context is background a retry restates freely, and real
 * retries flip negations there without changing the decision ("neither Claude nor Codex
 * enforces it" became "both admit project skills").
 */
function changedNegation(before: string, after: string): boolean {
  const a = negations(before);
  const b = negations(after);
  if (a.at.length !== b.at.length) return true;
  if (a.words.join(" ") !== b.words.join(" ")) return false;
  return a.at.some((position, index) => position !== b.at[index]);
}

/**
 * The decision being asked: the question with any sentence that only announces a retry set aside
 * ("The previous prompt was not answered." is about the last call, not this decision).
 */
function decisionText(review: ReviewItem): string {
  return questionText(review)
    .split(/(?<=[.!?;])\s+/)
    .filter((sentence) => !RETRY_ANNOUNCEMENT.test(sentence))
    .join(" ");
}

function decisionWords(review: ReviewItem): string[] {
  return decisionText(review).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Was the question edited in exactly one place, in a way that changes what is being decided?
 *
 * Compared whole, after setting aside a retry announcement, so the common start and end of the two
 * questions are the context and no surrounding wording is needed. One run of difference counts
 * when it holds a content word and is either:
 *
 * - a substitution of one word by up to `MAX_SWAP_WORDS`, or that many by one: "Grant alice
 *   access?" to "Grant bob access?", which shares every other word and clears every overlap
 *   threshold with the same Approve/Deny options;
 * - a pure insertion or deletion: "Should I deploy to production?" to "Should I deploy to
 *   production and delete the database?", where approving the newer one authorizes more.
 *
 * A retry that rewords its question changes it in more than one place, or replaces a long run
 * with a different one ("Claude 2.1.310 and Codex 0.160.0 both" became "both harnesses"), and is
 * not flagged. Where this is unsure it keeps both cards: adding even "now" to a question is
 * treated as a different decision.
 */
function editedQuestion(older: ReviewItem, newer: ReviewItem): boolean {
  const before = decisionWords(older);
  const after = decisionWords(newer);
  return editedInOnePlace(before, after) || onlySmallEdits(before, after);
}

/** The context beneath the question: the body after its leading paragraph (`inputReviewBody`). */
function contextWords(review: ReviewItem): string[] {
  const body = review.body;
  const question = review.decisions?.[0]?.question;
  const context = question !== undefined && body.startsWith(question)
    ? body.slice(question.length)
    : body.split(/\n\s*\n/).slice(1).join("\n\n");
  return context.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Was the context edited in exactly one place, the way `editedQuestion` reads a question? A
 * retry restates its background freely, rewriting it in several places, and is not flagged;
 * "Deploy to staging." becoming "Deploy to production." beneath the same question is a different
 * target for the same approval.
 */
function editedContext(older: ReviewItem, newer: ReviewItem): boolean {
  const before = contextWords(older);
  const after = contextWords(newer);
  return editedInOnePlace(before, after) || onlySmallEdits(before, after);
}

function editedInOnePlace(before: string[], after: string[]): boolean {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start && end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  const content = (word: string) => !STOPWORDS.has(word);
  if (removed.length === 0 || added.length === 0) return [...removed, ...added].some(content);
  if (Math.min(removed.length, added.length) !== 1) return false;
  if (Math.max(removed.length, added.length) > MAX_SWAP_WORDS) return false;
  return removed.some(content) && added.some(content);
}

/**
 * Is every difference between the two texts a small edit (at most `MAX_SWAP_WORDS` words on each
 * side), with at least one replacing a content word by another?
 *
 * That is the same sentence with its targets swapped, in as many places as the agent changed
 * them: "Should I deploy to staging and notify alice?" then "Should I deploy to production and
 * notify bob?". Neither swap has three matching words on both sides for `swappedWord`, and two
 * edits are not one for `editedInOnePlace`. A retry that rewords its question rewrites at least
 * one longer run somewhere ("Claude 2.1.310 and Codex 0.160.0 both" became "both harnesses"),
 * which this leaves to the other checks. Small insertions and deletions alone change no target:
 * "Please confirm which button location I should implement" restates "Which button location
 * should I implement" with nothing replaced.
 *
 * The differences are the runs between a longest common subsequence of the two word lists.
 */
function onlySmallEdits(before: string[], after: string[]): boolean {
  const a = before.slice(0, MAX_DIFF_WORDS);
  const b = after.slice(0, MAX_DIFF_WORDS);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  let swappedTarget = false;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const startA = i;
    const startB = j;
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) j++;
      else i++;
    }
    if (i - startA > MAX_SWAP_WORDS || j - startB > MAX_SWAP_WORDS) return false;
    const content = (w: string) => !STOPWORDS.has(w);
    if (a.slice(startA, i).some(content) && b.slice(startB, j).some(content)) swappedTarget = true;
  }
  return swappedTarget;
}
