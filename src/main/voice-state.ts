import { shell, systemPreferences } from "electron";
import { EventSource } from "eventsource";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { BASE_URL, readToken } from "../shared/harness-runtime.mjs";
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
export function startShellVoice(binary: string, onState: (state: ShellVoiceState) => void) {
  const listener = nativeVoiceListener(binary);
  const stream = new EventSource(BASE_URL + "/events", {
    fetch: (url, options) => fetch(url, { ...options, redirect: "error" }),
  });
  let state: ShellVoiceState = voiceStateOff();
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
  let sending: Promise<boolean> | undefined;

  async function sendReports() {
    let accepted = false;
    try {
      while (reportRequested && state.mode !== "off") {
        reportRequested = false;
        const microphone = systemPreferences.getMediaAccessStatus("microphone");
        const report: VoiceShellReport = {
          capabilities: {
            tray: { available: true, reason: null },
            microphone: { available: microphone === "granted", reason: microphone === "granted" ? null : microphone },
          },
          microphone, hotkeyError: null, callActive: false, pushToTalk: false,
        };
        accepted = await fetch(BASE_URL + "/voice/shell-report", {
          method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-harness-token": readToken() },
          body: JSON.stringify(report), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]),
        }).then(response => response.ok, () => false);
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
    onState(state);
    void sync();
  }
  stream.onmessage = ({ data }) => {
    let message: unknown;
    try { message = JSON.parse(data); }
    catch { update(voiceStateOff()); return; }
    if (!message || typeof message !== "object" || !("type" in message) || typeof message.type !== "string") {
      update(voiceStateOff());
      return;
    }
    if (message.type !== "voice_state" && message.type !== "snapshot") return;
    const payload = message.type === "snapshot"
      ? ("voice" in message && message.voice)
      : ("state" in message && message.state);
    const parsed = ShellVoiceStateSchema.safeParse(payload);
    update(parsed.success ? parsed.data : voiceStateOff());
  };
  stream.onerror = () => update(voiceStateOff());
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
      if (state.mode === "off") return false;
      return fetch(BASE_URL + "/api/voice/mute", {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
        body: JSON.stringify({ muted }), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]),
      }).then(response => response.ok, () => false);
    },
    stop() {
      stream.close();
      lifetime.abort();
      clearInterval(heartbeat);
      state = voiceStateOff();
      return listener.stop();
    },
  };
}
