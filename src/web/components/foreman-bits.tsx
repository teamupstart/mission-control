import { useState } from "react";
import type { Session, SessionNoteSummary } from "@shared/types.ts";
import {
  allowlistSuggestion,
  approveForemanRecommendation,
  closeForemanNote,
  deliveryTarget,
  sessionSendBlock,
  undeliverable,
} from "../lib/foreman.ts";
import type { DeliveryTarget } from "../lib/foreman.ts";
import { api } from "../lib/api.ts";

// The parts both live Foreman surfaces need: the Approve/Dismiss machinery, and the
// line explaining why a draft is asking rather than having been sent.
//
// Shared for the reason `closeForemanNote` is. The grid card and the console strip
// render a note very differently - one is a panel inside a card, the other a pinned
// one-liner - but they offer the SAME two decisions on the same record, and a second
// copy of "what Approve does" is a second place for the stale-review rule to drift.
// What differs between them is layout, which is what each file keeps.

/**
 * Approve / Dismiss for one note, with the in-flight and just-acted state they share.
 *
 * `done` bridges the gap between the write landing and the server telling us about
 * it over SSE, so the human doesn't see the controls they just used sitting there
 * unchanged. It is keyed to the MARKER it closed rather than being a bare boolean,
 * which is the difference between "I have answered this" and "I have answered
 * something, once, ever": these surfaces are mounted per session and outlive any one
 * note, so a latch that never resets silently swallows every LATER escalation on the
 * same session - in the strip, which renders nothing at all when done, that left the
 * console with no Approve control until the human navigated away and back.
 *
 * `undefined` is the initial state rather than null, because null is a real marker
 * value (a note from a path that stamps none) and has to be latchable too.
 */
export function useForemanDecision(o: {
  sessionId: string;
  note: SessionNoteSummary;
  /** A pending `input` review id, used only when the draft carries no marker. */
  inputReviewId: string | null;
  /** Live pending review ids, so a draft for a since-resolved review reads as stale. */
  pendingReviewIds?: ReadonlySet<string>;
  /** Whether the session has a pane to type into; see `deliveryTarget`. */
  canSend?: boolean;
}): {
  busy: boolean;
  done: boolean;
  /** Where an Approve would go - the surfaces render their controls from this. */
  target: DeliveryTarget;
  /** The sentence explaining an undeliverable note, or null when it can be sent. */
  blocked: string | null;
  approve: () => Promise<void>;
  dismiss: () => Promise<void>;
} {
  const { sessionId, note, inputReviewId, pendingReviewIds, canSend } = o;
  const [busy, setBusy] = useState(false);
  const [handled, setHandled] = useState<string | null | undefined>(undefined);

  const done = handled !== undefined && handled === note.handledMarker;
  // Resolved once, here, and both returned for rendering and used by `approve` below, so
  // the button a surface draws and the act it performs cannot disagree.
  const target = deliveryTarget({
    handledMarker: note.handledMarker,
    inputReviewId,
    pendingReviewIds,
    canSend,
  });

  async function dismiss(): Promise<void> {
    setBusy(true);
    // No sent text: dismissing decides the episode without answering the child.
    await closeForemanNote(api, sessionId, {
      marker: note.handledMarker,
      disposition: "skipped",
      lastAction: "dismissed by you",
      sentText: null,
    });
    setHandled(note.handledMarker);
    setBusy(false);
  }

  async function approve(): Promise<void> {
    if (!note.recommendation) return;
    // Kept as a guard even though no surface now draws an Approve for an undeliverable
    // note: the target is recomputed from live props, so a review can resolve between the
    // render and the click. Closing the note (rather than sending it somewhere else) is
    // the same rule `deliveryTarget` documents.
    if (target.kind === "stale" || target.kind === "no-channel") {
      await dismiss();
      return;
    }
    setBusy(true);
    const res = await approveForemanRecommendation(api, sessionId, target, {
      marker: note.handledMarker,
      recommendation: note.recommendation,
    });
    if (res.ok) {
      setHandled(note.handledMarker);
    }
    setBusy(false);
  }

  return { busy, done, target, blocked: undeliverable(target), approve, dismiss };
}

/**
 * Why this draft is asking for an OK instead of having been sent.
 *
 * Every case gets a line, including - especially - live mode. This used to render
 * only when `mode !== "live"`, on the theory that a live draft was impossible; but
 * live mode is necessary and not sufficient (the repo must be allowlisted too), so
 * the ONE state where the human is most owed an explanation - "I turned live on and
 * it's still asking me" - was the exact state that silently rendered nothing. The
 * work-queue panel had said this all along; the note is where the human actually
 * clicks Approve, so it has to say it too.
 */
export function DraftHint({
  session,
  mode,
  enabled,
  allowlist,
}: {
  session: Session;
  mode: string;
  enabled: boolean;
  allowlist: string[] | undefined;
}): React.JSX.Element {
  switch (sessionSendBlock(session, { enabled, mode, allowlist })) {
    case "foreman-off":
      return (
        <p className="fn-hint dim">
          Foreman is off, so it won&apos;t send this - Approve to send it yourself.
        </p>
      );
    case "not-allowlisted":
      return (
        <p className="fn-hint dim">
          Foreman is in live mode, but this session&apos;s repo isn&apos;t allowlisted for live
          sends - so it drafted this for your OK. Add <code>{allowlistSuggestion(session)}</code> to
          Foreman&apos;s allowlist to let it send here.
        </p>
      );
    case "no-cwd":
      return (
        <p className="fn-hint dim">
          Foreman can&apos;t tell which directory this session is in, so it can&apos;t match the
          allowlist - it drafted this for your OK rather than sending it.
        </p>
      );
    default:
      return (
        <p className="fn-hint dim">
          Draft only - Foreman won&apos;t send this automatically. Use Approve to send it.
        </p>
      );
  }
}
