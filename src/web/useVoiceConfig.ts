import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyVoiceConfigPatch, type VoiceConfig, type VoiceConfigPatch, type VoiceInputDevice } from "@shared/voice.ts";
import type { VoiceDecisionKeyReport, VoiceKeyProvider } from "@shared/voice-decide.ts";
import { api, fetchVoiceConfig, fetchVoiceDecisionKey, fetchVoiceDevices } from "./lib/api.ts";

// Voice settings (`GET`/`PUT /api/voice/config`). Polled while the panel is open, for the reason
// `useShipping` polls: coarse control-panel chrome whose only other writer is another window.
// The voice STATE is not here; it is the event stream's (`MissionState.voice`).

const POLL_MS = 5000;

function whyItFailed(error: string | undefined): string {
  const flat = (error ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "That change didn't stick - the daemon refused it.";
  return `That change didn't stick: ${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}`;
}

export interface VoiceConfigState {
  /**
   * What the panel draws: the config the daemon last confirmed, with every edit still waiting
   * for its answer applied on top in the order it was made. Null until the first read lands.
   */
  config: VoiceConfig | null;
  /**
   * Make an edit. It shows at once and is saved after every earlier edit has been answered;
   * resolves to whether the daemon kept it. A refused edit leaves the panel, and nothing else.
   */
  update: (patch: VoiceConfigPatch) => Promise<boolean>;
  /** Why the last edit didn't stick, or null. Cleared by an edit made after it that does. */
  error: string | null;
}

interface PendingEdit {
  id: number;
  patch: VoiceConfigPatch;
}

/**
 * `enabled` is whether Settings > Voice is on screen: nothing is read or polled otherwise.
 *
 * Edits are saved one at a time, in the order they were made. Each controls a different field,
 * and the panel allows a second edit while the first is still being saved, so answers settling in
 * another order could otherwise put an older config over a newer one: a refused first edit rolling
 * the panel back over a second edit the daemon kept, or a late answer replacing a later one. In
 * order, every answer the panel adopts is the daemon's config as of that edit, and a refusal only
 * drops its own edit from what is drawn.
 */
export function useVoiceConfig(enabled: boolean): VoiceConfigState {
  const [confirmed, setConfirmedState] = useState<VoiceConfig | null>(null);
  const [pending, setPendingState] = useState<readonly PendingEdit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const confirmedRef = useRef<VoiceConfig | null>(null);
  const pendingRef = useRef<readonly PendingEdit[]>([]);
  // The tail of the save queue: each edit's request starts once the one before it is answered.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const nextEdit = useRef(0);
  // The newest edit made when the current error was set. Only an edit made after it clears it, so
  // an edit already waiting behind the refused one cannot wipe the sentence before it is read.
  const errorAfter = useRef(0);

  const setConfirmed = useCallback((next: VoiceConfig): void => {
    confirmedRef.current = next;
    setConfirmedState(next);
  }, []);
  const setPending = useCallback((next: readonly PendingEdit[]): void => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      // A read taken while an edit is waiting, or answered after one was made, can predate it.
      if (pendingRef.current.length > 0) return;
      const at = nextEdit.current;
      const read = await fetchVoiceConfig();
      if (alive && read && nextEdit.current === at && pendingRef.current.length === 0) setConfirmed(read.config);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled, setConfirmed]);

  const update = useCallback((patch: VoiceConfigPatch): Promise<boolean> => {
    if (!confirmedRef.current) return Promise.resolve(false);
    const edit: PendingEdit = { id: ++nextEdit.current, patch };
    setPending([...pendingRef.current, edit]);
    const save = async (): Promise<boolean> => {
      const res = await api.setVoiceConfig(patch);
      const kept = res.ok && res.config !== undefined;
      if (kept) setConfirmed(res.config!);
      setPending(pendingRef.current.filter((candidate) => candidate !== edit));
      if (!kept) {
        errorAfter.current = nextEdit.current;
        setError(whyItFailed(res.error));
      } else if (edit.id > errorAfter.current) {
        setError(null);
      }
      return kept;
    };
    const result = queue.current.then(save, save);
    queue.current = result.catch(() => undefined);
    return result;
  }, [setConfirmed, setPending]);

  const config = useMemo(
    () => (confirmed ? pending.reduce((shown, edit) => applyVoiceConfigPatch(shown, edit.patch), confirmed) : null),
    [confirmed, pending],
  );

  return { config, update, error };
}

export interface VoiceDevicesState {
  devices: readonly VoiceInputDevice[];
  /** Whether a listener is live, so the panel can say why only two inputs are offered. */
  listener: boolean;
}

const NO_DEVICES: VoiceDevicesState = { devices: [], listener: false };

/**
 * The live listener's input devices (`GET /api/voice/devices`), polled while Settings > Voice is
 * on screen. A listener says hello every ten seconds, so a device plugged in shows within a poll.
 */
export function useVoiceDevices(enabled: boolean): VoiceDevicesState {
  const [state, setState] = useState<VoiceDevicesState>(NO_DEVICES);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      const read = await fetchVoiceDevices();
      if (alive && read) setState({ devices: read.devices, listener: read.listener });
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);
  return state;
}

export interface VoiceDecisionKeyState {
  busy: boolean;
  /** The provider in use and where each provider's key comes from. Null until the first read. */
  report: VoiceDecisionKeyReport | null;
  /** Save a key. Resolves to whether the daemon kept it; the key is never read back. */
  save(provider: VoiceKeyProvider, key: string): Promise<boolean>;
  remove(provider: VoiceKeyProvider): Promise<boolean>;
  /** Why the last save or removal failed, or null. */
  error: string | null;
}

/**
 * The decision-model key report (`GET /api/voice/decision-key`), read when the panel opens, when
 * the chosen provider changes, and on the same poll as the config, so a key saved in another
 * window or a provider chosen there shows here too.
 */
export function useVoiceDecisionKey(enabled: boolean, decisionProvider: string | null | undefined): VoiceDecisionKeyState {
  const [report, setReport] = useState<VoiceDecisionKeyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writes = useRef(0);
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      const at = writes.current;
      const read = await fetchVoiceDecisionKey();
      if (alive && read && writes.current === at) setReport(read);
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled, decisionProvider]);

  const mutate = useCallback(async (request: () => ReturnType<typeof api.saveVoiceDecisionKey>, failed: string): Promise<boolean> => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    try {
      const res = await request();
      writes.current++;
      if (res.ok && res.keys && res.provider !== undefined) {
        setReport({ provider: res.provider, keys: res.keys });
        setError(null);
        return true;
      }
      setError(res.reason ?? failed);
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }, []);

  const save = useCallback(async (provider: VoiceKeyProvider, key: string) =>
    mutate(() => api.saveVoiceDecisionKey(provider, key), "The key could not be saved."), [mutate]);
  const remove = useCallback(async (provider: VoiceKeyProvider) =>
    mutate(() => api.removeVoiceDecisionKey(provider), "The key could not be removed."), [mutate]);

  return { report, save, remove, error, busy };
}
