import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, ToolCall, TranscriptMessage } from "@shared/types.ts";
import type { TranscriptSpec } from "../types.ts";
import { jsonlMessages } from "../../transcript.ts";
import { readRange } from "../../util/file-tail.ts";
import { conversationText } from "./scaffolding.ts";
import { claudePassiveRead } from "./meta.ts";

// Claude Code's session transcript: where it lives, and what one of its records means.
//
// Claude writes one JSON record per line to
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. The byte windowing over that file
// is format-agnostic and lives in `transcript.ts`; this module supplies the two things
// only Claude can answer - which file, and what a line says - and assembles them into the
// `transcript` capability.

const NL = 0x0a; // "\n"

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
 * file is named by the session id.
 *
 * Returns null when neither locates a file (no hook yet, or a session with no id or cwd
 * to derive from). It no longer checks the agent: this function is only reachable
 * THROUGH `HARNESSES.claude`, so a non-Claude session cannot arrive here, and a guard
 * restating that would be the hardcode this migration removes.
 *
 * `projectsDir` is injectable for tests; production uses the default.
 */
export function resolveTranscriptPath(
  session: Session,
  projectsDir: string = PROJECTS_DIR,
): string | null {
  if (session.transcriptPath && existsSync(session.transcriptPath)) return session.transcriptPath;
  if (!session.agentSessionId || !session.cwd) return null;
  const dir = join(projectsDir, session.cwd.replace(/[/.]/g, "-"));
  const derived = join(dir, `${session.agentSessionId}.jsonl`);
  return existsSync(derived) ? derived : null;
}

/**
 * Per-tool-input cap, mirroring the reviewer's per-message `MSG_CAP` so one call can't
 * blow up a window any more than one long turn can.
 *
 * Sized from the real distribution across this machine's transcripts rather than picked
 * round: `Write` inputs run to a 3.8KB median (a whole file body - worth truncating and
 * no loss, the path leads), while `AskUserQuestion` runs to a 1.4KB median and IS the
 * pending decision. A tighter cap would clip the very asks this exists to surface; on a
 * real 48-turn window (the reviewer's default tail - the route adds a 12-turn head on top)
 * this one costs ~3k extra tokens against a ~1.5k baseline, which is
 * nothing next to the Opus call it lets Foreman answer instead of escalate.
 *
 * Truncation is lossy but safe by construction: it can only ever hide a *later* part of
 * an argument from the denylist, and an unscannable window routes UP (see `hasProse` and
 * backstop 3 in triage.ts), never through.
 */
export const TOOL_INPUT_CAP = 1800;

/**
 * Normalize one `tool_use` block into a `ToolCall`. Inputs that serialize to nothing
 * meaningful (absent, empty object) carry no `input` at all rather than a literal "{}",
 * so the reviewer's window and the card's chips stay clean.
 */
function toolCall(block: Record<string, unknown>): ToolCall {
  const name = String(block.name ?? "tool");
  let json: string | undefined;
  try {
    // A tool input is plain JSON off disk, but stringify still throws on a cycle and
    // returns undefined for an undefined input - a malformed record must not take the
    // whole window down with it.
    json = JSON.stringify(block.input);
  } catch {
    return { name };
  }
  if (!json || json === "{}" || json === "null") return { name };
  return { name, input: json.length > TOOL_INPUT_CAP ? `${json.slice(0, TOOL_INPUT_CAP)}…` : json };
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
  const tools: ToolCall[] = [];
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
        else if (block.type === "tool_use") tools.push(toolCall(block));
        else if (block.type === "tool_result") hasToolResult = true;
      }
    }
  }
  text = text.trim();
  // `role === "user"` does not mean a person wrote it: Claude Code delivers its own
  // local-command plumbing through the same channel, and rendered verbatim it shows up
  // in the log as the human reciting caveat XML at their agent. A turn that was nothing
  // BUT scaffolding strips to empty and falls out on the check below.
  if (role === "user") text = conversationText(text);
  // A user turn that's purely a tool result is machine noise, not conversation.
  if (role === "user" && !text && hasToolResult) return null;
  if (!text && tools.length === 0) return null;

  const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : 0;
  const id = typeof rec.uuid === "string" ? rec.uuid : `${role}-${ts}-${text.length}`;
  return { id, role, text, tools, ts: Number.isNaN(ts) ? 0 : ts };
}

// ---- the current TodoWrite narration -------------------------------------

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

/** Claude Code's transcript capability: a located JSONL file, read as messages and as meta. */
export const claudeTranscript: TranscriptSpec = {
  metaSource: "transcript",
  locate: (session) => resolveTranscriptPath(session),
  passiveRead: claudePassiveRead,
  messages: jsonlMessages({ parse: toMessage, narration: readCurrentTodo }),
  // Locating is two `existsSync` calls off fields the session already carries, so there
  // is nothing worth caching and nothing to prune.
  retain: null,
};
