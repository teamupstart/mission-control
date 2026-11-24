import type { TranscriptMessage } from "@shared/types.ts";

/**
 * The one place a launch presentation marker becomes a visible conversation.
 *
 * Pure, browser-safe, and derived rather than stored, which is the whole design. The panel
 * keeps the daemon's unprojected messages as its state - that array is what SSE merges into,
 * what the history cache holds, and what the byte anchors behind `?before=` and `?from=`
 * describe - and every DISPLAY consumer reads this projection of it instead. Rows, both
 * renderings, find-in-conversation, the empty state and the Yours rail therefore agree by
 * construction rather than by four call sites remembering to.
 *
 * That split is not tidiness. A projection folded into the turn component would leave the
 * hidden text searchable and listed under a tab called "Yours"; a projection folded into the
 * panel's state would put display text where paging arithmetic reads native bytes.
 *
 * Four cases, and the second is the load-bearing one:
 *
 * - a marker with `displayText`: the same message, with `text` replaced. The id, role,
 *   timestamp and tools are the native record's, so a find hit and a Yours row still jump to
 *   the turn the log actually rendered, and review interleaving still orders around it.
 * - a marker with `displayText: null`: the turn is OMITTED. A launch with no human-authored
 *   request has nothing honest to draw - showing the platform contract is the bug this
 *   exists to fix, and inventing prose would put words in the operator's mouth.
 * - a `review-message` turn: returned unchanged. Its cards are drawn by `mergeConversation`,
 *   which knows the reviews; a review it cannot find gets a loading, unreadable or "no longer
 *   available" card by the state of the review history (`UnavailableReviewCard`), and this
 *   native text is only ever shown inside a card's "What the agent received".
 * - no marker: returned unchanged, by reference. Every historical transcript, every manually
 *   discovered session, and every conversation a `/clear` replaced takes this path, which is
 *   why an installation with an empty marker table renders exactly as it did before.
 */
export function projectLaunchPresentation(
  messages: readonly TranscriptMessage[],
  voiceEnabled = true,
): TranscriptMessage[] {
  const projected: TranscriptMessage[] = [];
  for (const message of messages) {
    const presentation = message.presentation;
    // A review message keeps its native text here: it is drawn as answer cards where the
    // conversation is merged with its reviews (`mergeConversation`), and its text is what
    // "What the agent received" discloses.
    if (presentation?.kind === "spoken" && !voiceEnabled) {
      projected.push({ ...message, presentation: undefined });
      continue;
    }
    if (!presentation || presentation.kind === "review-message") {
      projected.push(message);
      continue;
    }
    if (!presentation.displayText) continue;
    projected.push({ ...message, text: presentation.displayText });
  }
  return projected;
}
