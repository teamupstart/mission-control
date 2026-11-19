import { useContext } from "react";
import { FEATURE_FLAGS } from "@shared/feature-flag-registry.ts";
import { FeatureFlagsContext } from "../useFeatureFlag.ts";
import type { FeatureFlagsSettings } from "../useFeatureFlagsSettings.ts";
import { FeatureFlagsView } from "./FeatureFlagsView.tsx";

export function FeatureFlagsPanel({ state, jumpAnchor }: { state?: FeatureFlagsSettings; jumpAnchor?: string }): React.JSX.Element {
  const confirmed = useContext(FeatureFlagsContext);
  return <FeatureFlagsView definitions={FEATURE_FLAGS} config={state?.config ?? confirmed}
    pending={state?.pending} errors={state?.errors} ready={state?.ready ?? false}
    onSet={intent => { void state?.set(intent); }} jumpAnchor={jumpAnchor} />;
}
