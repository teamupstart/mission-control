import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Session, ThinkingLevel, TranscriptMessage, TranscriptStreamMsg } from "@shared/types.ts";
import { effectiveContextWindow, isLongContext, parseContextWindowSize } from "@shared/model.ts";
import type { Registry } from "./registry.ts";
import { sleep } from "./util/timers.ts";

// Reads a Claude Code session transcript (JSONL) and streams it to the expanded
// card over SSE. Claude writes one JSON record per line to
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl; we resolve that path from
// the session's cwd + agent session id (no hook plumbing needed), tail-read it
// so a multi-MB file isn't parsed whole on every poll, and push new turns as the
// agent appends them.

const NL = 0x0a; // "\n"
/** Bytes to read from the tail for the initial history. */
const INIT_TAIL_BYTES = 512 * 1024;
/** Cap on how many turns we send on connect. */
const INIT_LIMIT = 80;
/** How often the server re-checks the file for new turns while a card is open. */
const POLL_MS = 900;
/** Idle comment ping so the SSE connection survives proxies. */
const HEARTBEAT_MS = 15000;

/** Root of Claude's per-project transcript store. */
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Resolve a session's transcript file.
 *
 * The authoritative source is `transcriptPath`, which Claude reports through its
 * hook - the exact file, no derivation, immune to how Claude encodes project
 * dirs and to compaction/resume/rename. As a fallback for a session whose hook
 * predates transcript reporting, we reconstruct Claude's documented layout:
 * the project dir is the cwd with every `/` and `.` replaced by `-`, and the
 * file is named by the session id. Returns null when neither locates a file
 * (no hook yet, or an agent that stores elsewhere - e.g. Codex).
 *
 * `projectsDir` is injectable for tests; production uses the default.
 */
export function resolveTranscriptPath(
  session: Session,
  projectsDir: string = PROJECTS_DIR,
): string | null {
  if (session.agent !== "claude") return null;
  if (session.transcriptPath && existsSync(session.transcriptPath)) return session.transcriptPath;
  if (!session.agentSessionId || !session.cwd) return null;
  const dir = session.cwd.replace(/[/.]/g, "-");
  const derived = join(projectsDir, dir, `${session.agentSessionId}.jsonl`);
  return existsSync(derived) ? derived : null;
}

/** Read bytes [start, end) of a file as a Buffer. */
function readRange(path: string, start: number, end: number): Buffer {
  const len = Math.max(0, end - start);
  if (len === 0) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Turn one parsed JSONL record into a renderable message, or null to drop it.
 * Keeps main-thread user prompts and assistant turns (text and/or tool calls);
 * drops sidechain (subagent) noise and the tool-result user records.
 */
export function toMessage(o: unknown): TranscriptMessage | null {
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  if (rec.isSidechain) return null;
  if (rec.type !== "user" && rec.type !== "assistant") return null;
  const m = rec.message as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") return null;
  const role = m.role;
  if (role !== "user" && role !== "assistant") return null;

  let text = "";
  const tools: string[] = [];
  let hasToolResult = false;
  const content = m.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (typeof b === "string") text += b;
      else if (b && typeof b === "object") {
        const block = b as Record<string, unknown>;
        if (block.type === "text") text += String(block.text ?? "");
        else if (block.type === "tool_use") tools.push(String(block.name ?? "tool"));
        else if (block.type === "tool_result") hasToolResult = true;
      }
    }
  }
  text = text.trim();
  // A user turn that's purely a tool result is machine noise, not conversation.
  if (role === "user" && !text && hasToolResult) return null;
  if (!text && tools.length === 0) return null;

  const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : 0;
  const id = typeof rec.uuid === "string" ? rec.uuid : `${role}-${ts}-${text.length}`;
  return { id, role, text, tools, ts: Number.isNaN(ts) ? 0 : ts };
}

/** Bytes to scan from the tail when extracting the current TodoWrite narration. */
const TODO_TAIL_BYTES = 256 * 1024;

/**
 * Pull the todos array from a JSONL record iff it's a main-thread `TodoWrite`
 * tool call. Returns null for anything else (sidechain records, other tools,
 * non-messages), so callers can tell "not a TodoWrite" from "an empty one".
 */
