import { useEffect, useRef, useState } from "react";
import { ShapingIntentSchema, shapingWriteOrder, type ShapingConfigView, type ShapingIntent } from "@shared/shaping.ts";
import { api } from "./lib/api.ts";
import {
  previewShapingIntent,
  shapingIntentReflected,
  shapingIntentSuperseded,
  shapingLockKeys,
  shapingRefusalText,
  shapingUnconfirmedText,
  type ShapingWriteOutcome,
} from "./lib/shaping-settings.ts";
import type { MissionState } from "./useEventStream.ts";

/** How long one write may wait for the daemon's answer before the panel stops waiting. */
export const SHAPING_WRITE_TIMEOUT_MS = 15_000;

/**
 * Task shaping's settings: the confirmed config view from the event stream, one write at a time,
 * and a click drawn at once. Built the way `useFeatureFlagsSettings` is: optimism is temporary,
 * the event stream remains the only confirmed state, and a refused write rolls back and leaves
 * its reason under the control that sent it.
 *
 * `confirmed` is null before the first snapshot and whenever the `task-shaping` flag is off.
 */
export function useShapingSettings(
  confirmed: ShapingConfigView | null,
  ready: boolean,
  subscribe: MissionState["subscribeShaping"],
) {
  const [pending, setPending] = useState<{
    intent: ShapingIntent;
    /** Which control sent it, so its error lands there. */
    key: string;
    accepted: boolean;
    observed: boolean;
    /** A frame showed the definition it was sent for replaced: nothing waits on it any more. */
    superseded: boolean;
  } | null>(null);
  // Every refusal still worth showing, per control, each with the number of the request it
  // answers. The newest is the control's error; any older ones are shown apart from it, so a
  // refusal that arrives late never replaces the reason the latest action failed.
  const [refusals, setRefusals] = useState<Record<string, Refusal[]>>({});
  // The controls with a request still awaiting its HTTP answer. A frame can free the panel before
  // that answer, but the same control stays locked until it arrives: a second write on it could
  // otherwise be answered first and then undone by the first, as a switch on that the daemon
  // applies after a newer switch off, since a switch keeps the revision it was checked against.
  const [locked, setLocked] = useState<ReadonlySet<string>>(new Set());
  const lockedNow = useRef(new Set<string>());
  const lock = (keys: readonly string[], held: boolean): void => {
    for (const key of keys) {
      if (held) lockedNow.current.add(key);
      else lockedNow.current.delete(key);
    }
    setLocked(new Set(lockedNow.current));
  };
  const writing = useRef<ShapingIntent | null>(null);
  /** The last request sent, so a refusal can tell whether a newer write followed it. */
  const latest = useRef<ShapingIntent | null>(null);
  /** Numbers each request in the order it was sent. */
  const sent = useRef(0);
  /** This window's id for the daemon's write ordering: a newer write from it is never overwritten. */
  const windowId = useRef(newWindowId());
  /** Numbers each outcome in the order it arrived, whichever request it answers. */
  const arrivals = useRef(0);
  /**
   * Every request a stream frame showed stored, kept per request until its HTTP result settles:
   * a newer write must not erase an earlier one's receipt before that one's reply is lost.
   */
  const observed = useRef(new WeakSet<ShapingIntent>());
  useEffect(() => subscribe((config) => {
    const request = writing.current;
    if (!request || !config) return;
    // Keep the receipt even when a peer's later write replaces this config in the same render.
    if (shapingIntentReflected(config, request)) {
      observed.current.add(request);
      setPending((current) => current?.intent === request ? { ...current, observed: true } : current);
    } else if (shapingIntentSuperseded(config, request)) {
      // No receipt: the daemon will refuse it. But it can no longer affect what is stored, so the
      // panel is released for the next edit rather than held until the answer or the timeout.
      setPending((current) => current?.intent === request ? { ...current, superseded: true } : current);
    }
  }), [subscribe]);
  const optimistic = pending && confirmed ? previewShapingIntent(confirmed, pending.intent) : null;
  const reflected = pending !== null && confirmed !== null && shapingIntentReflected(confirmed, pending.intent);
  const live = ready && confirmed !== null;
  useEffect(() => {
    if (!pending || writing.current !== pending.intent) return;
    // A frame showing the write is the confirmation: the panel takes the next edit at once rather
    // than waiting on an HTTP answer that may be slow. Either order is valid, and once observed,
    // later peer writes remain authoritative.
    if (!live || pending.observed || pending.superseded || (pending.accepted && reflected)) {
      writing.current = null;
      setPending(null);
    }
    // Never a receipt from the config already confirmed when the write went out: an import that
    // matches what is stored is "reflected" before any frame. Only a frame that arrives after the
    // request, through the subscription above, counts as the stream showing it stored.
  }, [pending, reflected, live]);

  /**
   * Send one intent. Resolves "saved" only when the daemon's answer accepted it. A stream frame that
   * shows the change frees the controls early, but it is no acknowledgment of this request: the
   * same state can come from another write, or have been stored before this one went out.
   */
  const set = async (intent: ShapingIntent, key: string): Promise<ShapingWriteOutcome> => {
    const keys = shapingLockKeys(intent, key, confirmed);
    if (!live || writing.current || keys.some((held) => lockedNow.current.has(held))) return "not_sent";
    // The daemon's own schema, so what is drawn is what is sent: a caller identity is trimmed
    // here exactly as it is stored.
    const parsed = ShapingIntentSchema.safeParse(intent);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "This change is not valid.";
      setRefusals((current) => withRefusals(current, key, [{ number: ++sent.current, arrived: ++arrivals.current, message, subject: intentSubject(intent) }]));
      return "refused";
    }
    const request = parsed.data;
    lock(keys, true);
    const number = ++sent.current;
    writing.current = request;
    latest.current = request;
    // Acting on a control again dismisses what it showed. Every other control keeps its own
    // refusals, and one that arrives late for an earlier write here is still shown, labelled.
    setRefusals((current) => withRefusals(current, key, []));
    setPending({ intent: request, key, accepted: false, observed: false, superseded: false });
    // Bounded, so a daemon that stops answering never leaves every control disabled. On the
    // timeout the optimism goes and the panel shows the stream's config, which is the daemon's.
    const timeout = AbortSignal.timeout(SHAPING_WRITE_TIMEOUT_MS);
    try {
      const result = await api.setShaping(request, { signal: timeout, order: shapingWriteOrder(windowId.current, number, keys) });
      if (!result.ok && result.status === undefined) {
        // No answer at all: the request timed out or the connection failed. That is not the daemon
        // refusing it, so it is never reported as a refusal, nor as saved: only the daemon's answer
        // ties an outcome to this request. When a frame showed the change stored, the message says
        // so, in the past tense, and leaves deciding to the operator.
        const shown = observed.current.has(request);
        const cause = timeout.aborted
          ? `The daemon did not answer within ${SHAPING_WRITE_TIMEOUT_MS / 1000} seconds.`
          : "The daemon's answer did not arrive.";
        const message = shapingUnconfirmedText(request, shown, latest.current !== request, cause);
        setRefusals((current) => withRefusals(current, key, [...(current[key] ?? []), { number, arrived: ++arrivals.current, message, subject: intentSubject(request) }]));
        if (writing.current === request) {
          writing.current = null;
          setPending(null);
        }
        return "unconfirmed";
      }
      if (!result.ok) {
        throw new Error(result.reason ?? result.error ?? "Could not save task shaping.");
      }
      if (writing.current === request) {
        if (result.config && !shapingIntentReflected(result.config, request)) {
          // The daemon accepted it and answered with a config that does not show it the way this
          // window expected. Its answer is the truth: stop waiting for a frame that will not come.
          writing.current = null;
          setPending(null);
        } else {
          setPending((current) => current && { ...current, accepted: true });
        }
      }
      // A later write on this control succeeded, so an earlier one's refusal no longer describes
      // it. A refusal of a request sent after this one is still news and stays.
      setRefusals((current) => withRefusals(current, key, (current[key] ?? []).filter((refusal) => refusal.number > number)));
      return "saved";
    } catch (error) {
      // The HTTP result decides whether this write succeeded. A frame can free the controls
      // early, but it only shows a config that looks like the outcome: a peer may have written it,
      // say by replacing and enabling the shaper this request named, while the daemon refused this
      // request with `shaper_changed`. So a refusal is always shown, even after a frame freed the
      // panel, and never reported as saved. A frame that freed the panel early also lets a newer
      // write go out first; this refusal is then the earlier action's, and says so, rather than
      // reading as the outcome of the change just made under the same control.
      const reason = error instanceof Error ? error.message : String(error);
      const message = shapingRefusalText(request, reason, latest.current !== request);
      setRefusals((current) => withRefusals(current, key, [...(current[key] ?? []), { number, arrived: ++arrivals.current, message, subject: intentSubject(request) }]));
      if (writing.current === request) {
        writing.current = null;
        setPending(null);
      }
      return "refused";
    } finally {
      lock(keys, false);
    }
  };

  return {
    config: pending && !pending.observed && optimistic ? optimistic : confirmed,
    /** The daemon's config as the event stream last confirmed it, without this window's optimism. */
    confirmed,
    pending: pending?.intent ?? null,
    pendingKey: pending?.key ?? null,
    /** Each control's newest refusal: the reason its latest refused action failed. */
    errors: Object.fromEntries(Object.entries(refusals).map(([key, list]) => [key, list[0]!.message])),
    /** Older outcomes under each control, newest first: refusals, and writes whose answer was lost. */
    earlier: Object.fromEntries(Object.entries(refusals).filter(([, list]) => list.length > 1)
      .map(([key, list]) => [key, list.slice(1).map((refusal) => refusal.message)])),
    /**
     * When each control's latest outcome arrived, by arrival order: a view that records it can tell
     * an outcome that arrived after that moment from one it already showed, whatever its text and
     * whichever request it answers, an earlier one arriving late included.
     */
    outcomeArrivals: Object.fromEntries(Object.entries(refusals)
      .map(([key, list]) => [key, Math.max(...list.map((refusal) => refusal.arrived))])),
    /** The shaper each control's newest outcome was for, when its write named one. */
    outcomeSubjects: Object.fromEntries(Object.entries(refusals).flatMap(([key, list]) => list[0]!.subject === null ? [] : [[key, list[0]!.subject]])),
    /** Controls whose request still awaits its HTTP answer: each takes no new write until it arrives. */
    locked,
    ready: live,
    set,
    /** Clear every outcome shown under one control, as the operator's own dismissal. */
    dismiss: (key: string) => setRefusals((current) => withRefusals(current, key, [])),
  };
}
export type ShapingSettings = ReturnType<typeof useShapingSettings>;

/** A random id for one window's hook, as the write-order header accepts it. */
function newWindowId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

interface Refusal {
  /** The request it answers, in the order requests were sent. */
  number: number;
  /** When it arrived, in the order outcomes arrived. */
  arrived: number;
  message: string;
  /** The shaper the write was for, when it names one. */
  subject: string | null;
}

/** The shaper an intent writes, when it names one: what an outcome shown elsewhere is about. */
function intentSubject(intent: ShapingIntent): string | null {
  if (intent.kind === "upsert") return typeof (intent.shaper as { id?: unknown }).id === "string" ? (intent.shaper as { id: string }).id : null;
  return "id" in intent ? intent.id : null;
}

/** `refusals` with one control's list replaced, newest first, and the control dropped when empty. */
function withRefusals(refusals: Record<string, Refusal[]>, key: string, list: Refusal[]): Record<string, Refusal[]> {
  const { [key]: _replaced, ...rest } = refusals;
  return list.length === 0 ? rest : { ...rest, [key]: [...list].sort((a, b) => b.number - a.number) };
}
