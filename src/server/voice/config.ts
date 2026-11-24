import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  VOICE_BACKEND_CHOICES,
  applyVoiceConfigPatch,
  VOICE_CONFIG_DEFAULTS,
  VoiceConfigSchema,
  type VoiceConfig,
  type VoiceConfigPatch,
} from "@shared/voice.ts";
import { getAppConfig, setAppConfig } from "../db.ts";

// The daemon's one owner of `app_config.voice`: a schema-checked blob, read with defaults applied
// so a key an older build never wrote needs no migration, and written through one function that
// tells the voice state about it. The voice state is the only listener today; it recomputes the
// mode, which reads `muted` and `autoMuteDuringCalls`.

const ENTRY = APP_CONFIG_ENTRIES.voice;
type Listener = (config: VoiceConfig) => void;
const listeners = new Set<Listener>();

/** The current config, with schema defaults applied over whatever was stored. */
function storedConfig(): VoiceConfig {
  const parsed = VoiceConfigSchema.safeParse(getAppConfig(ENTRY) ?? {});
  if (parsed.success) return parsed.data;
  // A value this build cannot read reads as the defaults; the next write replaces it whole.
  console.warn("[voice] stored config does not parse; using defaults:", parsed.error.issues[0]?.message);
  return structuredClone(VOICE_CONFIG_DEFAULTS);
}

function effectiveConfig(config: VoiceConfig): VoiceConfig {
  const override = VOICE_BACKEND_CHOICES.find(choice => choice === process.env.MISSION_VOICE_BACKEND);
  return override ? { ...config, backend: override } : config;
}

export function getVoiceConfig(): VoiceConfig {
  return effectiveConfig(storedConfig());
}

function notify(config: VoiceConfig): void {
  for (const listener of Array.from(listeners)) {
    try { listener(config); }
    catch (error) { console.warn("[voice] config listener failed:", error); }
  }
}

/** Merge a patch over the current config, persist it, and tell the listeners. */
export function setVoiceConfig(patch: VoiceConfigPatch): VoiceConfig {
  const next = applyVoiceConfigPatch(storedConfig(), patch);
  setAppConfig(ENTRY, next);
  const config = effectiveConfig(next);
  notify(config);
  return config;
}

/** A settings restore rewrote the row: tell the listeners what it holds now. */
export function reloadVoiceConfig(): VoiceConfig {
  const config = getVoiceConfig();
  notify(config);
  return config;
}

export function onVoiceConfigChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
