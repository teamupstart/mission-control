import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyVoiceConfigPatch, VOICE_PROVIDER_EDIT_TIMEOUT_MS, VoiceProviderGestureSchema, type VoiceConfig, type VoiceConfigPatch, type VoiceInputDevice, type VoiceProviderIntent } from "@shared/voice.ts";
import type { VoiceKeyProvider } from "@shared/voice-decide.ts";
import { api, fetchVoiceConfig, fetchVoiceDecisionKey, fetchVoiceDevices, type VoiceDashboardSnapshot, type VoiceKeyWriteOptions } from "./lib/api.ts";
import { VoiceDashboardClock } from "./lib/voice-dashboard-clock.ts";

// Voice settings (`GET`/`PUT /api/voice/config`). Poll while Settings > Voice is open so
// the panel picks up edits made in other windows.
// The voice STATE is not here; it is the event stream's (`MissionState.voice`).

const POLL_MS = 5000;
const SETTINGS_REQUEST_TIMEOUT_MS = 3 * POLL_MS;

async function readSetting<T>(read: (signal: AbortSignal) => Promise<T>, group: AbortSignal): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), SETTINGS_REQUEST_TIMEOUT_MS);
  try {
    return await read(AbortSignal.any([group, deadline.signal]));
  } finally {
    clearTimeout(timer);
  }
}

// A receipt contains only a daemon instance, sequence and random nonce. Sharing
// it before sending the PUT lets another window prove what preceded its click.
const RECEIPT_KEY = "mission.voice.providerIntentReceipt";
function observedIntentReceipt(): string | undefined {
  try { return localStorage.getItem(RECEIPT_KEY) ?? undefined; } catch { return undefined; }
}

function rememberIntentReceipt(receipt?: string): void {
  if (!receipt) return;
  const [daemon, order] = receipt.split(":");
  const [previous, lastOrder] = observedIntentReceipt()?.split(":") ?? [];
  if (daemon === previous && Number(order) <= Number(lastOrder)) return;
  try { localStorage.setItem(RECEIPT_KEY, receipt); } catch { /* Storage may be unavailable. */ }
}

// Order clicks across same-origin windows before either reservation reaches the daemon.
// The lock covers the local counter only. A slow HTTP request cannot hold up another click.
async function nextProviderGesture(signal: AbortSignal): Promise<VoiceProviderIntent["gesture"]> {
  const key = "mission.voice.providerGesture";
  try {
    return await navigator.locks.request(key, { signal }, () => {
      const previous = localStorage.getItem(key);
      const [group, value] = previous?.split(":") ?? [];
      const parsed = VoiceProviderGestureSchema.safeParse({ group, order: Number(value) + 1 });
      const next = parsed.success ? parsed.data : { group: crypto.randomUUID(), order: 1 };
      localStorage.setItem(key, `${next.group}:${next.order}`);
      return next;
    });
  } catch {
    return undefined;
  }
}

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
  keyReportVersion: string;
  clock: VoiceDashboardClock;
  observeProvider: (revision: string, selection: VoiceConfig["decisionProvider"]) => boolean;
  pendingDecisionProvider: VoiceConfig["decisionProvider"] | undefined;
  /**
   * Show an edit immediately and resolve to whether the daemon kept it.
   */
  update: (patch: VoiceConfigPatch, observedProviderRevision?: string) => Promise<boolean>;
  /** Why the last edit didn't stick, or null. Cleared by an edit made after it that does. */
  error: string | null;
}

function isOlderSnapshot(read: VoiceDashboardSnapshot, previous?: VoiceDashboardSnapshot): boolean {
  return previous?.providerRevision === read.providerRevision && read.snapshotOrder <= previous.snapshotOrder;
}

interface PendingEdit {
  id: number;
  patch: VoiceConfigPatch;
}

/**
 * Window-owned settings keep pending edits in order across navigation. Live shortcut hints
 * use the configured and registered chords from the daemon's voice state.
 * Nothing is read or polled with the preview off.
 *
 * The daemon orders provider selections, so a stalled write cannot delay an opt-out.
 * The other settings share one queue and retain their edit order.
 */
