import { shell, systemPreferences } from "electron";
import { EventSource } from "eventsource";
import { existsSync } from "node:fs";
import { BASE_URL, readToken } from "../shared/harness-runtime.mjs";
import type { ServerEvent } from "../shared/types.ts";
import { voiceStateOff, type VoiceState, type VoiceShellReport } from "../shared/voice.ts";
import { nativeVoiceListener } from "./voice-listener.ts";

/** Owned by Electron main. Window hide, reload and minimize never interrupt this subscription. */
export function startShellVoice(binary: string, onState: (state: VoiceState) => void) {
  const listener = nativeVoiceListener(binary);
  const stream = new EventSource(BASE_URL + "/events", {
    fetch: (url, options) => fetch(url, { ...options, redirect: "error" }),
  });
  let state = voiceStateOff();
  let asked = false;
  let prompt: Promise<boolean> | undefined;
  const ask = () => {
    asked = true;
    return prompt ??= systemPreferences.askForMediaAccess("microphone").finally(() => { prompt = undefined; });
  };
  const lifetime = new AbortController();

  async function sync() {
    if (state.mode === "off") {
      listener.update(state, false);
      asked = false;
      return;
    }
    const microphone = systemPreferences.getMediaAccessStatus("microphone");
    const installed = existsSync(binary);
    listener.update(state, installed && microphone === "granted");
    if (installed && state.model.status === "ready" && microphone === "not-determined" && !asked) {
      void ask().then(sync).catch(() => {});
    }
    const report: VoiceShellReport = {
      capabilities: {
        tray: { available: true, reason: null },
        microphone: { available: microphone === "granted", reason: microphone === "granted" ? null : microphone },
      },
      microphone, hotkeyError: null, callActive: false, pushToTalk: false,
    };
    await fetch(BASE_URL + "/voice/shell-report", {
      method: "POST", redirect: "error", headers: { "content-type": "application/json", "x-harness-token": readToken() },
      body: JSON.stringify(report), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]),
    }).catch(() => {}); // Next heartbeat retries a daemon that is restarting.
  }
  function update(next: VoiceState) {
    state = next;
    onState(state);
    void sync();
  }
  stream.onmessage = ({ data }) => {
    const message: ServerEvent = JSON.parse(data);
    if (message.type === "snapshot") update(message.voice ?? voiceStateOff());
    else if (message.type === "voice_state") update(message.state);
    else if (message.type === "voice_roster") state = { ...state, roster: message.roster };
  };
  stream.onerror = () => update(voiceStateOff());
  const heartbeat = setInterval(() => void sync(), 5000);
  return {
    get state() { return state; },
    async fixMicrophone() {
      if (state.mode === "off") return;
      const permission = systemPreferences.getMediaAccessStatus("microphone");
      if (permission === "denied" || permission === "restricted") {
        await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
      } else if (permission === "not-determined") await ask();
      await sync();
    },
    async mute(muted: boolean) {
      if (state.mode !== "off") await fetch(BASE_URL + "/api/voice/mute", {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
        body: JSON.stringify({ muted }), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]),
      }).catch(() => {});
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
