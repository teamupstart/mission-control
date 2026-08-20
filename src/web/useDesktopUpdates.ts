import { useCallback, useEffect, useState } from "react";
import type { UpdateSnapshot } from "@shared/update.ts";

type DesktopUpdates = {
  getState(): Promise<UpdateSnapshot>;
  onState(listener: (snapshot: UpdateSnapshot) => void): () => void;
};

export function subscribeToDesktopUpdates(
  updates: DesktopUpdates,
  receive: (snapshot: UpdateSnapshot) => void,
): () => void {
  let active = true;
  let receivedLiveSnapshot = false;
  const unsubscribe = updates.onState((snapshot) => {
    receivedLiveSnapshot = true;
    if (active) receive(snapshot);
  });

  void updates.getState().then((snapshot) => {
    if (active && !receivedLiveSnapshot) receive(snapshot);
  }).catch(() => {});

  return () => {
    active = false;
    unsubscribe();
  };
}

interface DesktopUpdateState {
  snapshot: UpdateSnapshot | null;
  check(): void;
  apply(): void;
  defer(): void;
  dismiss(): void;
}

export function useDesktopUpdates(): DesktopUpdateState {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const updates = window.missionDesktop?.updates;

  useEffect(() => {
    if (!updates) return;
    return subscribeToDesktopUpdates(updates, (next) => {
      setDismissed(false);
      setSnapshot(next);
    });
  }, [updates]);

  const check = useCallback(() => {
    void updates?.check().catch(() => {});
  }, [updates]);
  const apply = useCallback(() => {
    void updates?.apply().catch(() => {});
  }, [updates]);
  const defer = useCallback(() => {
    void updates?.defer().catch(() => {});
  }, [updates]);
  const dismiss = useCallback(() => setDismissed(true), []);

  return { snapshot: dismissed ? null : snapshot, check, apply, defer, dismiss };
}