export function useVoiceConfig(pollWhileOpen: boolean): VoiceConfigState {
  const [confirmed, setConfirmedState] = useState<VoiceConfig | null>(null);
  const [pending, setPendingState] = useState<readonly PendingEdit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const confirmedRef = useRef<VoiceConfig | null>(null);
  const pendingRef = useRef<readonly PendingEdit[]>([]);
  const settingsQueue = useRef(Promise.resolve());
  const latestProviderEdit = useRef(0);
  const confirmedProviderEdit = useRef(0);
  const [writer] = useState(() => crypto.randomUUID());
  const [provider, setProvider] = useState<{ revision: string; selection: VoiceConfig["decisionProvider"] }>();
  const latestProvider = useRef(provider);
  const previousDaemons = useRef(new Set<string>());
  const [clock] = useState(() => new VoiceDashboardClock(signal => readSetting(fetchVoiceConfig, signal)));
  const [unconfirmedProviderEdit, setUnconfirmedProviderEdit] = useState<number | null>(null);
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

  // Config reads, key reports and write acknowledgments all carry the daemon's
  // selection revision. Their HTTP responses may arrive in any order.
  const observeProvider = useCallback((revision: string, selection: VoiceConfig["decisionProvider"]): boolean => {
    const prior = latestProvider.current;
    const [daemon = "", order] = revision.split(":");
    if (prior?.revision !== revision) {
      if (previousDaemons.current.has(daemon)) return false;
      if (prior) {
        const [previous = "", lastOrder] = prior.revision.split(":");
        if (daemon === previous && Number(order) < Number(lastOrder)) return false;
        if (daemon !== previous) previousDaemons.current.add(previous);
      }
      latestProvider.current = { revision, selection };
      setProvider(latestProvider.current);
    }
    setUnconfirmedProviderEdit(null);
    return true;
  }, []);

  useEffect(() => {
    if (!pollWhileOpen) return;
    const reads = new AbortController();
    let snapshot: VoiceDashboardSnapshot | undefined;
    const tick = async (): Promise<void> => {
      // A read taken while an edit is waiting, or answered after one was made, can predate it.
      if (pendingRef.current.length > 0) return;
      const at = nextEdit.current;
      const sentAt = performance.now();
      const read = await readSetting(fetchVoiceConfig, reads.signal);
      if (!reads.signal.aborted && read && !isOlderSnapshot(read, snapshot) && nextEdit.current === at && pendingRef.current.length === 0) {
        if (!observeProvider(read.providerRevision, read.config.decisionProvider)) return;
        clock.observe(read, sentAt);
        snapshot = read;
        rememberIntentReceipt(read.intentReceipt);
        setConfirmed(read.config);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      reads.abort();
      clearInterval(id);
    };
  }, [clock, pollWhileOpen, observeProvider, setConfirmed, unconfirmedProviderEdit]);

  const update = useCallback((patch: VoiceConfigPatch, observedProviderRevision?: string): Promise<boolean> => {
    const { decisionProvider, ...settings } = patch;
    const changesProvider = decisionProvider !== undefined;
    const changesSettings = Object.keys(settings).length > 0;
    if (!confirmedRef.current && !(changesProvider && !changesSettings && observedProviderRevision)) return Promise.resolve(false);
    const edit: PendingEdit = { id: ++nextEdit.current, patch };
    if (changesProvider) latestProviderEdit.current = edit.id;
    setPending([...pendingRef.current, edit]);
    const selectedAt = performance.now();
    const observed = observedProviderRevision ?? latestProvider.current?.revision ?? "";
    const optOut = decisionProvider === "off";
    const intent: VoiceProviderIntent = { writer, observedRevision: observed, optOut, edit: edit.id,
      observedIntent: changesProvider ? observedIntentReceipt() : undefined };
    const providerRequest = changesProvider ? new AbortController() : undefined;
    const timer = providerRequest && setTimeout(() => providerRequest.abort(), VOICE_PROVIDER_EDIT_TIMEOUT_MS);
    const reservation = providerRequest ? Promise.all([
      nextProviderGesture(providerRequest.signal), clock.deadline(VOICE_PROVIDER_EDIT_TIMEOUT_MS, providerRequest.signal),
    ]).then(([gesture, expiresAt]) => {
      intent.gesture = gesture;
      intent.expiresAt = expiresAt;
      return api.reserveVoiceProviderWrite(intent, providerRequest.signal);
    }) : undefined;
    const save = async (): Promise<boolean> => {
      const order = await reservation;
      rememberIntentReceipt(order?.intentReceipt);
      const sendProvider = changesProvider && edit.id === latestProviderEdit.current;
      const superseded = () => changesProvider && edit.id !== latestProviderEdit.current;
      if (!sendProvider && !changesSettings) {
        setPending(pendingRef.current.filter(candidate => candidate !== edit));
        return false;
      }
      const signal = sendProvider && providerRequest ? providerRequest.signal : AbortSignal.timeout(SETTINGS_REQUEST_TIMEOUT_MS);
      const settingsExpiry = sendProvider ? undefined : await clock.deadline(SETTINGS_REQUEST_TIMEOUT_MS, signal);
      let res = sendProvider && order && !order.ticket ? order
        : await api.setVoiceConfig(sendProvider ? patch : settings, sendProvider ? order?.ticket : undefined, signal, settingsExpiry);
      // A receipt captured at click time establishes order independently of
      // latency. Without one, the daemon's idle interval must cover the whole trip.
      const window = order?.intentWindow;
      const canRetry = optOut || (window?.pendingSelection && res.providerRevision === observed);
      if (canRetry && !order?.ticket && !superseded() && res.status === 409 && res.providerRevision &&
          window && ((intent.observedIntent !== undefined && window.receipt === intent.observedIntent) ||
            window.quietForMs > performance.now() - selectedAt)) {
        const retry = await api.reserveVoiceProviderWrite({ ...intent, observedRevision: res.providerRevision, unchangedSince: window.token }, signal);
        rememberIntentReceipt(retry.intentReceipt);
        if (!superseded()) res = retry.ticket ? await api.setVoiceConfig(patch, retry.ticket, signal) : retry;
      }
      const unconfirmed = sendProvider && (!res.config || !res.providerRevision) &&
        (res.ok || res.status === undefined || res.status >= 500);
      const kept = res.ok && res.config !== undefined && !unconfirmed;
      const current = confirmedRef.current ?? res.config;
      if (unconfirmed && edit.id > confirmedProviderEdit.current) {
        // The write may already have committed. Invalidate both reads before displaying
        // any routing destination again, and ignore older local write acknowledgements.
        confirmedProviderEdit.current = edit.id;
        setUnconfirmedProviderEdit(edit.id);
      } else if (res.config && current && (kept || res.status === 409)) {
        if (sendProvider && edit.id > confirmedProviderEdit.current && res.providerRevision) {
          confirmedProviderEdit.current = edit.id;
          observeProvider(res.providerRevision, res.config.decisionProvider);
        }
        setConfirmed({
          ...(changesSettings && kept ? res.config : current),
          decisionProvider: latestProvider.current ? latestProvider.current.selection : current.decisionProvider,
        });
      }
      setPending(pendingRef.current.filter((candidate) => candidate !== edit));
      if (superseded() && !changesSettings) return false;
      if (!kept) {
        errorAfter.current = nextEdit.current;
        setError(unconfirmed ? "The provider change could not be confirmed." : whyItFailed(res.error));
      } else if (edit.id > errorAfter.current) {
        setError(null);
      }
      return kept;
    };
    const result = changesSettings ? settingsQueue.current.then(save) : save();
    if (changesSettings) settingsQueue.current = result.then(() => {}, () => {});
    return result.finally(() => clearTimeout(timer));
  }, [clock, observeProvider, setConfirmed, setPending, writer]);

  const config = useMemo(
    () => (confirmed ? pending.reduce((shown, edit) => {
      const next = applyVoiceConfigPatch(shown, edit.patch);
      if (edit.id !== latestProviderEdit.current) next.decisionProvider = shown.decisionProvider;
      return next;
    }, confirmed) : null),
    [confirmed, pending],
  );

  return {
    config, confirmedDecisionProvider: unconfirmedProviderEdit === null ? provider?.selection : undefined,
    keyReportVersion: unconfirmedProviderEdit === null ? provider?.revision ?? "" : `unconfirmed:${unconfirmedProviderEdit}`,
    observeProvider,
    clock,
    pendingDecisionProvider: pending.find(edit => edit.id === latestProviderEdit.current)?.patch.decisionProvider, update, error,
  };
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
    const reads = new AbortController();
    const tick = async (): Promise<void> => {
      const read = await readSetting(fetchVoiceDevices, reads.signal);
      if (!reads.signal.aborted && read) setState({ devices: read.devices, listener: read.listener });
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      reads.abort();
      clearInterval(id);
    };
  }, [enabled]);
  return state;
}

