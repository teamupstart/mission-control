import { useCallback, useEffect, useState } from "react";
import { canonicalJson, type DiscoveredShaper, type ShapingFolderStatus, type ShapingIntent, type ShapingReferenceStatus } from "@shared/shaping.ts";
import type { ShapingWriteOutcome } from "../lib/shaping-settings.ts";
import { api, fetchRepos } from "../lib/api.ts";
import type { ShapingSettings } from "../useShapingSettings.ts";
import type { ShapingTestRunner } from "./TaskShapingDialogs.tsx";
import { TaskShapingView } from "./TaskShapingView.tsx";

/**
 * Settings > Task shaping. The config is the event stream's, through `useShapingSettings`, so
 * every window shows a change the moment it commits. The one read here is of facts about the
 * daemon's machine rather than the config: whether each named environment variable is set, never
 * a value, and what the shapers folder holds. It is asked again whenever the config changes.
 */
export function TaskShapingPanel({ state }: { state?: ShapingSettings }): React.JSX.Element {
  const config = state?.config ?? null;
  const ready = state?.ready ?? false;
  const [references, setReferences] = useState<ShapingReferenceStatus>({});
  // The shapers folder, as the daemon's scan reported it. Read when Settings opens and again
  // whenever the config changes, since a stored choice changes what each row shows.
  const [discovered, setDiscovered] = useState<readonly DiscoveredShaper[]>([]);
  const [folder, setFolder] = useState<ShapingFolderStatus | null>(null);
  // Keyed on the config the stream confirmed, not the optimistic one: an import is drawn before
  // it commits, and a read taken then knows nothing of the variables it names. The confirming
  // frame changes this key, so the status is read again once the daemon holds the import.
  const confirmed = state?.confirmed ?? null;
  const configKey = confirmed ? canonicalJson(confirmed) : null;
  // A refused write changes no config, yet a folder shaper's refusal says its manifest changed on
  // disk. So every write that settles, whatever its outcome, counts one more folder read: the row
  // then shows what is on disk now, and the operator's next click names that manifest.
  const [settledWrites, setSettledWrites] = useState(0);
  const set = useCallback(async (intent: ShapingIntent, key: string): Promise<ShapingWriteOutcome> => {
    if (!state) return "not_sent";
    const outcome = await state.set(intent, key);
    if (outcome !== "not_sent") setSettledWrites((count) => count + 1);
    return outcome;
  }, [state]);
  useEffect(() => {
    if (!ready || configKey === null) return;
    let current = true;
    void api.getShaping().then((reply) => {
      if (!current || !reply.ok) return;
      if (reply.references) setReferences(reply.references);
      setDiscovered(Array.isArray(reply.discovered) ? reply.discovered : []);
      setFolder(reply.folder ?? null);
    });
    return () => { current = false; };
  }, [ready, configKey, settledWrites]);
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
      awaitingRevision={state?.awaitingRevision}
      onDismiss={state?.dismiss}
      ready={ready}
      onSet={set}
      onTest={onTest}
      repositories={repositories}
      readFolderIds={readFolderIds}
      discovered={discovered}
      folder={folder}
    />
  );
}
