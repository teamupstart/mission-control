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
 * The presentation for one normalized message under one marker, or null to leave it alone.
 *
 * Narrow on purpose, and deliberately NOT "the first user turn": a resumed conversation, a
 * manually discovered session, and a task assigned into a live session all open on a real
 * human message, and a positional heuristic would delete it. Three things have to hold -
 * a user-role turn, carrying text, whose fingerprint is the recorded one - and the marker
 * itself only exists because a dispatch wrote it.
 */
export function launchPresentationFor(
  message: TranscriptMessage,
  marker: LaunchTurnMarker | null,
): TranscriptPresentation | null {
  if (!marker) return null;
  if (message.role !== "user" || !message.text) return null;
  if (launchTextFingerprint(message.text) !== marker.fingerprint) return null;
  return { kind: "launch", displayText: marker.displayText };
}
