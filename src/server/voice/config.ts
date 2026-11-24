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
let lastOptOut = 0;
let reservedOff: { order: number; writer: string; edit: number; otherWriterOrder: number } | undefined;
let lastWriter: string | undefined;
let writerBase = 0;

export function providerRevision(): string {
  return `${instance}:${applied}`;
}

function issueProviderOrder(): number {
  latestIntentAt = performance.now();
  return ++issued;
}

/** A gesture may retry only across an interval with no intervening selection. */
export function providerIntentWindow() {
  return { token: `${instance}:${issued}:${applied}`, quietForMs: performance.now() - latestIntentAt, pendingOff: (reservedOff?.order ?? 0) > applied };
}

function canApply(writer: string, base: number): boolean {
  // A window can supersede its own unacknowledged PUT. Any intervening writer or restore
  // ends that sequence, including a write which picked the same provider again.
  return base === applied || (writer === lastWriter && base >= writerBase && base < applied);
}

/** Reserve the order of a dashboard selection before its config write can be delayed. */
export function reserveProviderWrite(writer: string, revision: string, optOut: boolean, edit = 0, unchangedSince?: string): string | null {
  if (unchangedSince !== undefined && unchangedSince !== providerIntentWindow().token) return null;
  if (!optOut && reservedOff && reservedOff.order > applied && !unchangedSince) {
    // Clicks within one window already have an order, even when both requests
    // were held in transit. This exception cannot supersede another window's Off.
    if (writer !== reservedOff.writer || edit <= reservedOff.edit || reservedOff.otherWriterOrder > applied) return null;
  }
  const base = Number(revision.slice(instance.length + 1));
  if (revision !== `${instance}:${base}` || !Number.isSafeInteger(base) || !canApply(writer, base)) return null;
  const order = issueProviderOrder();
  if (optOut) {
    reservedOff = reservedOff?.writer === writer
      ? { ...reservedOff, order, edit: Math.max(reservedOff.edit, edit) }
      : { order, writer, edit, otherWriterOrder: reservedOff?.order ?? 0 };
  }
  return `${instance}:${order}:${writer}:${base}${optOut ? ":off" : ""}`;
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
    const optOut = ticket.endsWith(":off");
    if (patch.decisionProvider === undefined || (optOut && patch.decisionProvider !== "off") || !Number.isSafeInteger(order) || order <= applied ||
        order > issued || epoch !== instance || !author || !Number.isSafeInteger(base) || base < 0 || base > applied ||
        ticket !== `${instance}:${order}:${author}:${base}${optOut ? ":off" : ""}`) return null;
    // Tickets order explicit switches across windows. Remember an intervening Off
    // even if another opt-in has since changed the displayed provider.
    if (patch.decisionProvider !== "off" && base < lastOptOut && !canApply(author, base)) return null;
    writer = author;
  }
  const next = applyVoiceConfigPatch(getVoiceConfig(), patch);
  setAppConfig(ENTRY, next);
  if (patch.decisionProvider !== undefined) {
    if (writer !== lastWriter) writerBase = applied;
    lastWriter = writer;
    applied = order ?? issueProviderOrder();
    if (patch.decisionProvider === "off") lastOptOut = applied;
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
