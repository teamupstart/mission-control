// Text that is about to be typed into somebody's terminal pane: the control-byte scrub and
// the byte-bounded field clip every daemon-composed packet applies.
//
// Kept apart from `feedback.ts` on purpose. `../inspector/findings-text.ts` needs exactly
// these rules and is meant to be loadable by Foreman's worker, which must not pull in the
// workflow packet module (and with it the execution-authorization contract) to get them.
// One definition, so the workflow packet and Foreman's relay, which share the renderer,
// can never scrub or clip the same finding differently. Its imports stay pure: a
// browser-safe shared limit and a byte helper.

import { WORKFLOW_LIMITS } from "@shared/workflow.ts";
import { utf8Bytes } from "../util/utf8.ts";

/** Remove bytes that a terminal could interpret as controls while retaining plain line breaks. */
export function sanitizeWorkflowFeedback(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Sanitize, then clip to at most `maxBytes` of UTF-8 without splitting a character. */
export function clipUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const clean = sanitizeWorkflowFeedback(value);
  if (utf8Bytes(clean) <= maxBytes) return { value: clean, truncated: false };
  let bytes = 0;
  let output = "";
  for (const scalar of clean) {
    const size = utf8Bytes(scalar);
    if (bytes + size > maxBytes) break;
    output += scalar;
    bytes += size;
  }
  return { value: output, truncated: true };
}

/** One packet field, sanitized and clipped at the per-field limit every packet shares. */
export function clipPacketField(value: string): { value: string; truncated: boolean } {
  return clipUtf8(value, WORKFLOW_LIMITS.feedbackFieldBytes);
}
