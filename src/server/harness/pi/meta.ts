import type { ThinkingLevel } from "@shared/types.ts";
import { THINKING_LEVELS } from "@shared/types.ts";
import { DEFAULT_CONTEXT_WINDOW, effectiveContextWindow, isLongContext } from "@shared/model.ts";
import type { RuntimeMetaRead, SessionActivityRead, TranscriptPassiveRead } from "../types.ts";
import { readTailLines } from "../../util/file-tail.ts";

// What a Pi transcript says about a session's live runtime, off one bounded tail read.
//
// Every shape read here is pi's own: the `message.usage` token fields, the `model_change` /
// `thinking_level_change` records, and the `stopReason` vocabulary. Claude and Codex answer
// the same two questions from entirely different files, which is the whole reason these are
// behind a capability rather than inline in the poller.
//
// Unlike Codex's rollout, a pi transcript carries BOTH axes off the same lines: runtime
// metadata AND a real idle/working signal, because its records are turns with a clean
// stop reason. So `passiveRead` fills both, like Claude's - it does not fall back to the pane.
//
// `usage` (the SessionCost tier counts) is deliberately NOT populated. pi records real
// per-message token AND dollar cost, but per message, not as a cumulative session total, and
// the passive read only sees the tail - summing it would understate a long session. pi has no
// need to aggregate here: the request-level UsageSpec feeds the ledger once the launch or
// extension establishes a session identity. The tail remains metadata and activity only.

/** Bytes to scan from the tail for a passive read - the newest record captured whole. */
export const PASSIVE_TAIL_BYTES = 256 * 1024;

/** pi thinking levels the app also has a name for; `off`/`minimal` have none, so map to null. */
const KNOWN_LEVELS = new Set<string>(THINKING_LEVELS);

/** The newest `thinking_level_change` record's level, mapped to the app's vocabulary or null. */
function latestThinkingLevel(lines: string[]): ThinkingLevel | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.indexOf("thinking_level_change") < 0) continue; // cheap pre-filter
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line.trim()) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "thinking_level_change") continue;
    const level = typeof o.thinkingLevel === "string" ? o.thinkingLevel : null;
    return level && KNOWN_LEVELS.has(level) ? (level as ThinkingLevel) : null;
  }
  return null;
}

/** Context length = input + both cache tiers; output is excluded, matching the other harnesses. */
function contextTokensFromUsage(usage: Record<string, unknown>): number | null {
  const n = (k: string): number => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  const total = n("input") + n("cacheRead") + n("cacheWrite");
  return total > 0 ? total : null;
}

/**
 * The model id + context tokens off the newest assistant `message` record, falling back to a
 * bare `model_change` for the id. Null when neither is found.
 */
function latestModelAndTokens(
  lines: string[],
): { modelId: string | null; tokens: number | null } | null {
  let modelFromChange: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type === "message") {
      const m = o.message as Record<string, unknown> | undefined;
      if (!m || typeof m !== "object" || m.role !== "assistant") continue;
      // Skip an errored/aborted turn: pi writes it with an `errorMessage` and a zeroed
      // `usage`, which is not the session's real context and would blank the meter if read.
      if (typeof m.errorMessage === "string") continue;
      const modelId = typeof m.model === "string" ? m.model : null;
      const usage = m.usage as Record<string, unknown> | undefined;
      const tokens = usage ? contextTokensFromUsage(usage) : null;
      if (modelId || tokens !== null) return { modelId, tokens };
    } else if (o.type === "model_change" && modelFromChange === null) {
      // Remember the newest declared model as a fallback, but keep scanning for a message
      // record whose usage also carries the live token count.
      if (typeof o.modelId === "string") modelFromChange = o.modelId;
    }
  }
  return modelFromChange ? { modelId: modelFromChange, tokens: null } : null;
}

export function piContextWindowSize(modelId: string | null): number {
  const id = modelId?.toLowerCase().split("/").at(-1) ?? "";
  if (id === "gpt-5.5-pro" || id === "gpt-5.4-pro") return 1_050_000;
  if (id === "gpt-5.5" || id.startsWith("gpt-5.6-")) return 272_000;
  if (id.startsWith("gpt-5")) return 400_000;
  if (id.startsWith("gpt-4.1")) return 1_047_576;
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Derive runtime metadata from a window of pi transcript lines. Pure, for testing.
 * Returns null only when nothing useful was found.
 */
export function computePiRuntimeMeta(lines: string[]): RuntimeMetaRead | null {
  const found = latestModelAndTokens(lines);
  const thinkingLevel = latestThinkingLevel(lines);
  const modelId = found?.modelId ?? null;
  const contextTokens = found?.tokens ?? null;

  if (!modelId && contextTokens === null && !thinkingLevel) return null;

  const size = effectiveContextWindow(piContextWindowSize(modelId), contextTokens);
  const contextPct =
    contextTokens !== null ? Math.round(Math.min(100, (contextTokens / size) * 100)) : null;
  return {
    modelId,
    contextTokens,
    contextWindow: contextTokens !== null ? size : null,
    contextPct,
    longContext: isLongContext(size),
    thinkingLevel,
    effortRevision: null,
  };
}

/**
 * The stop reasons that mean pi handed control back to the human, so the session is genuinely
 * parked. `"stop"` is a clean turn end; `"aborted"` is an interrupt and every other reason
 * (a pending tool call, a bare error) is ambiguous - all fall to `working`, the safe bias a
 * false idle would break by typing into a busy session.
 */
const TURN_DONE = new Set(["stop"]);

/**
 * Derive a session's idle/working state from a window of pi transcript lines: scan
 * newest-first for the last `message` record and read `idle` off it only when it is an
 * assistant turn that stopped cleanly. Null when nothing datable is found. Pure, for testing.
 *
 * The hook-free source of state. pi pushes no hooks, so this is the primary signal, not a
 * fallback: it is re-derived every poll tick off the transcript on disk, which is why a
 * quiet or post-restart pi session can still be seen as idle and safely receive a
 * transcript-gated skills reload.
 */
export function computePiSessionActivity(lines: string[]): SessionActivityRead | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t || t.indexOf('"message"') < 0) continue; // message records carry this type token
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "message") continue;
    const m = o.message as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    const done = m.role === "assistant" && TURN_DONE.has(String(m.stopReason));
    return { state: done ? "idle" : "working", lastActivity: ts };
  }
  return null;
}

/**
 * One bounded tail read feeding both axes: runtime metadata, and the hook-free idle/working
 * signal. Both derive from the same lines so the poller reads the file once per tick.
 */
export function piPassiveRead(path: string): TranscriptPassiveRead {
  const lines = readTailLines(path, PASSIVE_TAIL_BYTES);
  return { meta: computePiRuntimeMeta(lines), activity: computePiSessionActivity(lines) };
}
