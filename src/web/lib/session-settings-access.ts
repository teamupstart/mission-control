const listeners = new Set<() => void>();

/** Only open Trust panels need to read the preference after an event or reconnect. */
export function onSessionSettingsAccessChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function invalidateSessionSettingsAccess(): void {
  for (const listener of listeners) listener();
}
