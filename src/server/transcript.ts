import { openSync, readSync, closeSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Session, TranscriptMessage, TranscriptStreamMsg } from "@shared/types.ts";
import type { Registry } from "./registry.ts";

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

/**
 * Resolve a session's transcript file. Claude encodes the project dir by
 * replacing every `/` and `.` in the cwd with `-`; the file is named by the
 * agent session id. Returns null for sessions we can't locate (no reported
 * session id, or the file doesn't exist - e.g. Codex, which stores elsewhere).
 */
export function resolveTranscriptPath(session: Session): string | null {
  if (session.agent !== "claude" || !session.agentSessionId || !session.cwd) return null;
  const dir = session.cwd.replace(/[/.]/g, "-");
  const path = join(homedir(), ".claude", "projects", dir, `${session.agentSessionId}.jsonl`);
  return existsSync(path) ? path : null;
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
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, POLL_MS);
          if (typeof t === "object" && "unref" in t) t.unref();
        });
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
