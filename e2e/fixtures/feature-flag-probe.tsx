import { useFeatureFlag } from "../../src/web/useFeatureFlag.ts";
import type { FeatureFlagId } from "../../src/shared/feature-flags.ts";

/** Mounted beneath App's real provider only in the private fixture build. */
export function FeatureFlagProbe() {
  const enabled = useFeatureFlag("fixture-preview" as FeatureFlagId);
  return <output aria-label="Resolved preview flag"
    style={{ position: "fixed", bottom: 48, left: 8, zIndex: 100000, padding: 12,
      background: "white", color: "black", fontFamily: "monospace" }}>
    {String(enabled)}
  </output>;
}