function todoWriteItems(o: unknown): Array<Record<string, unknown>> | null {
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  if (rec.isSidechain) return null;
  const m = rec.message as Record<string, unknown> | undefined;
  const content = m?.content;
  if (!Array.isArray(content)) return null;
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type !== "tool_use" || block.name !== "TodoWrite") continue;
    const input = block.input as Record<string, unknown> | undefined;
    if (Array.isArray(input?.todos)) return input.todos as Array<Record<string, unknown>>;
  }
  return null;
}

/**
 * The "what's happening now" narration for the no-mistakes strip: the present-
 * tense `activeForm` (falling back to `content`) of the in-progress item in the
 * most recent main-thread TodoWrite. The newest TodoWrite is authoritative, so
 * we stop at the first one found scanning newest-first - if it has nothing in
 * progress, the answer is null (not a stale earlier item). Pure, for testing.
 */
export function latestTodoNarration(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    // Cheap pre-filter: skip lines that can't be a TodoWrite before JSON.parse.
    if (!line || !line.includes("TodoWrite")) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const todos = todoWriteItems(o);
    if (!todos) continue;
    const active = todos.find(
      (t) => t && typeof t === "object" && t.status === "in_progress",
    );
    const form = active?.activeForm ?? active?.content;
    return typeof form === "string" && form.trim() ? form.trim() : null;
  }
  return null;
}

/**
 * Read the tail of a session's transcript and return the current TodoWrite
 * narration (see `latestTodoNarration`), or null when the file is missing/
 * unreadable or has no in-progress todo. Bounded tail read - never parses the
 * whole (potentially multi-MB) transcript.
 */
export function readCurrentTodo(path: string): string | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  const start = Math.max(0, size - TODO_TAIL_BYTES);
  const buf = readRange(path, start, size);
  // Drop a partial first line if we began mid-file, so JSON.parse doesn't choke.
  let from = 0;
  if (start > 0) {
    const nl = buf.indexOf(NL);
    from = nl >= 0 ? nl + 1 : buf.length;
  }
  const text = buf.subarray(from).toString("utf8");
  return latestTodoNarration(text ? text.split("\n") : []);
}

// ---- runtime metadata (model / context% / thinking level) -----------------

/** What a transcript read yields about a session's live runtime, all optional. */
export interface RuntimeMetaRead {
  modelId: string | null;
  /** Tokens occupying the context window (input + cache), excludes output. */
  contextTokens: number | null;
  contextWindow: number | null;
  /** 0-100, rounded; null when tokens/window couldn't be determined. */
  contextPct: number | null;
  longContext: boolean;
  thinkingLevel: ThinkingLevel | null;
}

/** Bytes to scan from the tail when extracting runtime metadata. */
const META_TAIL_BYTES = 256 * 1024;

/** Effort levels, longest-first so the alternation never mis-slices "xhigh". */
const EFFORT = "xhigh|medium|high|max|low";
/** `/effort <level>` echoes this exact line into the transcript. */
const EFFORT_SET_RE = new RegExp(`Set effort level to (${EFFORT})\\b`, "i");
/** `/model … with <level> effort` echoes this variant. Anchored to "Set model to"
 *  so it can't match unrelated prose like "…done with high effort". */
const EFFORT_WITH_RE = new RegExp(`Set model to [\\s\\S]*? with (${EFFORT}) effort\\b`, "i");

/**
 * The session's current reasoning effort, scraped newest-first from the local-
 * command echoes Claude writes when you run `/effort` or `/model … with … effort`.
 * Null when the session never set it explicitly (its default isn't recorded), or
 * when the echo has scrolled out of the tail we scan on a long session - the
 * statusLine source fills both gaps. A heuristic, like ccstatusline's own scrape.
 * Pure, for testing.
 */
export function latestEffortLevel(lines: string[]): ThinkingLevel | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes("effort")) continue; // cheap pre-filter before regex
    const m = EFFORT_SET_RE.exec(line) ?? EFFORT_WITH_RE.exec(line);
    if (m) return m[1]!.toLowerCase() as ThinkingLevel;
  }
  return null;
}

