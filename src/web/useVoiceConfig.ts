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
  /** The provider the daemon currently acknowledges, independent of edits still queued. */
  confirmedDecisionProvider: VoiceConfig["decisionProvider"] | undefined;
  /**
   * Show an edit immediately and resolve to whether the daemon kept it.
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
 * The daemon orders provider selections, so a stalled write cannot delay an opt-out.
 * The other settings share one queue and retain their edit order.
 */
export function useVoiceConfig(enabled: boolean): VoiceConfigState {
  const [confirmed, setConfirmedState] = useState<VoiceConfig | null>(null);
  const [pending, setPendingState] = useState<readonly PendingEdit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const confirmedRef = useRef<VoiceConfig | null>(null);
  const pendingRef = useRef<readonly PendingEdit[]>([]);
  const settingsQueue = useRef(Promise.resolve());
  const latestProviderEdit = useRef(0);
  const confirmedProviderEdit = useRef(0);
  const [writer] = useState(() => crypto.randomUUID());
  const providerRevision = useRef("");
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
    let nextRead = 0;
    let appliedRead = 0;
    const tick = async (): Promise<void> => {
      // A read taken while an edit is waiting, or answered after one was made, can predate it.
      if (pendingRef.current.length > 0) return;
      const id = ++nextRead;
      const at = nextEdit.current;
      const read = await fetchVoiceConfig();
      if (alive && read && id > appliedRead && nextEdit.current === at && pendingRef.current.length === 0) {
        appliedRead = id;
        providerRevision.current = read.providerRevision;
        setConfirmed(read.config);
      }
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
    const { decisionProvider, ...settings } = patch;
    const changesProvider = decisionProvider !== undefined;
    const changesSettings = Object.keys(settings).length > 0;
    if (changesProvider) latestProviderEdit.current = edit.id;
    setPending([...pendingRef.current, edit]);
    const reservation = changesProvider ? api.reserveVoiceProviderWrite(writer, providerRevision.current) : undefined;
    const save = async (): Promise<boolean> => {
      const order = await reservation;
      const sendProvider = changesProvider && edit.id === latestProviderEdit.current;
      const superseded = () => changesProvider && edit.id !== latestProviderEdit.current;
      if (!sendProvider && !changesSettings) {
        setPending(pendingRef.current.filter(candidate => candidate !== edit));
        return false;
      }
      let res = sendProvider && order && !order.ticket ? order
        : await api.setVoiceConfig(sendProvider ? patch : settings, sendProvider ? order?.ticket : undefined);
      // An explicit opt-out still applies if another window changed providers since our read.
      // Obtain a fresh ticket so a new selection made here during the retry still wins.
      if (decisionProvider === "off" && !superseded() && res.status === 409 && res.providerRevision) {
        const retry = await api.reserveVoiceProviderWrite(writer, res.providerRevision);
        if (!superseded()) res = retry.ticket ? await api.setVoiceConfig(patch, retry.ticket) : retry;
      }
      const kept = res.ok && res.config !== undefined;
      const current = confirmedRef.current;
      if (res.config && current && (kept || res.status === 409)) {
        const applyProvider = sendProvider && edit.id > confirmedProviderEdit.current;
        if (applyProvider && res.providerRevision) {
          confirmedProviderEdit.current = edit.id;
          providerRevision.current = res.providerRevision;
        }
        setConfirmed({
          ...(changesSettings && kept ? res.config : current),
          decisionProvider: applyProvider ? res.config.decisionProvider : current.decisionProvider,
        });
      }
      setPending(pendingRef.current.filter((candidate) => candidate !== edit));
      if (superseded() && !changesSettings) return false;
      if (!kept) {
        errorAfter.current = nextEdit.current;
        setError(whyItFailed(res.error));
      } else if (edit.id > errorAfter.current) {
        setError(null);
      }
      return kept;
    };
    if (!changesSettings) return save();
    const result = settingsQueue.current.then(save);
    settingsQueue.current = result.then(() => {}, () => {});
    return result;
  }, [setConfirmed, setPending, writer]);

  const config = useMemo(
    () => (confirmed ? pending.reduce((shown, edit) => {
      const next = applyVoiceConfigPatch(shown, edit.patch);
      if (edit.id !== latestProviderEdit.current) next.decisionProvider = shown.decisionProvider;
      return next;
    }, confirmed) : null),
    [confirmed, pending],
  );

  return { config, confirmedDecisionProvider: confirmed?.decisionProvider, update, error };
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
  /** Undefined until the first read, null when the latest read failed. */
  report: VoiceDecisionKeyReport | null | undefined;
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
export function useVoiceDecisionKey(enabled: boolean, confirmedProvider: VoiceConfigState["confirmedDecisionProvider"]): VoiceDecisionKeyState {
  const [status, setStatus] = useState<{
    selection: VoiceConfigState["confirmedDecisionProvider"];
    report: VoiceDecisionKeyReport | null;
  }>();
  const [error, setError] = useState<string | null>(null);
  const writes = useRef(0);
  const refresh = useRef<(() => Promise<void>) | null>(null);
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let nextRead = 0;
    let appliedRead = 0;
    const tick = async (): Promise<void> => {
      const id = ++nextRead;
      const at = writes.current;
      const read = await fetchVoiceDecisionKey();
      if (alive && writes.current === at && id > appliedRead) {
        appliedRead = id;
        setStatus({ selection: confirmedProvider, report: read });
      }
    };
    refresh.current = tick;
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      refresh.current = null;
      clearInterval(id);
    };
  }, [enabled, confirmedProvider]);

  const mutate = useCallback(async (request: () => ReturnType<typeof api.saveVoiceDecisionKey>, failed: string): Promise<boolean> => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    try {
      const res = await request();
      writes.current++;
      if (res.ok && res.keys && res.provider !== undefined) {
        // Another window may have changed the keys since this mutation was applied.
        setStatus(undefined);
        void refresh.current?.();
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

  const report = status?.selection === confirmedProvider ? status?.report : undefined;
  return { report, save, remove, error, busy };
}
