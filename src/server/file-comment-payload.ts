// What one comment looks like when it reaches the agent.
//
// A pure renderer in the `src/server/workflows/feedback.ts` family, and for that family's
// reasons: it is server-side so the agent's copy and the dashboard's record cannot drift,
// and pure so it is tested without a session, a pane, or a database. It shares that file's
// sanitizer rather than growing a second one - two escapers for one wire would eventually
// disagree about which byte a terminal reads as a control.
//
// **It renders ONE message, not "the thread's comment".** The distinction only stops
// mattering on a thread's first turn: a thread that timed out, or that a person replied to
// after an answer, has more than one human message, and "the comment" would resend the
// opening one for ever. The caller selects the thread's oldest human message whose
// `deliveredAt` is NULL and hands its body here; see `FileCommentWalkthrough.nextMessage`.

import { createHash } from "node:crypto";
import { sanitizeWorkflowFeedback } from "./workflows/feedback.ts";

const encoder = new TextEncoder();

/**
 * What one rendered comment may cost, in UTF-8 bytes.
 *
 * Deliberately not `WORKFLOW_LIMITS.feedbackPayloadBytes`. A repair packet is a SUMMARY the
 * daemon writes from verdicts, so eight kilobytes is a design budget it chooses. This packet
 * carries two things a person authored - the text they selected and the sentence they wrote
 * about it - and clipping either at a budget chosen for machine-written prose would deliver a
 * different comment from the one they submitted.
 *
 * So each half is budgeted at the bound its own door already enforces: the quote at
 * `FILE_COMMENT_QUOTE_MAX` (4,000 characters, already clamped at creation) and the body at
 * `FILE_COMMENT_TEXT_LIMITS.body` (8,000 characters, already refused past it by the route's
 * schema). In bytes those are ceilings rather than equalities - a multi-byte scalar counts
 * more than once - which is the only case where clipping happens at all, and it is announced
 * when it does.
 */
export const FILE_COMMENT_PAYLOAD_LIMITS = {
  quoteBytes: 6_000,
  bodyBytes: 12_000,
  /** The whole packet. The two fields plus framing, with room for the longest position line. */
  payloadBytes: 20_000,
} as const;

const TRUNCATION_NOTICE = "\n\n[This comment was clipped deterministically to fit one turn.]";

export interface FileCommentPayloadInput {
  /** Repository-relative, exactly as the Files tab lists it. */
  path: string;
  /** 1-based, inclusive, in the file's source, AFTER the re-anchor pass has run. */
  startLine: number;
  endLine: number;
  /** The anchored source text. */
  quote: string;
  /** The body of the one message this turn carries. */
  body: string;
  /** `MC-a41f`: the thread's handle, unique per session and the only id the agent is shown. */
  shortId: string;
  /**
   * 1-based position of this message among the thread's HUMAN messages.
   *
   * The trailing `.2` in `MC-a41f.2`, and what makes a reply answer a turn rather than a
   * thread. Derived from the message list, so it needs no column.
   */
  ordinal: number;
  /** 1-based position of this comment in the review, and how many the review holds. */
  position: number;
  total: number;
  /**
   * The MCP tool the agent should answer through, or null while there is not one.
   *
   * Phase 4 supplies `mcp__mission-control__respond_to_file_comments`; the null rendering is
   * kept rather than deleted, because it is what a caller that cannot offer the tool must
   * print. Naming a tool an agent cannot call is the failure mode `FINAL_INSTRUCTION` in
   * `feedback.ts` documents - an instruction the loop cannot honour is one it follows into
   * silence - and the handle is cited either way, which is what makes the tool-less session
   * answerable at all.
   */
  replyTool?: string | null;
}

export interface RenderedFileComment {
  payload: string;
  payloadSha256: string;
  truncated: boolean;
}

/** `line 84`, or `lines 84-86`. One anchor reads two ways and both are ordinary. */
export function lineRangeLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

/** The handle the agent quotes back: the thread's short id plus this turn's delivery ordinal. */
export function deliveryHandle(shortId: string, ordinal: number): string {
  return `${shortId}.${ordinal}`;
}

/**
 * The one spelling of a delivery handle, and therefore the one place it is READ back.
 *
 * Minting it and parsing it live in the same file on purpose: the agent quotes back exactly
 * what this module printed, so a change to `deliveryHandle` that no reader followed would
 * produce a handle nothing can resolve - which is the whole failure mode the ordinal exists
 * to avoid.
 */
const HANDLE = "\\[?(MC-[0-9a-fA-F]+)(?:\\.(\\d+))?\\]?";
/** The tool argument: the handle and nothing else, with surrounding space or brackets. */
const HANDLE_EXACT = new RegExp(`^\\s*${HANDLE}\\s*$`);
/**
 * The transcript fallback: an assistant turn that OPENS with the handle.
 *
 * Anchored at the start rather than searched for anywhere in the turn, because a turn that
 * merely mentions a handle in passing - quoting the comment it is about to answer, listing
 * what is still outstanding - is not an answer to it. Markdown emphasis and a leading list
 * marker are allowed through because a model writes `**MC-a41f.2**` as readily as `MC-a41f.2`.
 */
