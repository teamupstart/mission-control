import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  voiceCapable, VOICE_INDICATOR_IDS, type VoiceIndicatorId, type VoiceMode, type VoiceState,
} from "@shared/voice.ts";
import { api } from "../lib/api.ts";
import { formatChord } from "../lib/keybindings.ts";
import { useUiConfig } from "../lib/uiConfig.ts";
import { saveIndicatorSelection, useVoiceSettingsActions } from "../lib/voice-settings-actions.ts";
import { Keycap } from "./Keycap.tsx";
import { Tooltip } from "./Tooltip.tsx";

export const VoiceWindow = createContext<{
  state: VoiceState;
  mutePending: boolean;
  setMuted(muted: boolean): Promise<void>;
  openSetup(): void;
} | null>(null);

export function VoiceWindowProvider({ state, enabled, acknowledgeVoiceMode, openSetup, children }: {
  state: VoiceState | null; enabled: boolean; acknowledgeVoiceMode(ack: VoiceState): void; openSetup(): void; children: ReactNode;
}) {
  const [failure, setFailure] = useState<{ muted: boolean; message: string } | null>(null);
  const [pendingMute, setPendingMute] = useState<boolean | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!enabled) setPendingMute(null);
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [enabled]);
  const setMuted = useCallback(async (muted: boolean) => {
    if (activeRequest.current) return;
    const request = new AbortController();
    activeRequest.current = request;
    setPendingMute(muted);
    setFailure(null);
    const deadline = AbortSignal.timeout(5000);
    const result = await api.setVoiceMuted(muted, AbortSignal.any([request.signal, deadline]));
    if (request.signal.aborted) return;
    if (result.ok && result.state) acknowledgeVoiceMode(result.state);
    activeRequest.current = null;
    setPendingMute(null);
    if (deadline.aborted || !result.ok) {
      const message = deadline.aborted
        ? "Voice mute change timed out. The result is unconfirmed. Check the indicator and retry if needed."
        : result.error ?? "Could not change voice mute.";
      setFailure({ muted, message });
    }
  }, [acknowledgeVoiceMode]);
  const mode = state?.mode;
  const showFailure = failure && enabled && mode && mode !== "off"
    && (mode === "unavailable" || (mode === "muted") !== failure.muted);
  // Retire the alert when any window achieves the requested state. A later unmute must
  // not resurrect an old mute failure.
  useEffect(() => {
    if (failure && !showFailure) setFailure(null);
  }, [failure, showFailure]);
  const value = useMemo(() => enabled && state ? {
    state, openSetup, setMuted, mutePending: pendingMute !== null,
  } : null, [enabled, state, openSetup, setMuted, pendingMute]);
  return <VoiceWindow.Provider value={value}>
    {children}
    {enabled && <div className={pendingMute === null ? "sr-only" : "vi-window-feedback"} role="status">
      {pendingMute !== null && (pendingMute ? "Muting voice…" : "Unmuting voice…")}
    </div>}
    {showFailure && <div className="vi-window-feedback">
      <span role="alert">{failure.message}</span>
      <Tooltip label="Dismiss voice error"><button type="button" className="btn btn-ghost"
        aria-label="Dismiss voice error" onClick={() => setFailure(null)}>Dismiss</button></Tooltip>
    </div>}
  </VoiceWindow.Provider>;
}

export function confirmedVoiceHotkey(state: VoiceState): string | null {
  const chord = state.registeredHotkey;
  return chord && chord === state.configuredHotkey && !state.pendingHotkey && voiceCapable(state, "hotkey") && (!state.hotkeyError || state.hotkeyError.chordInForce === chord) ? chord : null;
}

