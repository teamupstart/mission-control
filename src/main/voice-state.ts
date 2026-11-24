import { shell, systemPreferences } from "electron";
import { EventSource } from "eventsource";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { desktopVoiceConnection } from "./voice-connection.ts";
import { EVENT_STREAM_HEARTBEAT_MS } from "../shared/daemon-protocol.ts";
import { desktopVoiceEndpointPath } from "../shared/harness-runtime.mjs";
import type { TrayVoiceState } from "./voice-tray.ts";
import { logMain } from "./main-log.ts";
import { VOICE_BACKENDS, VOICE_MODES, VOICE_MODEL_STATUSES, voiceStateOff, type VoiceShellReport } from "../shared/voice.ts";
import { nativeVoiceListener } from "./voice-listener.ts";

// Only these daemon fields drive the native listener and tray. Other event families,
// including roster-only updates, have no consumer in this shell.
const ShellVoiceStateSchema = z.object({
  mode: z.enum(VOICE_MODES),
  muted: z.boolean().optional(),
  model: z.object({
    status: z.enum(VOICE_MODEL_STATUSES),
    backend: z.enum(VOICE_BACKENDS).nullable(),
    directory: z.string().refine(path => isAbsolute(path) && !path.includes("\0")).nullable(),
  }).refine(model => model.status !== "ready" || (model.directory !== null && model.backend !== null)),
});
export type ShellVoiceState = z.infer<typeof ShellVoiceStateSchema>;

