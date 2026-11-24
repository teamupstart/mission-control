import { randomUUID } from "node:crypto";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
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
const instance = randomUUID();
let issued = 0;
let latestIntentAt = performance.now();
let applied = 0;
let lastWriter: string | undefined;
let writerBase = 0;

export function providerRevision(): string {
  return `${instance}:${applied}`;
}

function issueProviderOrder(): number {
  latestIntentAt = performance.now();
  return ++issued;
}

/** A stale opt-out may retry only across an interval with no intervening selection. */
export function providerIntentWindow(): { token: string; quietForMs: number } {
  return { token: `${instance}:${issued}`, quietForMs: performance.now() - latestIntentAt };
}

function canApply(writer: string, base: number): boolean {
  // A window can supersede its own unacknowledged PUT. Any intervening writer or restore
  // ends that sequence, including a write which picked the same provider again.
  return base === applied || (writer === lastWriter && base >= writerBase && base < applied);
}

/** Reserve the order of a dashboard selection before its config write can be delayed. */
export function reserveProviderWrite(writer: string, revision: string, unchangedSince?: string): string | null {
  if (unchangedSince !== undefined && unchangedSince !== `${instance}:${issued}`) return null;
  const base = Number(revision.slice(instance.length + 1));
  if (revision !== `${instance}:${base}` || !Number.isSafeInteger(base) || !canApply(writer, base)) return null;
  return `${instance}:${issueProviderOrder()}:${writer}:${base}`;
}

/** The current config, with schema defaults applied over whatever was stored. */
export function getVoiceConfig(): VoiceConfig {
  const parsed = VoiceConfigSchema.safeParse(getAppConfig(ENTRY) ?? {});
  if (parsed.success) return parsed.data;
  // A value this build cannot read reads as the defaults; the next write replaces it whole.
  console.warn("[voice] stored config does not parse; using defaults:", parsed.error.issues[0]?.message);
  return structuredClone(VOICE_CONFIG_DEFAULTS);
}

function notify(config: VoiceConfig): void {
  for (const listener of Array.from(listeners)) {
    try { listener(config); }
    catch (error) { console.warn("[voice] config listener failed:", error); }
  }
}

/** Merge a patch over the current config, persist it, and tell the listeners. */
export function setVoiceConfig(patch: VoiceConfigPatch): VoiceConfig;
export function setVoiceConfig(patch: VoiceConfigPatch, ticket: string | undefined): VoiceConfig | null;
export function setVoiceConfig(patch: VoiceConfigPatch, ticket?: string): VoiceConfig | null {
  let order: number | undefined;
  let writer: string | undefined;
  if (ticket !== undefined) {
    const [epoch, number, author, revision] = ticket.split(":");
    order = Number(number);
    const base = Number(revision);
    if (patch.decisionProvider === undefined || !Number.isSafeInteger(order) || order <= applied ||
        order > issued || epoch !== instance || !author || !Number.isSafeInteger(base) || base < 0 || base > applied ||
        ticket !== `${instance}:${order}:${author}:${base}`) return null;
    // A newer opt-out can stop an older writer's provider. Enabling a provider still
    // requires a current observation, so an intervening Off cannot be undone by surprise.
    if (patch.decisionProvider !== "off" && !canApply(author, base)) return null;
    writer = author;
  }
  const next = applyVoiceConfigPatch(getVoiceConfig(), patch);
  setAppConfig(ENTRY, next);
  if (patch.decisionProvider !== undefined) {
    if (writer !== lastWriter) writerBase = applied;
    lastWriter = writer;
    applied = order ?? issueProviderOrder();
  }
  notify(next);
  return next;
}

/** A settings restore rewrote the row: tell the listeners what it holds now. */
export function reloadVoiceConfig(): VoiceConfig {
  const config = getVoiceConfig();
  applied = issueProviderOrder();
  lastWriter = undefined;
  notify(config);
  return config;
}

export function onVoiceConfigChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