const modes = {
  listening: ["Listening", "Say a name, then your message.", "M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z M4 7.5a4 4 0 0 0 8 0M8 11.5v3M5.5 14.5h5"],
  muted: ["Muted", "Nothing is heard until you unmute.", "M10 6V3.5a2 2 0 0 0-3.7-1M6 6v1.5a2 2 0 0 0 3 1.7 M4 7.5a4 4 0 0 0 6.3 3.3M12 7.5a4 4 0 0 1-.3 1.5M8 11.5v3M5.5 14.5h5M2 1.5l12 13"],
  "waiting-for-key": ["Waiting for hotkey", "Microphone off until the hotkey is held.", "M10 6V3.5a2 2 0 0 0-3.7-1M6 6v1.5a2 2 0 0 0 3 1.7 M4 7.5a4 4 0 0 0 6.3 3.3M8 11.5v3M5.5 14.5h5M2 1.5l12 13"],
  "auto-muted": ["On a call", "Another app is using the microphone.", "M3 2.5h2.5l1 3-1.5 1a7 7 0 0 0 3.5 3.5l1-1.5 3 1V12a1.5 1.5 0 0 1-1.5 1.5A9.5 9.5 0 0 1 1.5 4 1.5 1.5 0 0 1 3 2.5z"],
  "push-to-talk": ["Talk", "Listening while held.", "M8 3a1.7 1.7 0 0 0-1.7 1.7v3a1.7 1.7 0 0 0 3.4 0v-3A1.7 1.7 0 0 0 8 3z M4.8 8a3.2 3.2 0 0 0 6.4 0M8 11.2v2.3M2 4.5a7 7 0 0 0 0 5.5M14 4.5a7 7 0 0 1 0 5.5"],
  unavailable: ["Not listening", "Open Setup to see what voice needs.", "M8 2l6 11H2zM8 6v3m0 2v.1"],
} as const;

const styles: Record<VoiceIndicatorId, string> = {
  "status-line": "Status line", topbar: "Top-bar segment", floating: "Floating button",
  edge: "Edge light", composer: "Composer microphone",
};

export function VoiceIndicatorButton({ id, mode, chord, onClick, pending, showHoldHint }: {
  id: VoiceIndicatorId; mode: Exclude<VoiceMode, "off">; chord?: string; onClick?: () => void; pending?: boolean; showHoldHint?: boolean;
}): React.JSX.Element {
  const [word, hint, path] = modes[mode];
  const action = mode === "muted" ? "Unmute" : mode === "unavailable" ? "Open Setup" : "Mute";
  const clickAction = `Click to ${action.toLowerCase()}`;
  const holdAction = mode === "auto-muted" || mode === "push-to-talk" ? "to talk" : "to talk during call auto-mute";
  const shortcut = chord && <>Hold <Keycap chord={chord} /> {holdAction}</>;
  const actions = <>{clickAction}{shortcut && <span className="vi-shortcut"> · {shortcut}</span>}</>;
  const name = `Voice: ${word.toLowerCase()}. ${action}`;
  const tip = `${hint} ${clickAction}.`;
  const cls = `vi vi-${id} vi-${mode}${id === "topbar" ? " pulse-seg pulse-btn" : ""}`;
  const inlineHoldHint = id === "floating" || id === "status-line";
  const holding = showHoldHint && mode === "push-to-talk";
  const stateLabel = holding ? "Listening while held" : word;
  const face = <>
    <svg width="14" height="14" aria-hidden="true" viewBox="0 0 16 16"><path d={path} /></svg>
    <span className={id === "topbar" ? "tb-label" : "vi-word"}>{stateLabel}</span>
    {id === "status-line" && onClick && <><span className="vi-hint">{hint}</span><span className="vi-action">{actions}</span></>}
    {showHoldHint && inlineHoldHint && <span className={id === "floating" ? "vi-expanded" : "vi-action"}>{holding ? "Release to finish" : <>Hold {chord
      ? <><Keycap chord={chord} /><span className="sr-only">{formatChord(chord)}</span></>
      : "the hotkey"} to talk</>}</span>}
    {id === "floating" && onClick && <span className="vi-expanded">· {actions}</span>}
  </>;
  const button = onClick ? <Tooltip label={{
    description: `${tip}${chord ? ` Hold ${formatChord(chord)} ${holdAction}. Tap the shortcut to toggle mute.` : ""}`,
    // The floating control expands into its own hint on hover or focus.
    content: id === "floating" ? null : <>{tip}{shortcut && <> {shortcut}. Tap the shortcut to toggle mute.</>}</>,
  }}><button type="button" className={cls} aria-label={name} aria-disabled={pending || undefined} onClick={pending ? undefined : onClick}>{face}</button></Tooltip>
    : showHoldHint && !inlineHoldHint
      ? <Tooltip label={holding ? "Release to finish" : `Hold ${chord ? formatChord(chord) : "the hotkey"} to talk`}>
        <span className={cls} role="status" aria-label={`Voice: ${stateLabel}`} tabIndex={0}>{face}</span>
      </Tooltip>
      : <span className={cls} role={showHoldHint ? "status" : undefined}>{face}</span>;
  return id === "edge" ? <div className={`vi-edge-line vi-${mode}`}>{button}</div> : button;
}

