import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  applyVoiceConfigPatch,
  VOICE_CONFIG_DEFAULTS,
  VoiceConfigSchema,
  type VoiceConfig,
  type VoiceConfigPatch,
  type VoiceProviderIntent,
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
const ticketKey = randomBytes(32);
let issued = 0;
let receiptNonce = randomUUID();
let latestIntentAt = performance.now();
let applied = 0;
let lastOptOut = 0;
let reservation: {
  order: number; writer: string; edit: number; otherWriterOrder: number; optOut: boolean;
  gesture: VoiceProviderIntent["gesture"]; otherGroupOrder: number;
} | undefined;
let lastWriter: string | undefined;
let writerBase = 0;

export function providerRevision(): string {
  return `${instance}:${applied}`;
}

export function providerIntentReceipt(): string {
  return `${instance}:${issued}:${receiptNonce}`;
}

function issueProviderOrder(): number {
  latestIntentAt = performance.now();
  receiptNonce = randomUUID();
  return ++issued;
}

/** A gesture may retry only across an interval with no intervening selection. */
export function providerIntentWindow() {
  return { token: `${instance}:${issued}:${applied}`, receipt: providerIntentReceipt(),
    quietForMs: performance.now() - latestIntentAt, pendingSelection: issued > applied };
}

function canApply(writer: string, base: number): boolean {
  // A window can supersede its own unacknowledged PUT. Any intervening writer or restore
  // ends that sequence, including a write which picked the same provider again.
  return base === applied || (writer === lastWriter && base >= writerBase && base < applied);
}

function signTicket(payload: string): string {
  return createHmac("sha256", ticketKey).update(payload).digest("base64url");
}

/** Reserve the order of a dashboard selection before its config write can be delayed. */
export function reserveProviderWrite(intent: VoiceProviderIntent): string | null {
  const { writer, observedRevision: revision, optOut = false, edit = 0, unchangedSince, observedIntent, gesture } = intent;
  let base = Number(revision.slice(instance.length + 1));
  if (revision !== `${instance}:${base}` || !Number.isSafeInteger(base) || base < 0 || base > applied) return null;
  const previous = reservation?.gesture;
  const sameGroup = gesture && previous && gesture.group === previous.group;
  if (sameGroup && gesture.order <= previous.order) return null;
  // Browser order only compares gestures sharing one local counter. An intervening
  // selection from another browser or a direct config write still needs to be observed.
  const otherGroupOrder = sameGroup && reservation?.order === issued ? reservation.otherGroupOrder : issued;
  const followsGesture = sameGroup && otherGroupOrder <= base;
  const observedLatest = observedIntent === providerIntentReceipt();
  if (unchangedSince !== undefined && unchangedSince !== providerIntentWindow().token && !(optOut && observedLatest)) return null;
  if (reservation && reservation.order > applied && !unchangedSince && !observedLatest && !followsGesture && (edit > 0 || reservation.edit > 0 || reservation.optOut)) {
    if (writer !== reservation.writer || edit <= reservation.edit || reservation.otherWriterOrder > applied) return null;
  }
  if (!canApply(writer, base)) {
    if (!optOut || !(followsGesture || (unchangedSince && observedLatest))) return null;
    base = applied;
  }
  // A receipt establishes that this gesture followed the observed reservation,
  // even if that reservation's PUT has not updated the config yet.
  const observedOrder = observedLatest || followsGesture ? issued : base;
  const order = issueProviderOrder();
  const own = reservation?.writer === writer ? reservation : undefined;
  reservation = { order, writer, optOut, gesture, otherGroupOrder,
    edit: Math.max(own?.edit ?? 0, edit),
    otherWriterOrder: own?.otherWriterOrder ?? reservation?.order ?? 0 };
  const payload = `${order}:${writer}:${observedOrder}:${optOut ? "off" : "switch"}`;
  return `${payload}:${signTicket(payload)}`;
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
    const end = ticket.lastIndexOf(":");
    const payload = ticket.slice(0, end);
    if (end < 0 || signTicket(payload) !== ticket.slice(end + 1)) return null;
    const [number, author, observed, mode] = payload.split(":");
    if (!author) return null;
    order = Number(number);
    const observedOrder = Number(observed);
    if (patch.decisionProvider === undefined || (mode === "off" && patch.decisionProvider !== "off") || order <= applied) return null;
    // Tickets order explicit switches across windows. Remember an intervening Off
    // even if another opt-in has since changed the displayed provider.
    if (patch.decisionProvider !== "off" && observedOrder < lastOptOut && !canApply(author, observedOrder)) return null;
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