/** The `usage` + `model` off the newest main-chain assistant record, or null. */
function latestAssistantUsage(
  lines: string[],
): { modelId: string | null; tokens: number | null } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line || line.indexOf('"assistant"') < 0) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type !== "assistant" || o.isSidechain || o.isApiErrorMessage) continue;
    const m = o.message as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") continue;
    const modelId = typeof m.model === "string" ? m.model : null;
    const usage = m.usage as Record<string, unknown> | undefined;
    const tokens = usage ? contextTokensFromUsage(usage) : null;
    if (modelId || tokens !== null) return { modelId, tokens };
  }
  return null;
}

/** Context length = input + both cache tiers; output is excluded (matches ccstatusline). */
function contextTokensFromUsage(usage: Record<string, unknown>): number | null {
  const n = (k: string): number => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  const total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
  return total > 0 ? total : null;
}

/**
 * Derive runtime metadata from a window of transcript lines: the newest main-
 * chain assistant record's model + token usage, and the current effort level.
 * Returns null only when nothing useful was found. Pure, for testing.
 */
export function computeRuntimeMeta(lines: string[]): RuntimeMetaRead | null {
  const usage = latestAssistantUsage(lines);
  const thinkingLevel = latestEffortLevel(lines);
  const modelId = usage?.modelId ?? null;
  const contextTokens = usage?.tokens ?? null;

  if (!modelId && contextTokens === null && !thinkingLevel) return null;

  // The transcript's model id drops the `[1m]` marker, so infer the window from the
  // id but let the observed token count correct it upward (489k tokens can't fit a
  // 200k window - the session must be on 1M). Without this, 1M sessions read ~5x
  // too high and peg at 100% once usage passes 200k.
  const size = effectiveContextWindow(parseContextWindowSize(modelId).size, contextTokens);
  const contextPct =
    contextTokens !== null ? Math.round(Math.min(100, (contextTokens / size) * 100)) : null;
  return {
    modelId,
    contextTokens,
    contextWindow: contextTokens !== null ? size : null,
    contextPct,
    longContext: isLongContext(size),
    thinkingLevel,
  };
}

/**
 * Read the last `maxBytes` of a file as complete lines, dropping a partial first
 * line when we began mid-file. Shared bounded-tail read for the JSONL scanners
 * (runtime metadata here, and the Codex rollout reader) so none parse a whole
 * multi-MB file. Returns [] when the file is missing/unreadable.
 */
export function readTailLines(path: string, maxBytes: number): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const start = Math.max(0, size - maxBytes);
  const buf = readRange(path, start, size);
  let from = 0;
  if (start > 0) {
    const nl = buf.indexOf(NL);
    from = nl >= 0 ? nl + 1 : buf.length;
  }
  const text = buf.subarray(from).toString("utf8");
  return text ? text.split("\n") : [];
}

/**
 * Read the tail of a session's transcript and derive its runtime metadata, or
 * null when the file is missing/unreadable or yields nothing.
 */
export function readRuntimeMeta(path: string): RuntimeMetaRead | null {
  return computeRuntimeMeta(readTailLines(path, META_TAIL_BYTES));
}

/** Parse an array of JSONL lines into renderable messages. */
export function parseLines(lines: string[], limit?: number): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const msg = toMessage(o);
    if (msg) out.push(msg);
  }
  return limit && out.length > limit ? out.slice(-limit) : out;
}

// ---- one-shot transcript window (Foreman review + any non-streaming reader) ----

/** Head bytes to scan for the opening turns (the session's original goal). */
const WINDOW_HEAD_BYTES = 128 * 1024;
/** Tail bytes to scan for the recent context (the pending question). */
const WINDOW_TAIL_BYTES = 384 * 1024;

