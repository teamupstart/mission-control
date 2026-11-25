import { useSyncExternalStore } from "react";
import { SETTINGS_REFRESH_DOMAINS, type SettingsRefreshDomain } from "@shared/session-settings-metadata.ts";

const revisions = new Map<SettingsRefreshDomain, number>();
const listeners = new Set<() => void>();

export function invalidateSettingsConfig(domain?: SettingsRefreshDomain): void {
  for (const key of domain ? [domain] : SETTINGS_REFRESH_DOMAINS) {
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSettingsConfigRevision(domain: SettingsRefreshDomain): number {
  const snapshot = () => revisions.get(domain) ?? 0;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
