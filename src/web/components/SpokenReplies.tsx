import { useRef, useState } from "react";
import { VOICE_CONFIG_DEFAULTS, type VoiceState } from "@shared/voice.ts";
import { VOICE_SPEECH_MODELS, VOICE_SPEECH_NEURAL_VOICES } from "@shared/voice-models.ts";
import { resolveSpeechVoice, type VoiceSpeechCatalog, type VoiceSpeechVoice } from "@shared/voice-speech.ts";
import { api } from "../lib/api.ts";
import type { VoiceConfigState } from "../useVoiceConfig.ts";
import { Tooltip } from "./Tooltip.tsx";
import { VoiceModelProgress } from "./VoiceModelProgress.tsx";

const appleSettings = "System Settings > Accessibility > Read & Speak";
const neural = VOICE_SPEECH_NEURAL_VOICES;
const licence = VOICE_SPEECH_MODELS["supertonic-3"].sources.map(source => source.license).join(", ");

function voiceName(choice: VoiceSpeechVoice, catalog: VoiceSpeechCatalog): string {
  const entries = choice.engine === "neural" ? neural : catalog.system;
  const name = entries.find(v => v.id === choice.id)?.name ?? choice.id;
  return choice.engine === "neural" ? `Mission Control voice ${name}` : name;
}

function speechStatus(voice: VoiceState | null, choice: VoiceSpeechVoice | null): string {
  if (!voice) return "Checking which voice can speak…";
  const { speech } = voice;
  if (speech.voice) return `${voiceName(speech.voice, speech.catalog)} will speak.`;
  const output = voice.capabilities["speech-output"];
  const reason = output?.reason ?? speech.reason ?? "No voice is ready.";
  if (output?.code === "speech_voice_unavailable") {
    if (choice?.engine === "system") return `${reason} Install it in ${appleSettings}, or choose another voice.`;
    if ((!choice || neural.some(v => v.id === choice.id)) && speech.model.revision && speech.model.status !== "ready") {
      if (speech.model.status === "downloading" || speech.model.status === "verifying") return `${reason} Waiting for the download to finish.`;
      return `${reason} ${speech.model.status === "failed" ? "Retry the download" : "Download the Mission Control voices"} to enable speech.`;
    }
    return `${reason} Choose an available voice or connect a listener that can play audio.`;
  }
  if (output?.code === "speech_playback_off") return `${reason} Questions appear on screen. Turn on Speak replies aloud to hear them.`;
  if (output?.code === "speech_playback_unsupported") return `${reason} Questions appear on screen. Connect a listener that supports playback to hear them.`;
  return `${reason.replace(/[.]$/u, "")}. Open Voice Setup and check the listener.`;
}

function optionValue(choice: VoiceSpeechVoice | null): string {
  return choice ? `${choice.engine}:${choice.id}` : "";
}