export interface TranscriptWindow {
  /** Opening turns then recent turns, de-duped; empty when unreadable. */
  messages: TranscriptMessage[];
  /** True when turns between the head and the tail were dropped for size. */
  truncated: boolean;
  /**
   * How many leading `messages` came from the opening slice - the boundary of the elided
   * middle. Non-zero only when `truncated`, where `messages[headCount - 1]` and
   * `messages[headCount]` sit next to each other in the array but far apart in the session.
   * A reader that wants the genuinely recent turns must therefore slice forward from here
   * rather than back from the end: the tail's turn count is byte-bounded, so when it yields
   * fewer turns than the head, slicing from the end runs back into the opening. 0 when the
   * file was returned whole and every turn is contiguous.
   */
  headCount: number;
}

/**
 * Read a bounded window of a transcript for a one-shot reader (no SSE): the
 * opening `headTurns` (so the goal the user set is always present) plus the most
 * recent `tailTurns` (the current question + context). A small file is returned
 * whole; a large one returns head+tail with the middle elided (`truncated`).
 * Pure over the filesystem, mirroring the bounded tail reads used elsewhere so a
 * multi-MB transcript is never parsed in full.
 */
export function readTranscriptWindow(
  path: string,
  headTurns = 12,
  tailTurns = 48,
): TranscriptWindow {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { messages: [], truncated: false, headCount: 0 };
  }
  // Small enough to read whole: no head/tail split, no truncation.
  if (size <= WINDOW_HEAD_BYTES + WINDOW_TAIL_BYTES) {
    const all = parseLines(readTailLines(path, size));
    return { messages: all, truncated: false, headCount: 0 };
  }
  // Head begins at byte 0 (first line is whole) but ends mid-file (drop the partial
  // last line). Tail begins mid-file (drop the partial first line) but ends at EOF
  // (keep the last line - parseLines drops it only if it isn't valid JSON).
  const headLines = completeLines(readRange(path, 0, WINDOW_HEAD_BYTES), false, true);
  const tailLines = completeLines(readRange(path, size - WINDOW_TAIL_BYTES, size), true, false);
  const head = parseLines(headLines).slice(0, headTurns);
  const tail = parseLines(tailLines).slice(-tailTurns);
  // De-dupe by record id in case the windows overlap on a mid-size file.
  const seen = new Set(head.map((m) => m.id));
  const merged = [...head, ...tail.filter((m) => !seen.has(m.id))];
  return { messages: merged, truncated: true, headCount: head.length };
}

/** Cap on a `since` window, so one long-running item can't return a whole file. */
const SINCE_MAX_BYTES = 512 * 1024;

/**
 * A transcript window read FORWARD from a byte offset - how the work queue scopes
 * a window to a single item.
 *
 * The transcript is append-only, so the file size recorded when an item was
 * delivered is an exact item boundary, and seeking to it is O(1). That beats every
 * alternative: the diff is cumulative whenever the agent doesn't commit, a turn
 * count can span three items, and filtering a head+tail window by timestamp would
 * silently drop the item's earliest turns (the ones establishing what the agent
 * set out to do) whenever its work exceeds the tail.
 *
 * `reset: true` means the file is now SHORTER than the offset - the transcript was
 * cleared (a `/clear`), so the anchor is meaningless. Callers must treat that as a
 * verify-infrastructure failure and escalate, NOT judge the item against a
 * near-empty window and invent gaps.
 */
export function readTranscriptSince(
  path: string,
  offset: number,
  maxBytes = SINCE_MAX_BYTES,
): TranscriptWindow & { reset?: boolean } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { messages: [], truncated: false };
  }
  if (size < offset) return { messages: [], truncated: false, reset: true };
  // Bound the window from the TAIL when an item wrote more than the cap: the
  // recent turns are what show whether the work landed.
  const truncated = size - offset > maxBytes;
  const start = truncated ? size - maxBytes : offset;
  const buf = readRange(path, start, size);
  // Drop the partial first line ONLY when we truncated into the middle of a line.
  // `offset` itself is a line boundary (it was EOF when the item was delivered),
  // so dropping there would discard a real turn - the item's opening one. If the
  // file happened to end mid-line at delivery, parseLines skips the unparseable
  // fragment anyway, so not dropping is safe in both cases.
  const lines = completeLines(buf, truncated, false);
  return { messages: parseLines(lines), truncated };
}

