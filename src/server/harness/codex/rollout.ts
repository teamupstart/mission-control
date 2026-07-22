import { openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, ThinkingLevel } from "@shared/types.ts";
import { isLongContext } from "@shared/model.ts";
import { readTailLines } from "../../util/file-tail.ts";
import type { RuntimeMetaRead } from "../types.ts";

// Reads an OpenAI Codex CLI "rollout" session file to surface the same runtime
// facts we read for Claude: model, reasoning effort, and context usage. Codex has
// no statusLine mechanism, so this is the only source. Rollouts live at
// <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl, one JSON record per
// line: a `session_meta` header (cwd + start time), `turn_context` records
// (model + effort), and `event_msg` records including cumulative `token_count`.

/** Codex home, honoring CODEX_HOME; the sessions dir is injectable for tests. */
function codexSessionsDir(): string {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(home, "sessions");
}

/** Bytes to scan from a rollout's tail for the latest turn/token records. */
const ROLLOUT_TAIL_BYTES = 128 * 1024;
/** Bytes to read from a rollout's head to identify its session_meta. */
// Session metadata can embed the complete base instructions. Real 0.144.6 headers exceed
// 18 KB, so the old 16 KB cap cut valid JSON in half and made every such rollout invisible.
const HEAD_BYTES = 256 * 1024;
/** Cap on rollout files inspected per resolution, so a large history stays cheap. */
const SCAN_CAP = 400;
/** A cwd fallback only proves identity near process startup; `/clear` can mint later files. */
const FALLBACK_START_SLOP_MS = 30 * 1000;

/**
 * Model and effort are normally written once near the rollout's head. Keep that
 * identity after the file grows beyond the tail window used for live polling.
 */
const rolloutTurnMeta = new Map<string, Pick<RuntimeMetaRead, "modelId" | "thinkingLevel" | "effortRevision">>();

/**
 * Forget the retained model/effort for every rollout not in `keep`.
 *
 * Keyed by PATH, and a `/clear` mints a new rollout file, so without this the map gains
 * an entry for every conversation the daemon has ever polled and gives none back.
 * `codexTranscript.retain` is the caller - it is already the tick that knows which
 * rollouts are still bound to a live session.
 */
export function retainRolloutMeta(keep: Set<string>): void {
  for (const path of rolloutTurnMeta.keys()) if (!keep.has(path)) rolloutTurnMeta.delete(path);
}

/** Numeric-name dir entries (YYYY / MM / DD), newest-first. */
function numericDirsDesc(dir: string, re: RegExp): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => re.test(n)).sort((a, b) => b.localeCompare(a));
}

