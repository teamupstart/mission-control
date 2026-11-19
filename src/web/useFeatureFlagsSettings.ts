import { useEffect, useRef, useState } from "react";
import { applyFeatureFlagIntent, sameFeatureFlagsConfig, type FeatureFlagIntent, type FeatureFlagsConfig } from "@shared/feature-flags.ts";
import { api } from "./lib/api.ts";

/** Optimism is temporary; the event stream remains the only confirmed state. */
export function useFeatureFlagsSettings(confirmed: FeatureFlagsConfig, ready: boolean) {
  const [pending, setPending] = useState<{
    intent: FeatureFlagIntent;
    accepted: boolean;
    observed: boolean;
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const writing = useRef<FeatureFlagIntent | null>(null);
  const optimistic = pending ? applyFeatureFlagIntent(confirmed, pending.intent) : null;
  const reflected = optimistic?.ok === true && sameFeatureFlagsConfig(confirmed, optimistic.config);
  useEffect(() => {
    if (!pending || writing.current !== pending.intent) return;
    // Either response order is valid. Once observed, later peer choices remain authoritative.
    if (!ready || (pending.accepted && (pending.observed || reflected))) {
      writing.current = null;
      setPending(null);
    } else if (reflected && !pending.observed) {
      setPending(current => current?.intent === pending.intent ? { ...current, observed: true } : current);
    }
  }, [pending, reflected, ready]);
  const set = async (intent: FeatureFlagIntent) => {
    if (!ready || writing.current) return;
    const request = { ...intent };
    writing.current = request;
    const key = intent.kind === "master" ? "enable-all" : intent.id;
    setErrors({});
    setPending({ intent: request, accepted: false, observed: false });
    try {
      const result = await api.setFeatureFlags(intent);
      if (!result.ok) throw new Error(result.error ?? "Could not update feature flags.");
      if (writing.current === request) setPending(current => current && { ...current, accepted: true });
    } catch (error) {
      // A disconnect cancels local optimism; a late response must not revive that request.
      if (writing.current !== request) return;
      setErrors({ [key]: error instanceof Error ? error.message : String(error) });
      writing.current = null;
      setPending(null);
    }
  };
  return { config: pending && !pending.observed && optimistic?.ok ? optimistic.config : confirmed,
    pending: pending?.intent ?? null, errors, ready, set };
}
export type FeatureFlagsSettings = ReturnType<typeof useFeatureFlagsSettings>;