/**
 * Split a byte buffer into lines, optionally dropping a partial line at either
 * end: `dropFirst` for a buffer that began mid-file (a tail read), `dropLast`
 * for one that ended mid-file (a head read). The kept end is returned intact.
 */
function completeLines(buf: Buffer, dropFirst: boolean, dropLast: boolean): string[] {
  let from = 0;
  if (dropFirst) {
    const nl = buf.indexOf(NL);
    from = nl >= 0 ? nl + 1 : buf.length;
  }
  let end = buf.length;
  if (dropLast) {
    const lastNl = buf.lastIndexOf(NL);
    end = lastNl >= 0 ? lastNl + 1 : from;
  }
  const text = buf.subarray(from, end).toString("utf8");
  return text ? text.split("\n") : [];
}

/** Read the tail of the transcript for the initial view. Returns turns + the byte offset to resume from. */
function readTail(path: string): { messages: TranscriptMessage[]; pos: number } {
  const size = statSync(path).size;
  const start = Math.max(0, size - INIT_TAIL_BYTES);
  const buf = readRange(path, start, size);
  // If we began mid-file, drop the partial first line.
  let from = 0;
  if (start > 0) {
    const nl = buf.indexOf(NL);
    from = nl >= 0 ? nl + 1 : buf.length;
  }
  // Only parse up to the last newline; a trailing partial line stays for next read.
  const lastNl = buf.lastIndexOf(NL);
  const end = lastNl >= 0 ? lastNl + 1 : from;
  const text = buf.subarray(from, end).toString("utf8");
  const messages = parseLines(text ? text.split("\n") : [], INIT_LIMIT);
  return { messages, pos: start + end };
}

/** Read whatever complete lines were appended since `pos`. */
function readSince(path: string, pos: number): { messages: TranscriptMessage[]; pos: number } {
  const size = statSync(path).size;
  if (size <= pos) return { messages: [], pos };
  const buf = readRange(path, pos, size);
  const lastNl = buf.lastIndexOf(NL);
  if (lastNl < 0) return { messages: [], pos }; // no complete line yet
  const text = buf.subarray(0, lastNl + 1).toString("utf8");
  return { messages: parseLines(text.split("\n")), pos: pos + lastNl + 1 };
}

/**
 * SSE handler for `GET /api/sessions/:id/transcript/stream`. Sends the recent
 * history, then polls the file every ~1s and pushes appended turns until the
 * client (the collapsed card) disconnects. The poll is server-side and cheap (a
 * stat + a small tail read), so the browser gets a live push with no polling.
 */
export function transcriptStreamHandler(registry: Registry) {
  return (c: Context) =>
    streamSSE(c, async (stream) => {
      const send = (m: TranscriptStreamMsg) => stream.writeSSE({ data: JSON.stringify(m) });

      const id = c.req.param("id");
      const session = id ? registry.getSession(id) : undefined;
      const path = session ? resolveTranscriptPath(session) : null;
      if (!path) {
        await send({
          type: "unavailable",
          reason: session
            ? "No transcript for this session yet (needs a Claude session id from hooks)."
            : "No such session.",
        });
        return;
      }

      let pos = 0;
      try {
        const init = readTail(path);
        pos = init.pos;
        await send({ type: "init", messages: init.messages });
      } catch {
        await send({ type: "unavailable", reason: "Could not read the transcript file." });
        return;
      }

      let sinceHeartbeat = 0;
      while (!stream.aborted) {
        await sleep(POLL_MS);
        if (stream.aborted) break;
        try {
          const size = statSync(path).size;
          if (size < pos) pos = 0; // truncated / rotated - re-read from the top
          const { messages, pos: next } = readSince(path, pos);
          pos = next;
          if (messages.length > 0) {
            await send({ type: "append", messages });
            sinceHeartbeat = 0;
            continue;
          }
        } catch {
          // file briefly unavailable (rotation) - try again next tick
        }
        sinceHeartbeat += POLL_MS;
        if (sinceHeartbeat >= HEARTBEAT_MS) {
          await stream.writeSSE({ data: "", event: "ping" });
          sinceHeartbeat = 0;
        }
      }
    });
}
