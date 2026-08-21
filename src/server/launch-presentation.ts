import { createHash } from "node:crypto";

import type { TranscriptMessage, TranscriptPresentation } from "@shared/types.ts";

/**
 * The launch turn of a Mission Control-managed conversation, recorded so the dashboard can
 * draw the operator's request where the transcript holds the whole composed prompt.
 *
 * What is NOT here is the design. The composed prompt is not stored: it already exists, in
 * full, in the agent's own transcript, and a second copy in SQLite would be a second source
 * of transcript truth that could drift from the first. What is stored is a FINGERPRINT of
 * it - enough to recognize that one turn and nothing else - plus the human request as it
 * stood at dispatch, so a later task edit cannot rewrite visible history.
 */
export interface LaunchTurnMarker {
  /** `noteKeyFor(session)` - the same logical conversation key Goal and notes use. */
  noteKey: string;
  /** `launchTextFingerprint` of the complete prompt that crossed into the runtime. */
  fingerprint: string;
  /**
   * The operator's own request, as captured at dispatch. Null when the launch had no
   * distinct human-authored request, which omits the turn rather than exposing the
   * platform contract.
   */
  displayText: string | null;
  /**
   * The native transcript id of the turn this marker projects, once one has been seen.
   *
   * The OCCURRENCE anchor, and the reason a fingerprint alone is not enough. A fingerprint
   * says "text shaped like the launch"; it cannot say "the turn that started this
   * conversation". Nothing stops the same bytes arriving again later - a delivery retry
   * pastes the intent twice by design, and automation can resend it verbatim - and a marker
   * that matched on text alone would then project the repeat too, replacing or omitting a
   * turn that really was a later message.
   *
   * Null until a decorated read identifies the turn, because at dispatch the turn does not
   * exist yet: the prompt has not been written to the transcript, so it has no id to record.
   * The first fingerprint match binds this, and from then on the fingerprint is not consulted
   * at all - only this id projects, and every later identical turn renders literally.
   */
  messageId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a launch seam hands to the layer that persists the marker.
 *
 * Two separate facts, and keeping them separate is the point: `prompt` is what the runtime
 * actually received, byte for byte, and `displayText` is what a person asked for. Composing
 * one from the other at read time is what would let the projection drift away from what the
 * agent was really told.
 */
export interface LaunchPresentationInput {
  /** The COMPLETE text that crossed into the runtime, after every composition step. */
  prompt: string;
  /** The operator's own request, or null when this launch had none. */
  displayText: string | null;
}

/**
 * The recognizer for "this normalized turn is that launch".
 *
 * One function for BOTH capture and comparison, which is the whole reason it exists as a
 * function rather than as two `.trim()` calls: the two sides run in different modules, at
 * different times, over text that took different routes to get there, and a normalization
 * that lived at each site is one that eventually only lives at one of them. A mismatch
 * degrades safely - the turn renders in full, exactly as it does today - so this being
 * conservative is the correct failure direction, but it should still be right.
 *
 * Trimming is the normalization every harness transcript adapter already applies to user
 * text (`text = text.trim()` in each of the three parsers). Nothing else is folded in:
 * matching a turn we merely resemble is the failure mode that would hide a real human
 * message, and it is worse than showing a launch contract.
 */
export function launchTextFingerprint(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex");
}

/**
 * The slice of Registry a transcript seam needs, named structurally so this module does not
 * import the Registry it is imported BY.
 */
export interface LaunchMarkerSource {
  launchTurnFor(sessionId: string): LaunchTurnMarker | null;
  bindLaunchTurnMessage(sessionId: string, messageId: string): void;
}

/**
 * Resolve a session's launch marker for a transcript read, and never let that resolution
 * break the read.
 *
 * The same rule the write side follows, applied on this side: the transcript is what the
 * reader asked for and the projection is a courtesy. Both callers are already inside
 * failure handling that answers "no transcript" - the SSE handler's own catch, and the
 * route's page - so an unguarded throw here would cost a whole conversation for the sake of
 * a display detail. Degrading to null is visible and harmless: the launch turn renders in
 * full, exactly as it did before this feature existed.
 */
export function resolveLaunchMarker(
  source: LaunchMarkerSource,
  sessionId: string | undefined,
): LaunchTurnMarker | null {
  if (!sessionId) return null;
  try {
    return source.launchTurnFor(sessionId);
  } catch (err) {
    console.error(
      `[transcript] could not resolve the launch presentation for ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Bind the identified launch turn to its marker, and never let that write break a read.
 *
 * The companion to `resolveLaunchMarker`, on the same terms and for the same reason: this
 * runs on a transcript read, and a conversation must not be lost because a presentation row
 * could not be updated. A failed bind leaves the marker matching on fingerprint alone, which
 * is exactly today's behaviour minus the occurrence anchor - the next read tries again.
 */
export function bindLaunchTurnMessage(
  source: LaunchMarkerSource,
  sessionId: string | undefined,
  messageId: string,
): void {
  if (!sessionId) return;
  try {
    source.bindLaunchTurnMessage(sessionId, messageId);
  } catch (err) {
    console.error(
      `[transcript] could not anchor the launch turn for ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * The presentation for one normalized message under one marker, or null to leave it alone.
 *
 * Narrow on purpose, and deliberately NOT "the first user turn": a resumed conversation, a
 * manually discovered session, and a task assigned into a live session all open on a real
 * human message, and a positional heuristic would delete it. The marker itself only exists
 * because a dispatch wrote it.
 *
 * Two matching modes, and the second is the one that matters:
 *
 * - **Anchored** (`messageId` set): only that exact native turn projects. The fingerprint is
 *   not consulted, so a later turn carrying the identical bytes - a delivery retry, an
 *   automated resend - renders literally, as the real message it is.
 * - **Unanchored** (`messageId` null): the turn is recognized by fingerprint, which is all
 *   there is to go on before any read has seen it. The caller anchors the first match; see
 *   `attributeTranscript`, which is what makes this mode transient rather than permanent.
 */
export function launchPresentationFor(
  message: TranscriptMessage,
  marker: LaunchTurnMarker | null,
): TranscriptPresentation | null {
  if (!marker) return null;
  if (message.role !== "user" || !message.text) return null;
  if (marker.messageId !== null) {
    return message.id === marker.messageId
      ? { kind: "launch", displayText: marker.displayText }
      : null;
  }
  if (launchTextFingerprint(message.text) !== marker.fingerprint) return null;
  return { kind: "launch", displayText: marker.displayText };
}
