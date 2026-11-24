import { useState } from "react";
import { VOICE_CONFIRMATION_PLACEMENTS, voiceCapable, type VoiceState, type VoiceConfirmationPlacement } from "@shared/voice.ts";
import { updateVoicePlacement, useUiConfig } from "../lib/uiConfig.ts";
import { Tooltip } from "./Tooltip.tsx";

const choices = { pill: "Floating pill", toast: "Corner toast", popover: "Tray popover" } as const;
export function VoiceCardPlacement({ state }: { state: VoiceState | null }) {
  const { voice } = useUiConfig();
  const [saving, setSaving] = useState<VoiceConfirmationPlacement | null>(null);
  const [error, setError] = useState("");
  const save = async (placement: VoiceConfirmationPlacement) => {
    setSaving(placement);
    const saved = await updateVoicePlacement(placement);
    setError(saved ? "" : "Could not save the confirmation card placement.");
    setSaving(null);
  };
  return <fieldset className="settings-group vc-placements" data-anchor="voice/confirmation">
    <legend className="settings-group-label">Confirmation card</legend>
    <div>{VOICE_CONFIRMATION_PLACEMENTS.map(id => <label key={id}>
      <span className={`vc-preview vc-preview-${id}`} aria-hidden="true"><i /></span>
      <span><Tooltip label={`Save ${choices[id]} as your preferred confirmation card placement`}>
        <input type="radio" name="voice-placement" checked={(saving ?? voice.confirmation) === id} disabled={saving !== null}
          onChange={() => void save(id)} />
      </Tooltip> {choices[id]}</span>
      {id !== "toast" && !voiceCapable(state, "floating-windows") && <small>Needs the desktop app</small>}
    </label>)}</div>{error && <p role="alert">{error}</p>}
  </fieldset>;
}
