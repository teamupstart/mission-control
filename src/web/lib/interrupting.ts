import { useSyncExternalStore } from "react";
import { agentActive } from "@shared/session.ts";
import type { Session } from "@shared/types.ts";

// The optimistic "interrupting" moment, and nothing else.
//
// A stop is asked for and then WAITED for, and the wait is the reason this exists: the
// operator presses the key, the card keeps saying "working", and without a reading in
// between there is nothing to distinguish "the request is in flight" from "the key did
// nothing". The embedded runtime answers in milliseconds; the pane path, which the next
// phase adds, cannot be confirmed at all - an `Escape` written into a terminal reports
// nothing back - so the presentation has to be able to stand on its own for a moment and
// then give up.
//
// CLIENT-SIDE, deliberately. The obvious alternative is a new `SessionState` member, and it
// is the expensive one: that union is a wire contract with exhaustive records over it in
// `session-contracts.test.ts`, the tone map, the board columns and the console rail, and
// every one of them would gain an arm to describe a state that lasts a second and that no
// other client would ever be told about. The existing `stopping` is close and means
// something else - eviction is coming - which is a promise this must not make.
//
// A module store rather than App state for the reason `drafts.ts` and `uiConfig.ts` are
// ones: the four surfaces that draw a session's badge sit at four different depths, and
// prop-drilling a transient flag to all of them would put this in every layout's signature.

/**
 * How long the optimistic state survives with no reading to confirm it.
 *
 * Long enough that a slow driver still resolves it honestly, short enough that a card is
 * never left describing a stop that did not happen - it times out back to whatever the
 * session actually says, which for a failed interrupt is "working", which is the truth.
 */
const INTERRUPTING_TIMEOUT_MS = 6_000;

let interrupting: ReadonlySet<string> = new Set();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(next: ReadonlySet<string>): void {
  interrupting = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether this session is presenting as interrupting right now. For non-hook readers. */
export function isInterrupting(id: string): boolean {
  return interrupting.has(id);
}

/** Show the optimistic state, and arm the backstop that takes it away unaided. */
export function markInterrupting(id: string): void {
  const existing = timers.get(id);
  if (existing) clearTimeout(existing);
  timers.set(
    id,
    setTimeout(() => clearInterrupting(id), INTERRUPTING_TIMEOUT_MS),
  );
  if (interrupting.has(id)) return;
  emit(new Set([...interrupting, id]));
}

/** Take it away, whichever of the two things ended it. */
export function clearInterrupting(id: string): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!interrupting.has(id)) return;
  const next = new Set(interrupting);
  next.delete(id);
  emit(next);
}

/**
 * Resolve the optimistic state against a real reading of the session.
 *
 * The first `session_upsert` reporting that the agent has stopped IS the confirmation, so
 * the transient presentation hands over to the durable one with no gap. Upserts that still
 * report work in progress are left alone - they arrive constantly, and clearing on any of
 * them would blink the state out a frame after it appeared.
 */
export function reconcileInterrupting(session: Session): void {
  if (!interrupting.has(session.id)) return;
  if (!agentActive(session)) clearInterrupting(session.id);
}

/** Drop a removed session's flag, so a reused id cannot inherit it. */
export function dropInterrupting(id: string): void {
  clearInterrupting(id);
}

/** Live view for one session's badge. */
export function useInterrupting(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => interrupting.has(id),
    () => false,
  );
}