const HANDLE_OPENING = new RegExp(`^[\\s>*_#-]*${HANDLE}`);

export interface DeliveryHandleParts {
  /** The thread's `short_id`, normalized to the case the store minted it in. */
  shortId: string;
  /**
   * The delivery ordinal, or null when the citation carried none.
   *
   * Null is not an error and is not a rejection: it is the transcript fallback's ordinary
   * outcome, and it means the citation names a THREAD but confirms no delivery. A caller
   * that files the message and advances nothing is behaving correctly; a caller that treats
   * null as "the current delivery" would release a turn nothing answered.
   */
  ordinal: number | null;
}

function parts(match: RegExpMatchArray | null): DeliveryHandleParts | null {
  if (!match) return null;
  const ordinal = match[2] === undefined ? null : Number(match[2]);
  if (ordinal !== null && (!Number.isInteger(ordinal) || ordinal < 1)) return null;
  // `MC-` is minted uppercase with lowercase hex; a citation may arrive in any case, and a
  // handle that differs from the stored one only in case is the same handle.
  return { shortId: `MC-${match[1]!.slice(3).toLowerCase()}`, ordinal };
}

/** Read the handle a reply cites. Null when the value is not a handle at all. */
export function parseDeliveryHandle(value: string): DeliveryHandleParts | null {
  return parts(HANDLE_EXACT.exec(value));
}

/** Read the handle an assistant turn opens with, for the tool-less fallback. */
export function openingDeliveryHandle(text: string): DeliveryHandleParts | null {
  return parts(HANDLE_OPENING.exec(text));
}

function clip(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const clean = sanitizeWorkflowFeedback(value);
  if (encoder.encode(clean).byteLength <= maxBytes) return { value: clean, truncated: false };
  let bytes = 0;
  let output = "";
  for (const scalar of clean) {
    const size = encoder.encode(scalar).byteLength;
    if (bytes + size > maxBytes) break;
    output += scalar;
    bytes += size;
  }
  return { value: output, truncated: true };
}

/**
 * Render the turn that carries one comment.
 *
 * The shape is `plan.md`'s, and the two lines that look like decoration are not:
 *
 * - **The position line** is the stated mitigation for the one thing a batch does better. An
 *   agent that knows nine more comments are coming does not restructure the document on
 *   comment three, and this is the only place it is told.
 * - **The closing instruction** asks for this comment and no more, for the same reason.
 *
 * The quote is fenced with `>` rather than a code fence: a comment on Markdown routinely
 * quotes text containing a fence, and a fence inside a fence ends the outer one.
 */
export function renderFileCommentPayload(input: FileCommentPayloadInput): RenderedFileComment {
  const quote = clip(input.quote, FILE_COMMENT_PAYLOAD_LIMITS.quoteBytes);
  const body = clip(input.body, FILE_COMMENT_PAYLOAD_LIMITS.bodyBytes);
  let truncated = quote.truncated || body.truncated;

  const remaining = Math.max(0, input.total - input.position);
  const handle = deliveryHandle(input.shortId, input.ordinal);
  const answerLine = input.replyTool
    ? `Answer with ${input.replyTool} quoting id ${handle}.`
    : `Answer in your next turn, quoting id ${handle}.`;
  // "the remaining 9 follow one at a time" reads as a promise, so the last comment must not
  // make it - a review that said nine more were coming and then stopped would teach the agent
  // to hold back work on every future review.
  const scopeLine =
    remaining === 0
      ? "Answer this comment only - it is the last of this review, so do not restructure beyond what it asks for."
      : `Answer this comment only - the remaining ${remaining} follow${remaining === 1 ? "s" : ""} one at a time, so do not restructure beyond what this one asks for.`;

  const quotedLines = quote.value.split("\n").map((line) => (line ? `> ${line}` : ">"));
  const bodyText = body.value.replace(/\s+$/u, "");
  const head = [
    `Comment ${input.position} of ${input.total} on this review.`,
    "",
    `${sanitizeWorkflowFeedback(input.path)}, ${lineRangeLabel(input.startLine, input.endLine)}:`,
    "",
    ...quotedLines,
    "",
    bodyText,
  ].join("\n");
  const tail = `${answerLine}\n${scopeLine}`;

  let payload = `${head.replace(/\s+$/u, "")}\n\n${tail}`;
  if (encoder.encode(payload).byteLength > FILE_COMMENT_PAYLOAD_LIMITS.payloadBytes) {
    truncated = true;
  }
  if (truncated) {
    // The tail is never clipped: it is what tells the agent which turn it is answering and
    // how much of the document to leave alone, and a packet missing either is worse than one
    // missing the end of a quote.
    const suffix = `\n\n${tail}${TRUNCATION_NOTICE}`;
    const budget = FILE_COMMENT_PAYLOAD_LIMITS.payloadBytes - encoder.encode(suffix).byteLength;
    payload = clip(head, Math.max(0, budget)).value.replace(/\s+$/u, "") + suffix;
  }
  return {
    payload,
    payloadSha256: createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex"),
    truncated,
  };
}