type KeyWriteOutcome = "confirmed" | "refused" | "unconfirmed";

export interface VoiceDecisionKeyState {
  busy: boolean;
  /** Undefined until the first read, null when the latest read failed. */
  report: Awaited<ReturnType<typeof fetchVoiceDecisionKey>> | undefined;
  save(provider: VoiceKeyProvider, key: string): Promise<KeyWriteOutcome>;
  remove(provider: VoiceKeyProvider): Promise<KeyWriteOutcome>;
  /** Why the last save or removal failed, or null. */
  error: string | null;
}

/**
 * The decision-model key report (`GET /api/voice/decision-key`), read when the panel opens, when
 * the chosen provider changes, and on the same poll as the config, so a key saved in another
 * window or a provider chosen there shows here too.
 */
export function useVoiceDecisionKey(enabled: boolean, { keyReportVersion: providerRevision, observeProvider, clock }:
    Pick<VoiceConfigState, "keyReportVersion" | "observeProvider" | "clock">): VoiceDecisionKeyState {
  const [status, setStatus] = useState<{
    revision: string;
    report: Awaited<ReturnType<typeof fetchVoiceDecisionKey>>;
  }>();
  const [error, setError] = useState<string | null>(null);
  const writes = useRef(0);
  const refresh = useRef<(() => Promise<void>) | null>(null);
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let reads = new AbortController();
    let nextRead = 0;
    let appliedRead = 0;
    let failedRead = 0;
    let snapshot: VoiceDashboardSnapshot | undefined;
    const tick = async (): Promise<void> => {
      const id = ++nextRead;
      const at = writes.current;
      const group = reads.signal;
      const sentAt = performance.now();
      const read = await readSetting(fetchVoiceDecisionKey, group);
      if (group.aborted || writes.current !== at) return;
      if (read) {
        // Requests may reach the daemon out of order even when they share a provider revision.
        if (id < failedRead || isOlderSnapshot(read, snapshot)) return;
        if (!observeProvider(read.providerRevision, read.selection)) return;
        clock.observe(read, sentAt);
        snapshot = read;
        rememberIntentReceipt(read.intentReceipt);
      } else {
        // A transport failure has no daemon snapshot to order it by.
        if (id < appliedRead) return;
        failedRead = id;
      }
      appliedRead = Math.max(id, appliedRead);
      setStatus({ revision: read?.providerRevision ?? providerRevision, report: read });
    };
    refresh.current = () => {
      // A completed mutation needs a fresh snapshot. Free the connections held by its earlier polls.
      reads.abort();
      reads = new AbortController();
      return tick();
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      reads.abort();
      refresh.current = null;
      clearInterval(id);
    };
  }, [clock, enabled, providerRevision, observeProvider]);

  const report = status?.revision === providerRevision ? status.report : undefined;
  const mutate = useCallback(async (provider: VoiceKeyProvider, request: (options: VoiceKeyWriteOptions) => ReturnType<typeof api.saveVoiceDecisionKey>): Promise<KeyWriteOutcome> => {
    const revision = report?.keyRevisions?.[provider];
    if (writing.current || !revision) return "refused";
    writing.current = true;
    setBusy(true);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), SETTINGS_REQUEST_TIMEOUT_MS);
    try {
      const expiresAt = await clock.deadline(SETTINGS_REQUEST_TIMEOUT_MS, deadline.signal);
      const res = await request({ revision, expiresAt, signal: deadline.signal });
      if (res.ok && res.keys && res.provider !== undefined) {
        setError(null);
        return "confirmed";
      }
      setError(res.reason ?? "The key change could not be confirmed.");
      return res.reason ? "refused" : "unconfirmed";
    } finally {
      clearTimeout(timer);
      // Even a lost response can follow a committed change. Read the current sources and
      // discard responses from polls which started before this mutation settled.
      writes.current++;
      setStatus(undefined);
      void refresh.current?.();
      writing.current = false;
      setBusy(false);
    }
  }, [clock, report]);

  const save = useCallback(async (provider: VoiceKeyProvider, key: string) =>
    mutate(provider, options => api.saveVoiceDecisionKey(provider, key, options)), [mutate]);
  const remove = useCallback(async (provider: VoiceKeyProvider) =>
    mutate(provider, options => api.removeVoiceDecisionKey(provider, options)), [mutate]);

  return { report, save, remove, error, busy };
}
