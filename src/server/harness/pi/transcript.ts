import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, ToolCall, TranscriptMessage } from "@shared/types.ts";
import type { TranscriptSpec } from "../types.ts";
import { jsonlMessages } from "../../transcript.ts";
import { TOOL_INPUT_CAP } from "../claude/transcript.ts";
import { piPassiveRead } from "./meta.ts";

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
export function piProjectDir(cwd: string): string {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(SESSIONS_DIR, safe);
}

/**
 * The newest `.jsonl` in a project dir, by mtime - the session currently being written, which
 * is the live one a card in that cwd is about. Null when the dir is absent or empty.
 *
 * mtime rather than the sortable filename timestamp because a RESUMED session is an older file
 * written recently, and "which one is live" is what a card needs. Two pi sessions sharing a
 * cwd is the ambiguous case every cwd-keyed locate has (Codex's included); newest-written is
 * the best available answer and degrades to a stale binding, never to a wrong process.
 */
function newestSessionFile(dir: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path ?? null;
}

/**
 * How long to wait before re-scanning the filesystem for a session's transcript. Finding the
 * file is a directory read, so - like Codex's rollout binding, and unlike Claude's two
 * `existsSync` calls - it is not something to redo every tick.
 */
const RESCAN_MS = 30_000;

/** A cached lookup for one session (path null = looked, none yet). */
interface Binding {
  cwd: string;
  path: string | null;
  triedAt: number;
}

/**
 * The cache lives HERE, on the spec, not in the generic poller - the rule the harness axis
 * settled: a harness whose lookup is a filesystem walk caches it itself, so the poller never
 * grows a per-vendor map.
 */
const bindings = new Map<string, Binding>();

/**
 * The transcript file for a session, cached. The hook-reported `transcriptPath` wins when
 * present (pi has no hooks today, so it will not be, but a future instrumentation would set
 * it); otherwise derive the project dir from cwd and take its newest session file. A found
 * path is reused until the cwd changes; a miss is retried only every `RESCAN_MS`.
 */
function locate(s: Session): string | null {
  if (s.transcriptPath && existsSync(s.transcriptPath)) return s.transcriptPath;
  if (!s.cwd) return null;
  const now = Date.now();
  const hit = bindings.get(s.id);
  if (hit && hit.cwd === s.cwd && (hit.path !== null || now - hit.triedAt < RESCAN_MS)) {
    return hit.path && existsSync(hit.path) ? hit.path : newestSessionFile(piProjectDir(s.cwd));
  }
  const path = newestSessionFile(piProjectDir(s.cwd));
  bindings.set(s.id, { cwd: s.cwd, path, triedAt: now });
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
  locate,
  passiveRead: piPassiveRead,
  // pi has no TodoWrite-style progress tool, so there is no "what's happening now" one-liner
  // to surface - null degrades to showing nothing, which is the right answer for a harness
  // with no such notion.
  messages: jsonlMessages({ parse: piToMessage, narration: () => null }),
  retain: (live) => {
    for (const id of bindings.keys()) if (!live.has(id)) bindings.delete(id);
  },
};
