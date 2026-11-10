// The findings section of a message that hands GitHub Inspector findings to a session.
//
// Its two callers are the workflow `inspector_feedback` packet and Foreman's review
// follow-through, so the two say the same thing about the same finding: how severe it is,
// where it is, whether it is on GitHub, and what it says. Each caller keeps its own header and closing; this module owns only the findings
// in between.
//
// Pure, and deliberately so. It imports nothing that opens the database or the network, so
// Foreman's worker (which never touches SQLite) can load it as readily as the daemon does.
// `test/inspector-findings-text.test.ts` walks its import graph to keep it that way.

import type { InspectorComment } from "@shared/types.ts";
import {
  compareInspectorFindings,
  findingPublication,
  refusalTimes,
  type FindingPublication,
} from "@shared/inspector-findings.ts";
import { utf8Bytes } from "../util/utf8.ts";
import { clipPacketField, sanitizeWorkflowFeedback } from "../workflows/packet-text.ts";

export interface RenderedInspectorFindings {
  /** The findings section, already sanitized for a terminal. Empty only when nothing fits. */
  text: string;
  /** Findings listed in `text`. */
  shown: number;
  /** Findings left out to stay under the budget. `shown + omitted` is the deduplicated total. */
  omitted: number;
  /**
   * A listed finding had a field clipped at the per-field limit, or the budget could not
   * hold even the count line.
   */
  truncated: boolean;
}

export interface RenderInspectorFindingsOptions {
  /** The most UTF-8 bytes `text` may take, closing line included. */
  budgetBytes: number;
  /**
   * Bytes the caller adds after the section only when `truncated` comes back true, such as a
   * packet's truncation notice. A listing with a clipped field must fit in `budgetBytes`
   * minus this; one without uses the whole budget, so no finding is dropped to make room for
   * a notice that is never sent.
   */
  truncationReserveBytes?: number;
}

const BLOCK_SEPARATOR = "\n\n";
const LEGACY_BODY =
  "Legacy finding detail is unavailable. Use the severity, title, and location above.";

/**
 * One finding per fingerprint, in the shared comparator's order.
 *
 * A unique DB index normally makes a duplicate unreachable. Keeping the choice deterministic
 * for a duplicated snapshot stops caller order from changing a frozen packet if a joined or
 * legacy input ever contains the same issue twice.
 *
 * Today's order of preference leads (location, title, body, severity, id), and every other
 * field follows in key order, so two rows that differ only in what `findingPublication` reads
 * (status, `postedAt`, `githubUrl`, `legacyPosted`) still resolve the same way in any input
 * order. An absent field and a null one stay distinct, as `findingPublication` reads them.
 */
export function dedupeInspectorFindings(findings: readonly InspectorComment[]): InspectorComment[] {
  const stableFinding = (row: InspectorComment): string => JSON.stringify([
    row.path,
    row.line,
    row.title,
    row.body,
    row.severity,
    row.id,
    ...Object.keys(row)
      .filter((key) => row[key as keyof InspectorComment] !== undefined)
      .sort()
      .map((key) => [key, row[key as keyof InspectorComment]]),
  ]);
  const unique = new Map<string, InspectorComment>();
  for (const finding of findings) {
    const prior = unique.get(finding.fingerprint);
    if (!prior || stableFinding(finding) < stableFinding(prior)) {
      unique.set(finding.fingerprint, finding);
    }
  }
  // The shared comparator, so the findings route lists them in the order these messages do.
  return [...unique.values()].sort(compareInspectorFindings);
}

/**
 * The one line that says whether a finding is on GitHub, and where.
 *
 * A finding the session cannot find on GitHub must say so, or the agent goes looking for a
 * thread that does not exist. And a draft whose earlier version WAS posted must never be
 * called the only copy: the earlier thread is resolved, but it is still where that
 * conversation lives.
 *
 * A draft GitHub refused says how many times and why from the first refusal, so the session
 * knows the draft is not on GitHub and is not about to be. Below the cap it is offered again
 * on the next push; at the cap (`refused`) it is not, and the line makes no such promise.
 *
 * The link is a packet field like any other, so it clips at the per-field limit. `bound`
 * is the caller's clip, which lets a finding's block record that the link was clipped.
 */
export function inspectorFindingPostedLine(
  finding: InspectorComment,
  bound: (value: string) => string = (value) => clipPacketField(value).value,
): string {
  const publication = findingPublication(finding);
  const url = publication.url ? bound(publication.url) : null;
  switch (publication.state) {
    case "posted":
      if (!url) return "Posted on GitHub (link not captured yet)";
      // A finding with no line was demoted into the review body; its link is that review.
      return finding.line === null
        ? `Posted on GitHub in the review summary: ${url}`
        : `Posted on GitHub: ${url}`;
    case "not-posted":
      if (publication.refusals > 0) {
        return withEarlierPost(
          `Not posted yet. GitHub refused it ${refusalTimes(publication.refusals)}${refusalReason(publication, bound)}. ` +
            "Mission Control offers it again on the next push.",
          publication,
          url,
        );
      }
      if (publication.earlierPost) {
        return url
          ? `Not posted again. An earlier version was posted on GitHub: ${url}`
          : "Not posted again. An earlier version was posted on GitHub (link not captured).";
      }
      return "Not posted on GitHub. This message is the only copy.";
    case "refused":
      // No longer offered, so no promise of another try. It stays unresolved.
      return withEarlierPost(
        `Not posted. GitHub refused it ${refusalTimes(publication.refusals)}${refusalReason(publication, bound)}`,
        publication,
        url,
      );
    case "posting":
      return "Being posted now";
    case "unknown":
      return "Not known whether this was posted on GitHub: it was recorded before Mission Control tracked posting.";
    default: {
      const unreachable: never = publication.state;
      return unreachable;
    }
  }
}

