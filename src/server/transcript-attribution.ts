import type { TranscriptMessage } from "@shared/types.ts";
import { delegatedTurnSources, type DelegatedConversation } from "./delegated-turns.ts";
import { originOf } from "./injections.ts";
import { launchPresentationFor, type LaunchTurnMarker } from "./launch-presentation.ts";

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
    const originSession = delegated.sources.get(message.id);
    const live = originOf(sessionId, message.text);
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
    if (!origin && !presentation) return message;
    return {
      ...message,
      ...(origin ? { origin } : {}),
      ...(originSession ? { originSession } : {}),
      ...(presentation ? { presentation } : {}),
    };
  });
}