export function SpokenReplies({ state, voice }: { state: Pick<VoiceConfigState, "config" | "update">; voice: VoiceState | null }): React.JSX.Element {
  const [pickerPending, setPickerPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const busy = pickerPending || stopPending;
  const auditionRequest = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampleId, setSampleId] = useState<string>();
  const { config, update } = state;
  const choice = config?.speech.voice ?? null;
  const speech = voice?.speech;
  const model = speech?.model;
  const system = speech?.catalog.system ?? [];
  const macListener = system.length > 0 || voice?.model.backend === "fluidaudio";
  const choices = choice?.engine === "system" ? system : neural;
  const unlisted = choice && !choices.some(v => v.id === choice.id);
  const canDownload = model?.revision && (model.status === "missing" || model.status === "failed");
  const liveSample = speech?.job?.purpose === "audition" ? speech.job : null;
  // The config write is optimistic. Wait for its matching speech state before offering a sample.
  const resolved = config && speech ? resolveSpeechVoice(config, speech.catalog) : null;
  const pendingVoice = !!speech?.voice && optionValue(resolved?.voice ?? null) !== optionValue(speech.voice);
  const status = pendingVoice ? "Checking the selected voice…" : speechStatus(voice, choice);
  const output = voice?.capabilities["speech-output"];
  const canPlay = output?.available === true;
  const sampleReason = pendingVoice || !canPlay ? status : speech?.job?.purpose === "ask" ? "Wait for the spoken question to finish." : undefined;
  const playback = config?.speech.playback ?? true;
  const automatic = speech && (canPlay || output?.code === "speech_voice_unavailable" || output?.code === "speech_playback_off")
    ? resolveSpeechVoice(VOICE_CONFIG_DEFAULTS, speech.catalog).voice : null;
  const downloadSize = model?.totalBytes ? `${Number((model.totalBytes / 1_000_000).toFixed(1))} MB` : "";
  const last = speech?.lastAudition;
  const sampleFailed = last && last.id === sampleId && (last.state === "failed" || last.state === "timed-out");

  async function perform(action: () => Promise<void>, setPending = setPickerPending): Promise<void> {
    setPending(true);
    setError(null);
    try { await action(); }
    finally { setPending(false); }
  }
  async function download(): Promise<void> {
    const result = await api.startVoiceSpeechDownload();
    if (!result.ok) setError(result.reason ?? result.error ?? "Download could not start.");
  }
  async function select(value: string): Promise<void> {
    const engine = value.startsWith("system:") ? "system" : "neural";
    const next = value ? { engine, id: value.slice(engine.length + 1) } as const : null;
    if (await update({ speech: { voice: next } }) && next?.engine === "neural" && canDownload) await download();
  }
  async function sample(): Promise<void> {
    if (liveSample) {
      // The live job identifies the sample even if its start response never arrived.
      auditionRequest.current?.abort();
      setSampleId(liveSample.id);
      const result = await api.stopVoiceSpeech(liveSample.id);
      if (!result.ok) setError(result.error ?? "Could not stop playback.");
    } else {
      const request = new AbortController();
      auditionRequest.current = request;
      const result = await api.auditionVoiceSpeech(request.signal);
      auditionRequest.current = null;
      if (request.signal.aborted) return;
      if (!result.ok) setError(result.reason ?? result.error ?? "Could not play the sample.");
      setSampleId(result.id);
    }
  }
  return (
    <section className="settings-group voice-spoken-replies" aria-labelledby="spoken-replies-title" data-anchor="voice/spoken-replies">
      <h3 className="settings-group-label" id="spoken-replies-title">Spoken replies</h3>
      <div className="kb-row">
        <div className="kb-row-text">
          <span className="kb-row-label">Speak replies aloud</span>
          <span className="kb-row-desc">
            Play voice samples and spoken questions aloud. Turn this off if the microphone picks up
            the spoken voice. Questions still appear on screen.
          </span>
        </div>
        <div className="kb-row-controls">
          <Tooltip label={playback ? "Stop speaking samples and questions aloud" : "Speak samples and questions aloud"}>
            <label className="skill-switch">
              <input type="checkbox" checked={playback} disabled={!config}
                onChange={e => void update({ speech: { playback: e.target.checked } })} aria-label="Speak replies aloud" />
            </label>
          </Tooltip>
        </div>
      </div>
      <div className="kb-row voice-picker-row">
        <label className="kb-row-label" htmlFor="spoken-voice">Voice</label>
        <div className="kb-row-controls">
          <Tooltip label="Choose the voice that asks questions aloud">
            <select className="settings-select" id="spoken-voice" aria-describedby="spoken-voice-status"
              value={optionValue(choice)} disabled={!config || !speech || busy} onChange={e => void perform(() => select(e.target.value))}>
              <option value="">Automatic{automatic && speech ? `: ${voiceName(automatic, speech.catalog)}` : ""}</option>
              <optgroup label="Mission Control voices">
                {neural.map(v => <option key={v.id} value={`neural:${v.id}`}>{v.name}{choice?.engine === "neural" && choice.id === v.id && model?.status !== "ready" ? ", not available" : ""}</option>)}
              </optgroup>
              {system.length > 0 && <optgroup label="This Mac's voices">
                {system.map(v => <option key={v.id} value={`system:${v.id}`}>{v.name}{v.detail === "premium" ? " (Premium)" : v.detail === "enhanced" ? " (Enhanced)" : " (Standard)"}</option>)}
              </optgroup>}
              {unlisted && <option value={optionValue(choice)}>{choice.id}, not available</option>}
            </select>
          </Tooltip>
          <Tooltip label={liveSample ? "Stop the current voice sample" : sampleReason ?? "Hear a sample in the selected voice"}>
            <button className="btn btn-ghost" type="button" disabled={liveSample ? stopPending || liveSample.state === "stopping" : busy || !!sampleReason}
              onClick={() => void perform(sample, liveSample ? setStopPending : setPickerPending)}>{liveSample ? "Stop" : "Play sample"}</button>
          </Tooltip>
        </div>
        <p className="kb-row-desc" id="spoken-voice-status" role="status">{status}</p>
      </div>
      {model && model.status !== "ready" && <div className="kb-row">
        <div className="kb-row-text">
          <span className="kb-row-label">{model.status === "downloading" ? "Downloading Mission Control voices" :
            model.status === "verifying" ? "Checking Mission Control voices" : "Mission Control voices are not downloaded."}</span>
          <span className="kb-row-desc">Licence: {licence}.{" "}
            <Tooltip label="Read the model licence and its use restrictions">
              <a href="https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE" target="_blank" rel="noreferrer">What it restricts</a>
            </Tooltip>
          </span>
          {model.status === "failed" && <span className="kb-row-desc">{downloadSize}</span>}
          {model.error && <span className="settings-error">{model.error}</span>}
        </div>
        {model.status === "downloading" || model.status === "verifying"
          ? <VoiceModelProgress model={model} busy={busy} onCancel={() => void perform(async () => {
            const result = await api.cancelVoiceSpeechDownload();
            if (!result.ok) setError(result.error ?? "Could not cancel the download.");
          })} />
          : canDownload && <Tooltip label="Download the shared model for all ten Mission Control voices">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void perform(download)}>
              {model.status === "failed" ? "Retry" : `Download ${downloadSize}`}
            </button>
          </Tooltip>}
      </div>}
      {macListener && <p className="settings-hint">Install better Apple voices in {appleSettings}. Mission Control cannot download them.</p>}
      {(error || sampleFailed) && <p role="alert" className="settings-error">{error ?? "The sample did not finish. Check the listener and try again."}</p>}
    </section>
  );
}