/**
 * ": <reason>", clipped like any packet field, or nothing when GitHub gave none. A closing
 * full stop is dropped so the sentence that follows does not read "..".
 */
function refusalReason(publication: FindingPublication, bound: (value: string) => string): string {
  const reason = publication.reason?.replace(/[\s.]+$/, "") ?? "";
  return reason ? `: ${bound(reason)}` : "";
}

/**
 * A refused draft whose earlier version was posted still says where that version is, so it is
 * never read as the only copy.
 */
function withEarlierPost(line: string, publication: FindingPublication, url: string | null): string {
  if (!publication.earlierPost) return line;
  const sentence = /[.!?]$/.test(line) ? line : `${line}.`;
  return url
    ? `${sentence} An earlier version was posted on GitHub: ${url}`
    : `${sentence} An earlier version was posted on GitHub (link not captured).`;
}

/**
 * The closing line for findings left out. An omitted finding is still unresolved, so it
 * stays open. With some listed, the rest come back in the next relay; with none listed,
 * not even the first fits whole, and the line says that rather than promising a resend.
 */
export function omittedFindingsLine(omitted: number, shown: number): string {
  if (shown === 0) {
    return omitted === 1
      ? "1 unresolved finding is not listed here, because it does not fit in this message whole. It stays open."
      : `${omitted} unresolved findings are not listed here, because not even the first fits in this message whole. They stay open.`;
  }
  return omitted === 1
    ? "1 more unresolved finding is not listed here, to keep this message short. It stays open and comes back in the next relay."
    : `${omitted} more unresolved findings are not listed here, to keep this message short. They stay open and come back in the next relay.`;
}

/**
 * The smallest budget at which the section always states its count: the line that lists
 * none. A caller that composes a header around the section reserves this before sizing the
 * header, so a long header can never leave the findings with neither text nor a count.
 */
export function inspectorFindingsMinimumBytes(findings: readonly InspectorComment[]): number {
  const total = dedupeInspectorFindings(findings).length;
  return total === 0 ? 0 : utf8Bytes(omittedFindingsLine(total, 0));
}

/**
 * Render the findings section under a byte budget.
 *
 * Fields clip at `feedbackFieldBytes`, as every packet field does. Past the budget, whole
 * findings drop from the tail - the tail is the lowest severity, by the comparator - and a
 * closing line says how many. A finding is never cut part way, the first one included: when
 * not even it fits whole, none is listed and the closing line carries the count alone.
 * `truncated` reports only a field clipped at its per-field limit in a listed finding, or a
 * budget too small to state even the count. A listing that sets it must also leave room for
 * `truncationReserveBytes`.
 */
export function renderInspectorFindings(
  findings: readonly InspectorComment[],
  opts: RenderInspectorFindingsOptions,
): RenderedInspectorFindings {
  const budget = Math.max(0, Math.floor(opts.budgetBytes));
  const reserve = Math.max(0, Math.floor(opts.truncationReserveBytes ?? 0));
  const blocks = dedupeInspectorFindings(findings).map(renderBlock);
  const total = blocks.length;
  if (total === 0) return { text: "", shown: 0, omitted: 0, truncated: false };

  const shown = wholeFindingsThatFit(blocks, budget, reserve);
  const omitted = total - shown;
  const kept = blocks.slice(0, shown);
  const text = [
    ...kept.map((block) => block.text),
    ...(omitted > 0 ? [omittedFindingsLine(omitted, shown)] : []),
  ].join(BLOCK_SEPARATOR);
  // Only reachable with nothing listed: a budget too small for the count line itself.
  if (utf8Bytes(text) > budget) return { text: "", shown: 0, omitted: total, truncated: true };
  return { text, shown, omitted, truncated: kept.some((block) => block.truncated) };
}

/**
 * How many leading findings fit whole, beside the omitted-count line the rest would need.
 * Once a listed finding has a clipped field, the caller's truncation reserve comes off the
 * budget; it only grows from there, so the first prefix that does not fit ends the search.
 */
function wholeFindingsThatFit(
  blocks: readonly FindingBlock[],
  budget: number,
  truncationReserve: number,
): number {
  let used = 0;
  let fit = 0;
  let clipped = false;
  for (let shown = 1; shown <= blocks.length; shown += 1) {
    const block = blocks[shown - 1]!;
    used += utf8Bytes(block.text) + (shown > 1 ? BLOCK_SEPARATOR.length : 0);
    clipped ||= block.truncated;
    const room = budget - (clipped ? truncationReserve : 0);
    if (used > room) break;
    const omitted = blocks.length - shown;
    const closing = omitted > 0
      ? BLOCK_SEPARATOR.length + utf8Bytes(omittedFindingsLine(omitted, shown))
      : 0;
    if (used + closing <= room) fit = shown;
  }
  return fit;
}

interface FindingBlock {
  text: string;
  truncated: boolean;
}

function renderBlock(finding: InspectorComment): FindingBlock {
  let truncated = false;
  const bounded = (value: string): string => {
    const result = clipPacketField(value);
    truncated ||= result.truncated;
    return result.value;
  };
  const location = finding.path
    ? `${finding.path}${finding.line ? `:${finding.line}` : ""}`
    : "general";
  const head = sanitizeWorkflowFeedback([
    `## ${finding.severity.toUpperCase()} - ${bounded(finding.title)}`,
    `Location: ${bounded(location)}`,
    inspectorFindingPostedLine(finding, bounded),
  ].join("\n"));
  const body = bounded(finding.body ?? LEGACY_BODY);
  const tail = sanitizeWorkflowFeedback(`Fingerprint: ${finding.fingerprint}`);
  return { text: `${head}\n${body}\n${tail}`, truncated };
}
