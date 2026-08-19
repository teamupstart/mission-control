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
