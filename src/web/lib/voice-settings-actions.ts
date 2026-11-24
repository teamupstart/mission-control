import { useSyncExternalStore } from "react";
import type { VoiceIndicatorId } from "@shared/voice.ts";
import { api } from "./api.ts";
import { updateVoiceIndicator } from "./uiConfig.ts";

// Each dashboard window owns its outstanding actions. The selection still comes from
// uiConfig, and utterances are read and held only by the mounted Recently heard table.
interface VoiceSettingsActions {
  saving: { id: VoiceIndicatorId; enabled: boolean } | null;
  indicatorError: string;
  clearing: boolean;
  clearError: string;
}

let actions: VoiceSettingsActions = { saving: null, indicatorError: "", clearing: false, clearError: "" };
const listeners = new Set<() => void>();

function publish(patch: Partial<VoiceSettingsActions>): void {
  actions = { ...actions, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => actions;
export function useVoiceSettingsActions(): VoiceSettingsActions {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export async function saveIndicatorSelection(id: VoiceIndicatorId, enabled: boolean): Promise<void> {
  if (actions.saving) return;
  publish({ saving: { id, enabled }, indicatorError: "" });
  const result = await updateVoiceIndicator(id, enabled);
  const errors = {
    saved: "",
    failed: "Could not save the indicator selection.",
    unconfirmed: "The indicator save timed out and could not be confirmed. Check the selection and retry if needed.",
  };
  publish({ saving: null, indicatorError: errors[result] });
}

export async function clearVoiceHistory(): Promise<boolean> {
  if (actions.clearing) return false;
  publish({ clearing: true });
  const deadline = AbortSignal.timeout(5000);
  const result = await api.clearRecentlyHeard(deadline);
  const error = deadline.aborted ? "Clear timed out. Deletion is unconfirmed. Check the history and retry."
    : result.ok ? "" : result.error ?? "Could not clear recent utterances.";
  publish({ clearing: false, clearError: error });
  return result.ok && !deadline.aborted;
}
