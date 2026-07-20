import { openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, ThinkingLevel } from "@shared/types.ts";
import { isLongContext } from "@shared/model.ts";
import { readTailLines } from "./util/file-tail.ts";
import type { RuntimeMetaRead } from "./transcript.ts";

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
const HEAD_BYTES = 16 * 1024;
/** Cap on rollout files inspected per resolution, so a large history stays cheap. */
const SCAN_CAP = 400;

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
function readHeadLine(path: string): string | null {
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
export function parseSessionMeta(headLine: string | null): { cwd: string | null; start: number } | null {
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
  return { cwd, start: Number.isNaN(start) ? 0 : start };
}

/**
 * Locate the rollout file for a Codex session by matching cwd, choosing the one
 * whose start time is closest to the session's (two Codex sessions in the same
 * cwd can't be told apart more precisely than this). Scans newest-first and is
 * bounded by SCAN_CAP; the poller caches the result so this rarely re-runs.
 * `sessionsDir` is injectable for tests.
 */
export function findRolloutForSession(
  session: Session,
  sessionsDir: string = codexSessionsDir(),
): string | null {
  if (session.agent !== "codex" || !session.cwd) return null;
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
          if (scanned++ >= SCAN_CAP) return best?.path ?? null;
          const path = join(dDir, f);
          const meta = parseSessionMeta(readHeadLine(path));
          if (!meta || meta.cwd !== target) continue;
          if (startedAt == null) return path; // no start to disambiguate -> newest match
          if (!best || Math.abs(meta.start - startedAt) < Math.abs(best.start - startedAt)) {
            best = { path, start: meta.start };
          }
        }
      }
    }
  }
  return best?.path ?? null;
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
 * effort) and the newest `token_count` event (cumulative usage + window size).
 * Returns null when neither is present. Pure, for testing.
 */
export function parseRolloutMeta(lines: string[]): RuntimeMetaRead | null {
  let modelId: string | null = null;
  let thinkingLevel: ThinkingLevel | null = null;
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
      haveTurn = true;
    } else if (!haveTokens && o.type === "event_msg" && payload.type === "token_count") {
      const info = (payload.info ?? {}) as Record<string, unknown>;
      const usage = (info.total_token_usage ?? {}) as Record<string, unknown>;
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
  };
}

/** Read a rollout file's tail and derive its runtime metadata, or null. */
export function readRolloutMeta(path: string): RuntimeMetaRead | null {
  return parseRolloutMeta(readTailLines(path, ROLLOUT_TAIL_BYTES));
}
