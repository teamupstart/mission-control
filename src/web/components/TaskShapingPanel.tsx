import { useCallback, useEffect, useState } from "react";
import { canonicalJson, type ShapingReferenceStatus } from "@shared/shaping.ts";
import { api, fetchRepos } from "../lib/api.ts";
import type { ShapingSettings } from "../useShapingSettings.ts";
import type { ShapingTestRunner } from "./TaskShapingDialogs.tsx";
import { TaskShapingView } from "./TaskShapingView.tsx";

/**
 * Settings > Task shaping. The config is the event stream's, through `useShapingSettings`, so
 * every window shows a change the moment it commits. The one read here is whether each named
 * environment variable is set, which is a fact about the daemon's environment rather than the
 * config: it is asked again whenever the config changes, and never carries a value.
 */
export function TaskShapingPanel({ state }: { state?: ShapingSettings }): React.JSX.Element {
  const config = state?.config ?? null;
  const ready = state?.ready ?? false;
  const [references, setReferences] = useState<ShapingReferenceStatus>({});
  // The folder's shapers, which the list does not draw yet, so a move keeps their place in the order.
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const configKey = config ? canonicalJson(config) : null;
  useEffect(() => {
    if (!ready || configKey === null) return;
    let current = true;
    void api.getShaping().then((reply) => {
      if (!current || !reply.ok) return;
      if (reply.references) setReferences(reply.references);
      if (Array.isArray(reply.discovered)) setDiscovered(reply.discovered.map((entry) => entry.id));
    });
    return () => { current = false; };
  }, [ready, configKey]);
  const onTest = useCallback<ShapingTestRunner>((request, signal) => api.testShaper(request, signal), []);
  const repositories = useCallback(() => fetchRepos(), []);
  return (
    <TaskShapingView
      config={config}
      references={references}
      pending={state?.pending ?? null}
      errors={state?.errors ?? {}}
      ready={ready}
      onSet={(intent, key) => state ? state.set(intent, key) : Promise.resolve(false)}
      onTest={onTest}
      repositories={repositories}
      live={discovered}
    />
  );
}
