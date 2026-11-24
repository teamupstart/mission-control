import { featureEnabled } from "./feature-flags/index.ts";
import { spokenLedger } from "./delivery-ledgers.ts";
import { residentWakePresentation } from "./residents/loop-store.ts";
import type { TranscriptMessage } from "@shared/types.ts";
import { delegatedTurnSources, type DelegatedConversation } from "./delegated-turns.ts";
import { originOf } from "./injections.ts";
import { launchPresentationFor, type LaunchTurnMarker } from "./launch-presentation.ts";
import { reviewMessageTurns } from "./review-deliveries.ts";

/**
 * The normalization overlay: facts only the running daemon holds, added to turns a harness
 * parser read out of a file.
 *
 * Both overlays here are strictly ADDITIVE. `text`, `tools`, `ts`, `role` and the native
 * message id are the file's, untouched, which is what lets the same call serve the
 * dashboard and an evidence consumer without either of them needing to know about the
 * other. A reader that ignores both fields reads exactly what the transcript says.
 *
 * `origin` answers WHO typed a user turn. `presentation` answers which part of one accepted
 * turn the dashboard should DRAW. Those are different questions and they stay different
 * fields: conflating them would credit the platform's launch contract to Foreman or the
 * harness, and would turn authorship code into a visibility switch.
 *
 * `launch` is optional because most callers have no launch marker to apply - and two of them
 * deliberately pass none. Only the dashboard's own transcript seams (the SSE stream and the
 * backward-page route) decorate presentation; the retro reader and every other server-side
 * evidence path asks for the record, not for a rendering of it.
 */
export function attributeTranscript(
  sessionId: string | undefined,
  messages: TranscriptMessage[],
  launch: LaunchTurnMarker | null = null,
  onLaunchTurnIdentified?: (messageId: string) => void,
  conversation?: DelegatedConversation | null,
): TranscriptMessage[] {
  if (!sessionId) return messages;
  // Delegated turns are answered from the durable per-delivery record, bound against the
  // target's transcript file, so they keep naming their sender across a restart and
  // identical words from two controllers keep naming each. Callers without the conversation
  // get the live label only.
  const delegated = delegatedTurnSources(conversation, messages);
  // Review messages (`async-input`) are answered the same way, from the daemon's own recorded
  // deliveries. A turn is Mission Control's, and drawn as answer cards, only when a delivery is
  // bound to it; a pasted marker, or a copy of a delivered message, stays the operator's.
  const spoken = featureEnabled("voice") ? spokenLedger.bound(conversation, messages).rows : undefined;
  const reviews = reviewMessageTurns(conversation, messages);
  /**
   * The launch turn's native id, once this page has established it.
   *
   * Seeded from the marker, so an already-anchored marker projects exactly one turn and the
   * fingerprint is never consulted again. Left null only until the first match, and then set
   * IMMEDIATELY - within this page, not after the durable write lands - because a page can
   * contain the launch turn and a later turn carrying the same bytes, and both would
   * otherwise match. Claiming locally is what makes the repeat render as the message it is.
   */
  let anchor = launch?.messageId ?? null;
  return messages.map((message) => {
    if (message.role !== "user" || !message.text) return message;
    const voice = spoken?.get(message.id);
    if (voice) return { ...message, presentation: { kind: "spoken", displayText: voice.spokenWords, received: voice.received } };
    const residentText = residentWakePresentation(message, conversation);
    if (residentText !== null) return { ...message, origin: "resident", presentation: { kind: "resident", displayText: residentText } };
    const review = reviews.bound.get(message.id);
    // The origin and the presentation come from the bound delivery alone, so they hold even when
    // a review it carried can no longer be found.
    if (review) return { ...message, origin: "harness", presentation: review.presentation };
    // A delivery's words on a turn no delivery claims are someone else's copy, so the in-memory
    // label (which matches by text) must not credit it to Mission Control; and while a delivery
    // of those words is contested, the turn could be either, so it carries no label at all.
    const reviewCopy = reviews.matched.has(message.id);
    const reviewUnresolved = reviews.ambiguous.has(message.id);
    const originSession = delegated.sources.get(message.id);
    const remembered = originOf(sessionId, message.text);
    // Resident labels require a bound native turn; a text-keyed reservation also
    // matches a human copying that turn and is not sufficient attribution.
    const live = remembered === "resident" || reviewCopy ? undefined : remembered;
    // A turn whose words this conversation delegated, but which no delivery claims, is the
    // operator repeating them; the text-keyed live label would credit the controller. And while
    // a delivery of those words is unresolved, the turn could be it, so no live label - Foreman's
    // included - names its author either.
    const origin = originSession
      ? "session"
      : delegated.ambiguous.has(message.id) || (live === "session" && delegated.contested.has(message.id)) ? undefined : live;
    const marker = launch && anchor !== null && launch.messageId === null
      ? { ...launch, messageId: anchor }
      : launch;
    const presentation = launchPresentationFor(message, marker);
    if (presentation && anchor === null) {
      anchor = message.id;
      // Persisted by the caller, so the next read is anchored too rather than re-deciding
      // from the fingerprint. Best-effort by contract: see `bindLaunchTurnMessage`.
      onLaunchTurnIdentified?.(message.id);
    }
    const unresolved = !origin && (delegated.ambiguous.has(message.id) || reviewUnresolved);
    if (!origin && !presentation && !unresolved) return message;
    return {
      ...message,
      ...(origin ? { origin } : {}),
      ...(originSession ? { originSession } : {}),
      ...(unresolved ? { originUnresolved: true as const } : {}),
      ...(presentation ? { presentation } : {}),
    };
  });
}