/** Read the first line of a file (bounded), for a rollout's session_meta header. */
export function readHeadLine(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    const len = Math.min(size, HEAD_BYTES);
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** cwd + start time a rollout's session_meta header declares, or null. */
export interface CodexSessionMeta {
  cwd: string | null;
  start: number;
  sessionId: string | null;
  /** Internal guardian/worker rollouts share the parent's cwd but are not terminal sessions. */
  subagent: boolean;
}

export function parseSessionMeta(headLine: string | null): CodexSessionMeta | null {
  if (!headLine) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(headLine) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (o.type !== "session_meta") return null;
  const payload = (o.payload ?? {}) as Record<string, unknown>;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
  const tsRaw = (typeof payload.timestamp === "string" && payload.timestamp) ||
    (typeof o.timestamp === "string" && o.timestamp) || "";
  const start = Date.parse(tsRaw);
  const sessionId = typeof payload.session_id === "string" ? payload.session_id :
    typeof payload.id === "string" ? payload.id : null;
  const source = payload.source;
  const subagent = payload.thread_source === "subagent" ||
    (!!source && typeof source === "object" && "subagent" in source);
  return { cwd, start: Number.isNaN(start) ? 0 : start, sessionId, subagent };
}

export function rolloutBelongsToSession(path: string, session: Session): boolean {
  const meta = parseSessionMeta(readHeadLine(path));
  if (!meta || meta.subagent) return false;
  if (session.cwd && meta.cwd !== session.cwd) return false;
  if (session.agentSessionId) return meta.sessionId === session.agentSessionId;
  // A retained rollout path cannot establish the identity it is supposed to prove.
  // Without an agent session id, accept it only when this live session has a cwd that
  // matches the rollout's own recorded cwd; two absent identities prove nothing.
  return session.cwd !== null && meta.cwd === session.cwd;
}

/**
 * Locate the rollout file for a Codex session by matching cwd, choosing the one
 * whose start time is closest to the session's (two Codex sessions in the same
 * cwd can't be told apart more precisely than this). Scans newest-first and is
 * bounded by SCAN_CAP; `transcript.ts` beside this caches the result, so a walk
 * this size runs once per session rather than once per tick.
 * `sessionsDir` is injectable for tests.
 *
 * Takes no view on the session's agent: it is reachable only through
 * `HARNESSES.codex`, and an implementation re-deciding which harness it belongs to is
 * the hardcode the capability replaced.
 */
export function findRolloutForSession(
  session: Session,
  sessionsDir: string = codexSessionsDir(),
): string | null {
  if (!session.cwd) return null;
  const target = session.cwd;
  const startedAt = session.startedAt;

  let best: { path: string; start: number } | null = null;
  let scanned = 0;

  for (const year of numericDirsDesc(sessionsDir, /^\d{4}$/)) {
    const yDir = join(sessionsDir, year);
    for (const month of numericDirsDesc(yDir, /^\d{2}$/)) {
      const mDir = join(yDir, month);
      for (const day of numericDirsDesc(mDir, /^\d{2}$/)) {
        const dDir = join(mDir, day);
        let files: string[];
        try {
          files = readdirSync(dDir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
        } catch {
          continue;
        }
        files.sort((a, b) => b.localeCompare(a)); // newest-first (ISO ts in name)
        for (const f of files) {
          if (scanned++ >= SCAN_CAP) {
            return best && (startedAt == null || Math.abs(best.start - startedAt) <= FALLBACK_START_SLOP_MS)
              ? best.path : null;
          }
          const path = join(dDir, f);
          const meta = parseSessionMeta(readHeadLine(path));
          if (!meta || meta.subagent || meta.cwd !== target) continue;
          if (session.agentSessionId) {
            if (meta.sessionId === session.agentSessionId) return path;
            continue;
          }
          if (startedAt == null) return path; // no start to disambiguate -> newest match
          if (!best || Math.abs(meta.start - startedAt) < Math.abs(best.start - startedAt)) {
            best = { path, start: meta.start };
          }
        }
      }
    }
  }
  if (!best) return null;
  if (startedAt != null && Math.abs(best.start - startedAt) > FALLBACK_START_SLOP_MS) return null;
  return best.path;
}

/** Map a Codex reasoning-effort string onto our shared ThinkingLevel, or null. */
function normalizeEffort(effort: unknown): ThinkingLevel | null {
  if (typeof effort !== "string") return null;
  switch (effort.toLowerCase()) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return effort.toLowerCase() as ThinkingLevel;
    case "minimal":
      return "low";
    case "ultra":
      return "max";
    default:
      return null;
  }
}

/**
 * Derive runtime metadata from rollout lines: the newest `turn_context` (model +
 * effort) and the newest `token_count` event (current-turn usage + window size).
 * Returns null when neither is present. Pure, for testing.
 */
export function parseRolloutMeta(lines: string[]): RuntimeMetaRead | null {
  let modelId: string | null = null;
  let thinkingLevel: ThinkingLevel | null = null;
  let effortRevision: string | null = null;
  let contextTokens: number | null = null;
  let contextWindow: number | null = null;
  let haveTurn = false;
  let haveTokens = false;

  for (let i = lines.length - 1; i >= 0 && (!haveTurn || !haveTokens); i--) {
    const line = lines[i]!.trim();
    if (!line || line[0] !== "{") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = (o.payload ?? {}) as Record<string, unknown>;
    if (!haveTurn && o.type === "turn_context") {
      if (typeof payload.model === "string") modelId = payload.model;
      thinkingLevel = normalizeEffort(payload.effort);
      effortRevision = typeof o.timestamp === "string" ? o.timestamp : null;
      haveTurn = true;
    } else if (!haveTokens && o.type === "event_msg" && payload.type === "token_count") {
      const info = (payload.info ?? {}) as Record<string, unknown>;
      // `total_token_usage` is cumulative across the rollout and can exceed the context
      // window many times over. `last_token_usage` is the current request's context and
      // resets naturally when Codex clears/compacts the conversation.
      const usage = (info.last_token_usage ?? {}) as Record<string, unknown>;
      if (typeof usage.total_tokens === "number") contextTokens = usage.total_tokens;
      if (typeof info.model_context_window === "number") contextWindow = info.model_context_window;
      haveTokens = true;
    }
  }

  if (!modelId && contextTokens === null && !thinkingLevel) return null;

  const contextPct =
    contextTokens !== null && contextWindow && contextWindow > 0
      ? Math.round(Math.min(100, (contextTokens / contextWindow) * 100))
      : null;
  return {
    modelId,
    contextTokens: contextPct !== null ? contextTokens : null,
    contextWindow: contextPct !== null ? contextWindow : null,
    contextPct,
    longContext: isLongContext(contextWindow),
    thinkingLevel,
    effortRevision,
  };
}

/** Complete JSONL records from the bounded rollout head. */
function readHeadLines(path: string): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = statSync(path).size;
    const len = Math.min(size, HEAD_BYTES);
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, 0);
    const lines = buf.subarray(0, n).toString("utf8").split("\n");
    // A capped read may end halfway through a JSON record.
    if (len < size) lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

