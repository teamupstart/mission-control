import { useEffect, useRef, useState } from "react";
import { ShapingIntentSchema, type ShapingConfigView, type ShapingIntent } from "@shared/shaping.ts";
import { api } from "./lib/api.ts";
import { previewShapingIntent, shapingIntentReflected, shapingRefusalText, shapingUnconfirmedText } from "./lib/shaping-settings.ts";
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
  } | null>(null);
  // Every refusal still worth showing, per control, each with the number of the request it
  // answers. The newest is the control's error; any older ones are shown apart from it, so a
  // refusal that arrives late never replaces the reason the latest action failed.
  const [refusals, setRefusals] = useState<Record<string, Refusal[]>>({});
  const writing = useRef<ShapingIntent | null>(null);
  /** The last request sent, so a refusal can tell whether a newer write followed it. */
  const latest = useRef<ShapingIntent | null>(null);
  /** Numbers each request in the order it was sent. */
  const sent = useRef(0);
  /** The last request a stream frame showed stored, for a reply that never arrives. */
  const observed = useRef<ShapingIntent | null>(null);
  useEffect(() => subscribe((config) => {
    const request = writing.current;
    if (!request || !config) return;
    // Keep the receipt even when a peer's later write replaces this config in the same render.
    if (shapingIntentReflected(config, request)) {
      observed.current = request;
      setPending((current) => current?.intent === request ? { ...current, observed: true } : current);
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
    if (!live || pending.observed || (pending.accepted && reflected)) {
      writing.current = null;
      setPending(null);
    } else if (reflected) {
      observed.current = pending.intent;
      setPending((current) => current?.intent === pending.intent ? { ...current, observed: true } : current);
    }
  }, [pending, reflected, live]);

  /**
   * Send one intent. Resolves true when the daemon accepted it, or when its answer was lost but
   * the event stream already showed the change stored.
   */
  const set = async (intent: ShapingIntent, key: string): Promise<boolean> => {
    if (!live || writing.current) return false;
    // The daemon's own schema, so what is drawn is what is sent: a caller identity is trimmed
    // here exactly as it is stored.
    const parsed = ShapingIntentSchema.safeParse(intent);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "This change is not valid.";
      setRefusals((current) => withRefusals(current, key, [{ number: ++sent.current, message }]));
      return false;
    }
    const request = parsed.data;
    const number = ++sent.current;
    writing.current = request;
    latest.current = request;
    // Acting on a control again dismisses what it showed. Every other control keeps its own
    // refusals, and one that arrives late for an earlier write here is still shown, labelled.
    setRefusals((current) => withRefusals(current, key, []));
    setPending({ intent: request, key, accepted: false, observed: false });
    // Bounded, so a daemon that stops answering never leaves every control disabled. On the
    // timeout the optimism goes and the panel shows the stream's config, which is the daemon's.
    const timeout = AbortSignal.timeout(SHAPING_WRITE_TIMEOUT_MS);
    try {
      const result = await api.setShaping(request, { signal: timeout });
      if (!result.ok && result.status === undefined) {
        // No answer at all: the request timed out or the connection failed. That is not the daemon
        // refusing it, so it is never reported as a refusal. When the stream already showed the
        // change stored, the window treats it as saved and says the answer was lost.
        const shown = observed.current === request;
        const cause = timeout.aborted
          ? `The daemon did not answer within ${SHAPING_WRITE_TIMEOUT_MS / 1000} seconds.`
          : "The daemon's answer did not arrive.";
        const message = shapingUnconfirmedText(request, shown, latest.current !== request, cause);
        setRefusals((current) => withRefusals(current, key, [...(current[key] ?? []), { number, message }]));
        if (writing.current === request) {
          writing.current = null;
          setPending(null);
        }
        return shown;
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
      return true;
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
      setRefusals((current) => withRefusals(current, key, [...(current[key] ?? []), { number, message }]));
      if (writing.current === request) {
        writing.current = null;
        setPending(null);
      }
      return false;
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
    /** Older refusals under each control, newest first, that arrived after a newer write went out. */
    earlier: Object.fromEntries(Object.entries(refusals).filter(([, list]) => list.length > 1)
      .map(([key, list]) => [key, list.slice(1).map((refusal) => refusal.message)])),
    ready: live,
    set,
  };
}
export type ShapingSettings = ReturnType<typeof useShapingSettings>;

interface Refusal {
  /** The request it answers, in the order requests were sent. */
  number: number;
  message: string;
}

/** `refusals` with one control's list replaced, newest first, and the control dropped when empty. */
function withRefusals(refusals: Record<string, Refusal[]>, key: string, list: Refusal[]): Record<string, Refusal[]> {
  const { [key]: _replaced, ...rest } = refusals;
  return list.length === 0 ? rest : { ...rest, [key]: [...list].sort((a, b) => b.number - a.number) };
}
