import { useEffect, useRef, useState } from "react";
import { ShapingIntentSchema, type ShapingConfigView, type ShapingIntent } from "@shared/shaping.ts";
import { api } from "./lib/api.ts";
import { previewShapingIntent, shapingIntentReflected } from "./lib/shaping-settings.ts";
import type { MissionState } from "./useEventStream.ts";

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
    // Either response order is valid. Once observed, later peer writes remain authoritative.
    if (!live || (pending.accepted && (pending.observed || reflected))) {
      writing.current = null;
      setPending(null);
    } else if (reflected && !pending.observed) {
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
    setErrors({});
    setPending({ intent: request, key, accepted: false, observed: false });
    try {
      const result = await api.setShaping(request);
      if (!result.ok) throw new Error(result.reason ?? result.error ?? "Could not save task shaping.");
      if (writing.current === request) setPending((current) => current && { ...current, accepted: true });
      return true;
    } catch (error) {
      // A disconnect cancels local optimism; a late response must not revive that request.
      if (writing.current !== request) return false;
      setErrors({ [key]: error instanceof Error ? error.message : String(error) });
      writing.current = null;
      setPending(null);
      return false;
    }
  };

  return {
    config: pending && !pending.observed && optimistic ? optimistic : confirmed,
    pending: pending?.intent ?? null,
    pendingKey: pending?.key ?? null,
    errors,
    ready: live,
    set,
  };
}
export type ShapingSettings = ReturnType<typeof useShapingSettings>;
