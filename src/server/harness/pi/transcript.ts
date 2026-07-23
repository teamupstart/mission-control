import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, ToolCall, TranscriptMessage } from "@shared/types.ts";
import type { TranscriptSpec } from "../types.ts";
import { jsonlMessages } from "../../transcript.ts";
import { TOOL_INPUT_CAP } from "../claude/transcript.ts";
import { piPassiveRead } from "./meta.ts";
import { readRange } from "../../util/file-tail.ts";

// Pi's session transcript: where it lives, and what one of its records means.
//
// pi writes one JSON record per line to
// ~/.pi/agent/sessions/--<cwd>--/<ISO-ts>_<uuid>.jsonl - project-keyed like Claude, and read
// as turns the same way (a per-line `parse`, not Codex's batch). The byte windowing over the
// file is format-agnostic and lives in `transcript.ts`; this module supplies the two things
// only pi can answer - which file, and what a line says - and assembles them into the
// `transcript` capability. Because that capability is non-null with `messages`,
// `GOAL_UNSUPPORTED.pi` is null (paired, `harness-transcript.test.ts`).

/** Root of pi's per-project session store. */
const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

/**
 * pi's cwd -> project-dir encoding, taken verbatim from its `session-manager.js`:
 * strip a leading slash, replace `/ \ :` with `-`, wrap in `--`. Note dots are NOT replaced,
 * unlike Claude's `[/.]` - a `.treehouse` worktree keeps its dot.
 */
export function piProjectDir(cwd: string, sessionsDir = SESSIONS_DIR): string {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsDir, safe);
}

interface SessionFile {
  path: string;
  mtime: number;
}

function sessionFiles(dir: string): SessionFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: SessionFile[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      files.push({ path, mtime: statSync(path).mtimeMs });
    } catch {
      continue;
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path));
}

function fileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function sessionIdFromHeader(path: string): string | null {
  try {
    const size = statSync(path).size;
    const text = readRange(path, 0, Math.min(size, 64 * 1024)).toString("utf8");
    const end = text.indexOf("\n");
    const first = end >= 0 ? text.slice(0, end) : text;
    const record = JSON.parse(first) as Record<string, unknown>;
    return record.type === "session" && typeof record.id === "string" ? record.id : null;
  } catch {
    return null;
  }
}

/** A cached lookup for one session (path null = looked, none yet). */
interface Binding {
  cwd: string;
  agentSessionId: string | null;
  path: string | null;
  confirmedSoleOccupant: boolean;
}

/**
 * The state lives HERE, on the spec, not in the generic poller - the rule the harness axis
 * settled: per-session bindings and occupancy stay with the harness that understands them,
 * so the poller never grows a per-vendor map.
 */
const bindings = new Map<string, Binding>();
let soleOccupants = new Map<string, string | null>();

function recordBinding(s: Session, path: string | null): void {
  const current = bindings.get(s.id);
  if (current?.cwd === s.cwd) {
    current.agentSessionId = s.agentSessionId;
    current.path = path;
    return;
  }
  bindings.set(s.id, {
    cwd: s.cwd!,
    agentSessionId: s.agentSessionId,
    path,
    confirmedSoleOccupant: false,
  });
}

export function locatePiTranscript(s: Session, sessionsDir = SESSIONS_DIR): string | null {
  if (!s.cwd) {
    bindings.delete(s.id);
    return null;
  }

  const transcriptMtime = s.transcriptPath ? fileMtime(s.transcriptPath) : null;
  if (s.transcriptPath && transcriptMtime !== null) {
    const sourceId = sessionIdFromHeader(s.transcriptPath);
    const exact = !!s.agentSessionId && sourceId === s.agentSessionId;
    const contradicted = !!s.agentSessionId && !!sourceId && sourceId !== s.agentSessionId;
    const path =
      exact || (!contradicted && bindings.get(s.id)?.confirmedSoleOccupant)
        ? s.transcriptPath
        : null;
    recordBinding(s, path);
    return path;
  }

  const files = sessionFiles(piProjectDir(s.cwd, sessionsDir));
  const newest = files[0] ?? null;

  let path: string | null = null;
  if (newest) {
    if (s.agentSessionId) {
      for (const file of files) {
        if (sessionIdFromHeader(file.path) !== s.agentSessionId) continue;
        path = file.path;
        break;
      }
    }
    if (!path && bindings.get(s.id)?.confirmedSoleOccupant) {
      path = newest.path;
    }
  }

  recordBinding(s, path);
  return path;
}

/**
 * Normalize one pi `tool_call` content part into a `ToolCall`, mirroring Claude's `toolCall`:
 * an input that serializes to nothing meaningful carries no `input` at all.
 *
 * The `tool_call` part type and its `name`/`input` fields are taken from pi-ai's content-part
 * type definitions, and are best-effort: the verified fixture is a text-only session (pi was
 * not logged in to a provider to drive a tool call), so this path is defensive rather than
 * captured. Getting it wrong drops a tool chip, never a whole turn - the text is parsed
 * independently below.
 */
function piToolCall(block: Record<string, unknown>): ToolCall {
  const name = String(block.name ?? "tool");
  let json: string | undefined;
  try {
    json = JSON.stringify(block.input ?? block.arguments);
  } catch {
    return { name };
  }
  if (!json || json === "{}" || json === "null") return { name };
  return { name, input: json.length > TOOL_INPUT_CAP ? `${json.slice(0, TOOL_INPUT_CAP)}…` : json };
}

/**
 * Turn one parsed pi JSONL record into a renderable message, or null to drop it. Keeps
 * `message` records (user prompts and assistant turns with text and/or tool calls); drops the
 * `session` / `model_change` / `thinking_level_change` bookkeeping records, `thinking` parts
 * (not conversation) and `tool_result` parts (the machine's answer, not a turn).
 */
export function piToMessage(o: unknown): TranscriptMessage | null {
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  if (rec.type !== "message") return null;
  const m = rec.message as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") return null;
  const role = m.role;
  if (role !== "user" && role !== "assistant") return null;

  let text = "";
  const tools: ToolCall[] = [];
  const content = m.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (typeof b === "string") {
        text += b;
      } else if (b && typeof b === "object") {
        const block = b as Record<string, unknown>;
        if (block.type === "text") text += String(block.text ?? "");
        else if (block.type === "tool_call") tools.push(piToolCall(block));
      }
    }
  }
  text = text.trim();
  if (!text && tools.length === 0) return null;

  const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : 0;
  const id = typeof rec.id === "string" ? rec.id : `${role}-${ts}-${text.length}`;
  return { id, role, text, tools, ts: Number.isNaN(ts) ? 0 : ts };
}

/** Pi's transcript capability: a located JSONL file, read as messages and as runtime meta. */
export const piTranscript: TranscriptSpec = {
  metaSource: "transcript",
  locate: locatePiTranscript,
  passiveRead: piPassiveRead,
  // pi has no TodoWrite-style progress tool, so there is no "what's happening now" one-liner
  // to surface - null degrades to showing nothing, which is the right answer for a harness
  // with no such notion.
  messages: jsonlMessages({ parse: piToMessage, narration: () => null }),
  retain: (live) => {
    for (const id of bindings.keys()) if (!live.has(id)) bindings.delete(id);
    const next = new Map<string, string | null>();
    for (const [id, binding] of bindings) {
      next.set(binding.cwd, next.has(binding.cwd) ? null : id);
    }
    for (const [id, binding] of bindings) {
      binding.confirmedSoleOccupant =
        next.get(binding.cwd) === id && soleOccupants.get(binding.cwd) === id;
    }
    soleOccupants = next;
  },
};
