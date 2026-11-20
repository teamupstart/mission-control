import { useEffect, useRef, useState } from "react";
import { ShapingIntentSchema, type ShapingConfigView, type ShapingIntent } from "@shared/shaping.ts";
import { api } from "./lib/api.ts";
import { previewShapingIntent, shapingIntentReflected, shapingRefusalText } from "./lib/shaping-settings.ts";
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const writing = useRef<ShapingIntent | null>(null);
  /** The last request sent, so a refusal can tell whether a newer write followed it. */
  const latest = useRef<ShapingIntent | null>(null);
  useEffect(() => subscribe((config) => {
    const request = writing.current;
    if (!request || !config) return;
    // Keep the receipt even when a peer's later write replaces this config in the same render.
    if (shapingIntentReflected(config, request)) {
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
      setPending((current) => current?.intent === pending.intent ? { ...current, observed: true } : current);
    }
  }, [pending, reflected, live]);

  /** Send one intent. Resolves true when the daemon accepted it. */
  const set = async (intent: ShapingIntent, key: string): Promise<boolean> => {
    if (!live || writing.current) return false;
    // The daemon's own schema, so what is drawn is what is sent: a caller identity is trimmed
    // here exactly as it is stored.
    const parsed = ShapingIntentSchema.safeParse(intent);
    if (!parsed.success) {
      setErrors({ [key]: parsed.error.issues[0]?.message ?? "This change is not valid." });
      return false;
    }
    const request = parsed.data;
    writing.current = request;
    latest.current = request;
    setErrors({});
    setPending({ intent: request, key, accepted: false, observed: false });
    // Bounded, so a daemon that stops answering never leaves every control disabled. On the
    // timeout the optimism goes and the panel shows the stream's config, which is the daemon's.
    const timeout = AbortSignal.timeout(SHAPING_WRITE_TIMEOUT_MS);
    try {
      const result = await api.setShaping(request, { signal: timeout });
      if (!result.ok) {
        throw new Error(timeout.aborted
          ? `The daemon did not answer within ${SHAPING_WRITE_TIMEOUT_MS / 1000} seconds. This shows its current settings; make the change again if it is missing.`
          : result.reason ?? result.error ?? "Could not save task shaping.");
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
      setErrors((current) => ({ ...current, [key]: message }));
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
    errors,
    ready: live,
    set,
  };
}
export type ShapingSettings = ReturnType<typeof useShapingSettings>;