export function useVoiceComposerHint(sessionId: string): string | null {
  const voice = useContext(VoiceWindow);
  const ui = useUiConfig();
  if (!voice || !ui.voice.indicators.includes("composer")) return null;
  const { state } = voice;
  switch (state.mode) {
    case "listening": {
      const name = state.roster.find(entry => entry.sessionId === sessionId)?.name;
      return name ? `Message to send… or say "${name}, …"` : null;
    }
    case "waiting-for-key": return "Hold the voice hotkey to talk";
    case "muted": return "Voice is muted";
    case "push-to-talk": return "Listening while held";
    case "auto-muted": {
      const chord = confirmedVoiceHotkey(state);
      return chord && ui.keybindingHints ? `On a call · hold ${formatChord(chord)} to talk` : "On a call";
    }
    default: return null;
  }
}

export function VoiceIndicator({ id }: { id: VoiceIndicatorId }): React.JSX.Element | null {
  const voice = useContext(VoiceWindow);
  const ui = useUiConfig();
  if (!voice || voice.state.mode === "off" || !ui.voice.indicators.includes(id)) return null;
  const { state, openSetup, setMuted } = voice;
  const chord = ui.keybindingHints && state.mode !== "unavailable" ? confirmedVoiceHotkey(state) : null;
  const activate = () => {
    if (state.mode === "unavailable") openSetup();
    else void setMuted(state.mode !== "muted");
  };
  return <VoiceIndicatorButton id={id} mode={voice.state.mode} chord={chord ?? undefined}
    showHoldHint={!!state.pushToTalkSession && state.mode !== "unavailable"}
    onClick={state.pushToTalkSession && state.mode !== "unavailable" ? undefined : activate}
    pending={voice.mutePending && state.mode !== "unavailable"} />;
}

const previewModes = ["listening", "muted", "auto-muted", "push-to-talk"] as const;

export function VoiceIndicatorSettings(): React.JSX.Element {
  const { voice } = useUiConfig();
  const { saving, indicatorError } = useVoiceSettingsActions();
  return <fieldset className="settings-group vi-settings" data-anchor="voice/indicators">
    <legend className="settings-group-label">In the window</legend>
    {VOICE_INDICATOR_IDS.map(id => <div className="vi-choice" key={id}>
      <Tooltip label={`Show the ${styles[id].toLowerCase()} in the window`}><label className="kb-row-label">
        <input type="checkbox" disabled={saving !== null} checked={saving?.id === id ? saving.enabled : voice.indicators.includes(id)}
          onChange={e => void saveIndicatorSelection(id, e.target.checked)} /> {styles[id]}
      </label></Tooltip>
      <div className="vi-samples">{previewModes.map(mode => <div className="vi-sample" key={mode}>
        <VoiceIndicatorButton id={id} mode={mode} />
        {(id === "floating" || id === "composer") && <span className="kb-row-desc">{modes[mode][0]}</span>}
      </div>)}</div>
    </div>)}
    {indicatorError && <p className="settings-error" role="alert">{indicatorError}</p>}
  </fieldset>;
}