function readRetainedRolloutMeta(path: string, tailLines: string[]): RuntimeMetaRead | null {
  const tail = parseRolloutMeta(tailLines);
  let turn = rolloutTurnMeta.get(path);

  // A turn_context always carries a model. This lets a later model/effort change
  // supersede the head value, including an explicitly unsupported/null effort.
  if (tail?.modelId) {
    turn = {
      modelId: tail.modelId,
      thinkingLevel: tail.thinkingLevel,
      effortRevision: tail.effortRevision,
    };
  } else if (!turn) {
    const head = parseRolloutMeta(readHeadLines(path));
    turn = {
      modelId: head?.modelId ?? null,
      thinkingLevel: head?.thinkingLevel ?? null,
      effortRevision: head?.effortRevision ?? null,
    };
  }
  rolloutTurnMeta.set(path, turn);

  if (!tail && !turn.modelId && !turn.thinkingLevel) return null;
  return {
    modelId: tail?.modelId ?? turn.modelId,
    contextTokens: tail?.contextTokens ?? null,
    contextWindow: tail?.contextWindow ?? null,
    contextPct: tail?.contextPct ?? null,
    longContext: tail?.longContext ?? false,
    thinkingLevel: tail?.modelId ? tail.thinkingLevel : turn.thinkingLevel,
    effortRevision: tail?.modelId ? tail.effortRevision : turn.effortRevision,
  };
}

/** Read a rollout file's tail and derive its runtime metadata, or null. */
export function readRolloutMeta(path: string): RuntimeMetaRead | null {
  return readRetainedRolloutMeta(path, readTailLines(path, ROLLOUT_TAIL_BYTES));
}

function recordTime(o: Record<string, unknown>, payload: Record<string, unknown>): number {
  for (const value of [payload.completed_at, payload.started_at]) {
    if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  }
  const raw = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  return Number.isNaN(raw) ? 0 : raw;
}

/** Newest Codex lifecycle marker in a rollout tail. */
export function parseRolloutActivity(lines: string[]): import("../types.ts").SessionActivityRead | null {
  let latest: import("../types.ts").SessionActivityRead | null = null;
  for (const line of lines) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (o.type !== "event_msg") continue;
    const p = (o.payload ?? {}) as Record<string, unknown>;
    if (p.type !== "task_started" && p.type !== "task_complete" && p.type !== "turn_aborted") continue;
    latest = { state: p.type === "task_started" ? "working" : "idle", lastActivity: recordTime(o, p) };
  }
  return latest;
}

/** Metadata and lifecycle from the same bounded filesystem read. */
export function readRolloutPassive(path: string): import("../types.ts").TranscriptPassiveRead {
  const lines = readTailLines(path, ROLLOUT_TAIL_BYTES);
  return { meta: readRetainedRolloutMeta(path, lines), activity: parseRolloutActivity(lines), usage: parseRolloutUsage(lines), rateLimits: parseRolloutRateLimits(lines) };
}

export function parseRolloutRateLimits(lines: string[]): import("@shared/types.ts").RateLimitSource | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(lines[i]!) as Record<string, unknown>; } catch { continue; }
    const p = (o.payload ?? {}) as Record<string, unknown>;
    if (o.type !== "event_msg" || p.type !== "token_count") continue;
    const rl = p.rate_limits as Record<string, unknown> | undefined;
    if (!rl) continue;
    const windows: import("@shared/types.ts").RateLimitWindow[] = [];
    for (const id of ["primary", "secondary"] as const) {
      const w = rl[id] as Record<string, unknown> | null | undefined;
      if (!w || typeof w.used_percent !== "number" || typeof w.resets_at !== "number" || typeof w.window_minutes !== "number") continue;
      const mins = w.window_minutes;
      const label = mins % 10080 === 0 ? `${mins / 10080}-week` : mins % 1440 === 0 ? `${mins / 1440}-day` : mins % 60 === 0 ? `${mins / 60}-hour` : `${mins}-min`;
      windows.push({ id, label, durationMinutes: mins, usedPercentage: w.used_percent, resetsAt: w.resets_at });
    }
    if (!windows.length) return null;
    const updatedAt = typeof o.timestamp === "string" ? Date.parse(o.timestamp) || Date.now() : Date.now();
    return { source: "codex", windows, updatedAt };
  }
  return null;
}

export function parseRolloutUsage(lines: string[]): import("@shared/types.ts").SessionCost | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(lines[i]!) as Record<string, unknown>; } catch { continue; }
    const p = (o.payload ?? {}) as Record<string, unknown>;
    if (o.type !== "event_msg" || p.type !== "token_count") continue;
    const info = (p.info ?? {}) as Record<string, unknown>;
    const u = (info.total_token_usage ?? {}) as Record<string, unknown>;
    const num = (key: string): number => typeof u[key] === "number" ? Math.max(0, u[key] as number) : 0;
    const cached = num("cached_input_tokens");
    return {
      costUsd: null,
      basis: "unpriced",
      pricingModels: [],
      pricingVersions: [],
      input: Math.max(0, num("input_tokens") - cached),
      cacheRead: cached,
      cacheWrite: 0,
      output: num("output_tokens"),
      reasoningOutput: num("reasoning_output_tokens"),
      updatedAt: typeof o.timestamp === "string" ? Date.parse(o.timestamp) || Date.now() : Date.now(),
    };
  }
  return null;
}