/** Owned by Electron main. Window hide, reload and minimize never interrupt this subscription. */
export function startShellVoice(binary: string, onState: (state: TrayVoiceState) => void, heartbeatMs = EVENT_STREAM_HEARTBEAT_MS) {
  let connection: ReturnType<typeof desktopVoiceConnection>;
  const listener = nativeVoiceListener(binary, () => {
    if (!connection) throw new Error("Voice listener has no daemon connection");
    return connection;
  });
  let stream: EventSource | undefined;
  let hasSnapshot = false;
  let streamDeadline: NodeJS.Timeout | undefined;
  let reconnect: NodeJS.Timeout | undefined;
  let reconnectDelay = 500;
  let state: ShellVoiceState = voiceStateOff();
  let lastEnabledMute: boolean | undefined;
  let nextPromptAt = 0;
  let retryDelay = 5000;
  let prompt: Promise<boolean> | undefined;
  const ask = () => {
    return prompt ??= systemPreferences.askForMediaAccess("microphone").then(granted => {
      nextPromptAt = Infinity;
      retryDelay = 5000;
      return granted;
    }, error => {
      nextPromptAt = Date.now() + retryDelay;
      retryDelay = Math.min(retryDelay * 2, 60_000);
      throw error;
    }).finally(() => { prompt = undefined; });
  };
  const lifetime = new AbortController();
  let reportRequested = false;
  let reportFailed = false;
  let sending: Promise<boolean> | undefined;

  async function sendReports() {
    let accepted = false;
    try {
      while (connection && reportRequested && state.mode !== "off") {
        reportRequested = false;
        const microphone = systemPreferences.getMediaAccessStatus("microphone");
        const report: VoiceShellReport = {
          capabilities: {
            tray: { available: true, reason: null },
            microphone: { available: microphone === "granted", reason: microphone === "granted" ? null : microphone },
          },
          microphone, hotkeyError: null, callActive: false, pushToTalk: false,
        };
        const current = connection;
        const response = await current.postStatus("/voice/shell-report", report,
          AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]));
        accepted = response?.ok ?? false;
        if (connection === current) {
          if (!accepted && !reportFailed) logMain(`Voice shell report failed status=${response?.status ?? "unavailable"}`);
          reportFailed = !accepted;
        }
      }
      return accepted;
    } finally {
      sending = undefined;
    }
  }

  function requestReport() {
    reportRequested = true;
    return sending ??= Promise.resolve().then(sendReports);
  }

  async function checkMicrophone(): Promise<"checked" | "unavailable"> {
    if (state.mode === "off") return "unavailable";
    if (!await requestReport()) throw new Error("Microphone status report was not accepted");
    return "checked";
  }

  async function sync() {
    if (state.mode === "off") {
      listener.update(state, false);
      reportRequested = false;
      nextPromptAt = 0;
      retryDelay = 5000;
      return;
    }
    const microphone = systemPreferences.getMediaAccessStatus("microphone");
    const installed = existsSync(binary);
    listener.update(state, installed && microphone === "granted");
    if (installed && state.model.status === "ready" && microphone === "not-determined" && !prompt && Date.now() >= nextPromptAt) {
      void ask().then(sync).catch(() => {});
    }
    // Capture reacts immediately. Only delivery to the daemon waits for a prior POST.
    return requestReport();
  }
  function update(next: ShellVoiceState) {
    state = next;
    lastEnabledMute = next.mode === "off" ? undefined : (next.muted ?? next.mode === "muted");
    onState(state);
    void sync();
  }
  function disconnect() {
    clearTimeout(streamDeadline);
    if (stream) {
      stream.removeEventListener("ping", noteActivity);
      stream.onmessage = stream.onerror = null;
      stream.close();
      stream = undefined;
    }
    connection?.close();
    connection = undefined;
    hasSnapshot = false;
    reportFailed = false;
  }
  function noteActivity() {
    // Pings and incremental updates cannot extend the initial snapshot deadline.
    if (hasSnapshot) streamDeadline?.refresh();
  }
  function requestSnapshot() {
    disconnect();
    state = voiceStateOff();
    if (!existsSync(desktopVoiceEndpointPath())) lastEnabledMute = undefined;
    onState(lastEnabledMute === undefined ? state : { mode: "reconnecting", muted: lastEnabledMute });
    void sync();
    reconnect = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }
  function receive(data: string) {
    let message: unknown;
    try { message = JSON.parse(data); }
    catch { requestSnapshot(); return; }
    if (!message || typeof message !== "object" || !("type" in message) || typeof message.type !== "string") {
      requestSnapshot();
      return;
    }
    if (message.type !== "voice_state" && message.type !== "snapshot") return;
    // A snapshot without voice establishes a disabled baseline.
    const payload = message.type === "snapshot"
      ? ("voice" in message ? message.voice : voiceStateOff())
      : ("state" in message && message.state);
    const parsed = ShellVoiceStateSchema.safeParse(payload);
    if (!parsed.success) { requestSnapshot(); return; }
    if (!hasSnapshot) {
      if (message.type !== "snapshot") return;
      hasSnapshot = true;
      clearTimeout(streamDeadline);
      streamDeadline = setTimeout(requestSnapshot, 3 * heartbeatMs);
    }
    reconnectDelay = 500;
    update(parsed.data);
  }
  function connect() {
    const current = connection = desktopVoiceConnection();
    if (!current) {
      if (lastEnabledMute !== undefined && !existsSync(desktopVoiceEndpointPath())) update(voiceStateOff());
      reconnect = setTimeout(connect, 1000);
      return;
    }
    stream = new EventSource(current.origin + "/events", {
      fetch: (_url, options) => current.request("/events", options),
    });
    streamDeadline = setTimeout(requestSnapshot, 2 * heartbeatMs);
    stream.addEventListener("ping", noteActivity);
    stream.onmessage = ({data}) => { noteActivity(); receive(data); };
    // A replacement daemon has its own key. Re-read its local identity on every reconnect.
    stream.onerror = requestSnapshot;
  }
  connect();
  const heartbeat = setInterval(() => void sync(), 5000);
  return {
    get state() { return state; },
    checkMicrophone,
    async fixMicrophone(): Promise<"unavailable" | "checked"> {
      if (state.mode === "off") return "unavailable";
      const permission = systemPreferences.getMediaAccessStatus("microphone");
      if (permission === "denied" || permission === "restricted") {
        await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
      } else if (permission === "not-determined") await ask();
      if (!await sync()) throw new Error("Microphone status report was not accepted");
      return "checked";
    },
    async mute(muted: boolean) {
      if (!connection || state.mode === "off") return false;
      const response = await connection.postStatus("/api/voice/mute", { muted },
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]));
      return response?.ok ?? false;
    },
    stop() {
      clearTimeout(reconnect);
      disconnect();
      lifetime.abort();
      clearInterval(heartbeat);
      state = voiceStateOff();
      return listener.stop();
    },
  };
}
