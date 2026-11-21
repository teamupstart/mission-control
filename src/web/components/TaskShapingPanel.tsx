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
  // Keyed on the config the stream confirmed, not the optimistic one: an import is drawn before
  // it commits, and a read taken then knows nothing of the variables it names. The confirming
  // frame changes this key, so the status is read again once the daemon holds the import.
  const confirmed = state?.confirmed ?? null;
  const configKey = confirmed ? canonicalJson(confirmed) : null;
  useEffect(() => {
    if (!ready || configKey === null) return;
    let current = true;
    void api.getShaping().then((reply) => {
      if (current && reply.ok && reply.references) setReferences(reply.references);
    });
    return () => { current = false; };
  }, [ready, configKey]);
  // The folder's shapers, read when a removal is confirmed, so the confirmation can say a folder
  // shaper with the same id stays switched off. Null when the read fails.
  const readFolderIds = useCallback(async (): Promise<string[] | null> => {
    const reply = await api.getShaping();
    return reply.ok && Array.isArray(reply.discovered) ? reply.discovered.map((entry) => entry.id) : null;
  }, []);
  const onTest = useCallback<ShapingTestRunner>((request, signal) => api.testShaper(request, signal), []);
  const repositories = useCallback(() => fetchRepos(), []);
  return (
    <TaskShapingView
      config={config}
      references={references}
      pending={state?.pending ?? null}
      errors={state?.errors ?? {}}
      earlier={state?.earlier ?? {}}
      outcomeArrivals={state?.outcomeArrivals ?? {}}
      outcomeSubjects={state?.outcomeSubjects ?? {}}
      locked={state?.locked}
      onDismiss={state?.dismiss}
      ready={ready}
      onSet={(intent, key) => state ? state.set(intent, key) : Promise.resolve("not_sent" as const)}
      onTest={onTest}
      repositories={repositories}
      readFolderIds={readFolderIds}
    />
  );
}
