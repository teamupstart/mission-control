import { beginOperation, type AppOperation } from "./operation-context.ts";
import { FEATURE_EVENT, RENDERER_ERROR_EVENT, CONNECTION_EVENT, ERROR_ID_HEADER, type FeatureId } from "@shared/telemetry-sources/experience.ts";
import type { TelemetryIngressRecord, TelemetryOperationSurface } from "@shared/telemetry-ingress.ts";
import { matchPrimaryAction } from "@shared/telemetry-sources/primary-actions.ts";
import { matchWorkflowAction } from "@shared/workflow-actions.ts";

const LIMIT = 32;
type Item = { operation: AppOperation; record: TelemetryIngressRecord; attempts: number };
const pending: Item[] = [];
let flushing = false;
let timer: ReturnType<typeof setTimeout> | undefined;
function enqueue(record: TelemetryIngressRecord, operation = beginOperation("topbar")): void {
  if (pending.length === LIMIT) pending.shift();
  pending.push({ record: { ...record, occurredAt: Date.now() }, operation, attempts: 0 });
  if (!timer) timer = setTimeout(() => { timer = undefined; void flushExperience(); }, 150);
}
/** A finite volatile queue. A retry keeps the exact record, timestamp and operation id. */
export async function flushExperience(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (pending.length) {
      const item = pending[0]!;
      if (Date.now() - (item.record.occurredAt ?? 0) > 300_000 || item.attempts >= 3) { pending.shift(); continue; }
      item.attempts++;
      try {
        const response = await fetch("/api/telemetry/ingress", { method: "POST",
          headers: { "content-type": "application/json", ...item.operation.headers },
          body: JSON.stringify({ records: [item.record] }), signal: AbortSignal.timeout(2000) });
        if (response.status >= 500) break;
        if (pending[0] === item) pending.shift(); // A refusal is terminal and does not fail the UI.
      } catch { break; }
    }
  } finally {
    flushing = false;
    if (pending.length && !timer) {
      timer = setTimeout(() => { timer = undefined; void flushExperience(); }, Math.min(4_000, 1_000 * 2 ** pending[0]!.attempts));
    }
  }
}
const visits = new Map<string, { key: string }>();
/** Keys can contain local navigation identity, but only the declared feature/action leaves the page. */
export function featureVisit(channel: string, key: string, feature: FeatureId, action: "enter" | "select" = "enter"): () => void {
  const previous = visits.get(channel);
  const visit = { key };
  if (visits.size >= 16 && !visits.has(channel)) visits.delete(visits.keys().next().value!);
  visits.set(channel, visit);
  if (previous?.key !== key) featureAction(feature, action);
  // StrictMode immediately sets the effect up again. Only a departure with no replacement
  // ends the visit; an old cleanup must also leave a newly mounted reader alone.
  return () => queueMicrotask(() => { if (visits.get(channel) === visit) visits.delete(channel); });
}
export function endFeatureVisit(channel: string): void { visits.delete(channel); }
export function featureAction(feature: FeatureId, action: "enter" | "select" | "filter" | "no_results" | "dismiss" | "cancel" | "complete"): void {
  enqueue({ event: FEATURE_EVENT.name, facts: { feature, action } });
}
const reported = new WeakSet<object>();
const loops = new Map<string, { at: number; suppressed: number; timer: ReturnType<typeof setTimeout> }>();
function appFrame(error: unknown): string {
  if (!(error instanceof Error) || typeof window === "undefined") return "unknown";
  // Select app bundle coordinates only. Do not send or hash the stack, symbol, host or path.
  for (const line of (error.stack ?? "").split("\n").slice(0, 12)) {
    const match = /(?:\(|\s)(https?:\/\/[^\s)]+):(\d{1,6}):(\d{1,6})\)?$/.exec(line);
    if (!match) continue;
    try {
      const url = new URL(match[1]!);
      if (url.origin === window.location.origin && /^\/assets\/[^/]+\.js$/.test(url.pathname)) return `app:${match[2]}:${match[3]}`;
    } catch { /* A foreign or invalid frame provides no app fingerprint. */ }
  }
  return "unknown";
}
export function reportBrowserError(error: unknown, code: "exception" | "rejection" | "disconnected", operation?: AppOperation, handled = true): void {
  try { observeBrowserError(error, code, operation, handled); }
  catch { /* Even a hostile stack accessor must not turn reporting into another error. */ }
}
function observeBrowserError(error: unknown, code: "exception" | "rejection" | "disconnected", operation: AppOperation | undefined, handled: boolean): void {
  if (error && typeof error === "object") {
    const status = Object.getOwnPropertyDescriptor(error, "status")?.value;
    // Typed API errors already belong to the owner result (including expected refusals).
    if (typeof status === "number" && status >= 400 && status < 600) return;
    if (reported.has(error)) return;
    reported.add(error);
  }
  const fingerprint = appFrame(error);
  const key = `${code}:${fingerprint}`;
  const previous = loops.get(key);
  const now = Date.now();
  if (previous && now - previous.at < 60_000) { previous.suppressed = Math.min(1000000, previous.suppressed + 1); return; }
  if (previous) { clearTimeout(previous.timer); loops.delete(key); }
  if (loops.size >= 32) {
    const oldest = loops.keys().next().value!;
    clearTimeout(loops.get(oldest)!.timer);
    loops.delete(oldest);
  }
  const facts = { component: code === "disconnected" ? "connection" : "renderer", family: code === "disconnected" ? "transport" : "renderer",
    code, retryable: code === "disconnected" ? "yes" : "unknown", handled, fingerprint, suppressed: 0 };
  if (previous?.suppressed) enqueue({ event: RENDERER_ERROR_EVENT.name, facts: { ...facts, suppressed: previous.suppressed } });
  const loop = { at: now, suppressed: 0, timer: setTimeout(() => {
    // Report the loop's size even when the application stops throwing. A detached page can
    // still lose this volatile summary; it must never hold the page open for telemetry.
    if (loop.suppressed) enqueue({ event: RENDERER_ERROR_EVENT.name, facts: { ...facts, suppressed: loop.suppressed } }, operation);
    if (loops.get(key) === loop) loops.delete(key);
  }, 60_000) };
  loops.set(key, loop);
  enqueue({ event: RENDERER_ERROR_EVENT.name, facts }, operation);
}
/** Apply app context once at the client boundary. Callers retrying pass the same operation. */
export async function actionFetch(path: string, init: RequestInit = {}, operation?: AppOperation): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" || path.startsWith("/api/telemetry/")) return fetch(path, init);
  const entry = matchPrimaryAction(method, path.split("?")[0]!);
  const workflow = matchWorkflowAction(method, path.split("?")[0]!);
  const surface: TelemetryOperationSurface = entry?.feature === "files" ? "files" : entry?.feature === "library" ? "library"
    : entry?.feature === "settings" || entry?.feature === "setup" ? "settings" : workflow ? "runs" : "board";
  const op = operation ?? beginOperation(surface);
  const headers = new Headers(op.headers);
  new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  try {
    const response = await fetch(path, { ...init, headers });
    // A server occurrence is already authoritative. Keep it out of renderer error counts.
    if (response.status >= 500 && !response.headers.has(ERROR_ID_HEADER)) reportBrowserError(null, "rejection", op);
    return response;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) reportBrowserError(error, "disconnected", op);
    throw error;
  }
}
let installed = false;
export function installExperienceReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("online", () => { void flushExperience(); });
  window.addEventListener("error", (event) => reportBrowserError(event.error, "exception", undefined, false));
  window.addEventListener("unhandledrejection", (event) => reportBrowserError(event.reason, "rejection", undefined, false));
}

let connectedBefore = false;
let disconnectedAt: number | null = null;
export function observeBrowserConnection(connected: boolean): void {
  if (connected) {
    if (disconnectedAt !== null) enqueue({ event: CONNECTION_EVENT.name, facts: { duration_ms: Math.min(86400000, Math.max(0, Date.now() - disconnectedAt)) } });
    disconnectedAt = null;
    connectedBefore = true;
    void flushExperience();
  } else if (connectedBefore && disconnectedAt === null) {
    disconnectedAt = Date.now();
    reportBrowserError(null, "disconnected");
  }
}
