import { useRef, useState } from "react";
import { applyFeatureFlagIntent, type FeatureFlagIntent, type FeatureFlagsConfig } from "@shared/feature-flags.ts";
import { api } from "./lib/api.ts";

/** Optimism is temporary; the event stream remains the only confirmed state. */
export function useFeatureFlagsSettings(confirmed: FeatureFlagsConfig, ready: boolean) {
  const [pending, setPending] = useState<FeatureFlagIntent | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const writing = useRef(false);
  const optimistic = pending ? applyFeatureFlagIntent(confirmed, pending) : null;
  const set = async (intent: FeatureFlagIntent) => {
    if (!ready || writing.current) return;
    writing.current = true;
    const key = intent.kind === "master" ? "enable-all" : intent.id;
    setErrors({});
    setPending(intent);
    try {
      const result = await api.setFeatureFlags(intent);
      if (!result.ok) throw new Error(result.error ?? "Could not update feature flags.");
    } catch (error) {
      setErrors({ [key]: error instanceof Error ? error.message : String(error) });
    } finally {
      writing.current = false;
      setPending(null);
    }
  };
  return { config: optimistic?.ok ? optimistic.config : confirmed, pending, errors, ready, set };
}
export type FeatureFlagsSettings = ReturnType<typeof useFeatureFlagsSettings>;
