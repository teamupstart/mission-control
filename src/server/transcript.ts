import { statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Session, ThinkingLevel, ToolCall, TranscriptMessage, TranscriptStreamMsg } from "@shared/types.ts";
import { effectiveContextWindow, isLongContext, parseContextWindowSize } from "@shared/model.ts";
import type { Registry } from "./registry.ts";
import { originOf } from "./injections.ts";
import { sleep } from "./util/timers.ts";
import { completeLines, readRange, readTailLines } from "./util/file-tail.ts";

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
 * file is named by the session id.
 *
 * Returns null when neither locates a file (no hook yet, a session with no id or
 * cwd to derive from, or an agent that stores elsewhere - e.g. Codex).
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
 * real 48-turn window this one costs ~3k extra tokens against a ~1.5k baseline, which is
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

// ---- the human's own words (Goal) -----------------------------------------

/**
 * Scaffolding that arrives on a user turn but that no human typed.
 *
 * `role === "user"` does NOT mean "a person wrote this". `toMessage` already drops the
 * turns that are purely a tool result, but Claude Code also delivers its own bookkeeping
 * through the same channel - and it is the MAJORITY of it. Measured against this daemon's
 * own `session_events` (396 real `UserPromptSubmit` events):
 *
 *   200 (51%)  <task-notification>   a background task reporting in
 *   188 (47%)  prose                 a human actually typed it
 *     6  (2%)  a slash command       "/no-mistakes"
 *
 * So without this filter 53% of goals would read `<task-notification> <task-id>byc4fw3pc…`.
 * A transcript read (the Tier 2 window) sees a different mix again - the `<command-*>` and
 * caveat wrappers below never reach the hook, and 265 of 265 `<command-name>` occurrences
 * were embedded in a larger turn rather than being one. That is why this strips blocks out
 * of a turn instead of classifying whole turns: both shapes occur, and only stripping
 * handles both.
 */
const DROP_TAGS = [
  "local-command-caveat",
  "local-command-stdout",
  "system-reminder",
  "task-notification",
  // The command's display name ("no-mistakes"), redundant beside <command-name> ("/no-mistakes").
  "command-message",
] as const;

/**
 * Scaffolding whose CONTENT is the human's ask, so it is unwrapped rather than dropped.
 *
 * A transcript records `/no-mistakes fix the arrow keys` as `<command-name>/no-mistakes
 * </command-name>` + `<command-args>fix the arrow keys</command-args>`, while the hook
 * reports the same thing as the flat string the human typed. Unwrapping both tags makes
 * the two sources agree, so Tier 1 (hook) and Tier 2 (transcript) can't disagree about
 * what was asked.
 *
 * Args are usually empty (17 of 387 sampled pairs carried any) but when they aren't they
 * are the whole goal - `/no-mistakes the changes for tab select, arrow movement, and hot
 * keys` is a far better sentence than `/no-mistakes`, so dropping them would throw away
 * the best signal these sessions have.
 */
const UNWRAP_TAGS = ["command-name", "command-args"] as const;

/**
 * Both match CLOSED blocks only. An unclosed tag is left alone deliberately: matching to
 * end-of-string would let a stray "<command-name>" a human typed in prose swallow their
 * entire prompt, and every one of the ~1,900 real turns sampled closed its tags. Showing
 * a slightly noisy goal beats deleting a real one.
 */
const DROP_RE = new RegExp(`<(${DROP_TAGS.join("|")})>[\\s\\S]*?<\\/\\1>`, "gi");
const UNWRAP_RE = new RegExp(`<(${UNWRAP_TAGS.join("|")})>([\\s\\S]*?)<\\/\\1>`, "gi");

/**
 * A machine tag OPENING the turn, closed or not - in which case the whole turn is machine
 * output and goes, however it ends.
 *
 * This is the truncation guard, and it is not hypothetical: `session_events` stores the
 * 120-char trimmed activity, so a `<task-notification>` logged there is cut off mid-block
 * and never closes. Any reader handed already-shortened text (that log, a future hook that
 * trims, a window clipped to a byte bound) would otherwise show the entire block as a goal
 * - the closed-block rule above silently does nothing on unclosed input.
 *
 * Anchoring to the START is what keeps this safe next to that rule. The prose it must not
 * eat mentions a tag in passing ("why does <command-name> show up in the goal?"); a turn
 * that BEGINS with one is Claude Code talking, not a person.
 */
const LEADING_MACHINE_TAG_RE = new RegExp(`^\\s*<(${DROP_TAGS.join("|")})>`, "i");

/**
 * A user turn as it should READ, with Claude Code's scaffolding removed - the conversation
 * log's counterpart to `substantivePrompt` below, over the same tags.
 *
 * Same tags, different contract, which is why this isn't just a call to that. It answers
 * "what is this session FOR?", so it flattens the text to one line and rejects turns that
 * state no work (`/clear`, effort echoes). This answers "what did the human SAY?", where a
 * `/clear` is exactly what they said and the line breaks in a pasted stack trace are the
 * shape of it - so both survive, and only what no human typed is removed.
 *
 * Without this the log renders Claude Code's plumbing as the human's own words: a turn
 * reading `<local-command-caveat>Caveat: The messages below were generated by the user
 * while running local commands…</local-command-caveat>`, attributed to "you". Stripped to
 * nothing, the turn is dropped by the empty check in `toMessage`.
 *
 * Pure, for testing.
 */
export function conversationText(raw: string): string {
  const stripped = raw.replace(DROP_RE, "");
  // A truncated block never closes, so DROP_RE can't have taken it; the whole turn is
  // machine output however it ends. Tested after the strip, since a caveat usually
  // PRECEDES real prose rather than replacing it (see `substantivePrompt`).
  if (LEADING_MACHINE_TAG_RE.test(stripped)) return "";
  return (
    stripped
      // Onto its own line rather than in place: `<command-name>/no-mistakes</command-name>
      // <command-args>fix the arrows</command-args>` with no whitespace between the tags
      // would otherwise unwrap to the single word "/no-mistakesfix the arrows". A newline
      // can't glue two tokens together, and can't disturb the indentation of a paste the
      // way collapsing runs of spaces would.
      .replace(UNWRAP_RE, (_m, _tag, inner: string) => `\n${inner.trim()}\n`)
      // The gaps those removals left - not the author's own blank lines, which stop at two.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Whole-turn text that is Claude's own echo of a local command, not an ask. `latestEffortLevel`
 * above scrapes these same echoes for the effort level - here they are noise.
 */
const ECHO_RE = /^(?:\[Request interrupted[^\]]*\]|Set (?:effort level|model) to\b.*)$/is;

/**
 * Built-in commands that act on the SESSION rather than state any work. A human typed them,
 * so they pass every other test here, but neither is ever an answer to "what is this session
 * trying to solve".
 *
 * Neither reaches the hook path today - measured: 0 of 403 real `UserPromptSubmit` events
 * were `/clear` or `/compact`, though 198 transcripts contain a `/clear`; Claude Code handles
 * built-ins locally and reports them as SessionEnd/SessionStart/PreCompact lifecycle events
 * instead (only custom commands like `/no-mistakes` fire the prompt hook). This exists for
 * the TRANSCRIPT path, where it matters a lot: a `/clear` mints a new session, and that new
 * session's transcript OPENS with the clear echo - 169 of 198 sampled files have it in their
 * first 5% - so a reader taking the first substantive turn of a freshly cleared session gets
 * "/clear" as its goal.
 *
 * Deliberately narrow: exactly the two commands ruled on, not every built-in. `/tui` and
 * `/exit` are equally un-goal-like but nobody has decided that, and a filter that quietly
 * grows past what was decided is how a real ask eventually gets eaten.
 *
 * The terminator is whitespace-or-end, NOT `\b`: command names contain hyphens, and `\b`
 * matches between "clear" and "-", so `\b` silently swallowed `/clear-cache the stale build`.
 * The command token has to end for this to be that command.
 */
const META_COMMAND_RE = /^\/(?:clear|compact)(?:\s|$)/i;

/**
 * The human's own words in a user turn, with Claude Code's scaffolding removed, or null
 * when the turn contains none of them.
 *
 * Deliberately NOT length-filtered. An earlier draft of the plan called for rejecting text
 * "implausibly long to be a typed prompt", to keep Foreman's own 6k-23k char headless
 * prompts from being read as asks. Two things killed that rule: headless runs no longer
 * reach the hook at all (see `headlessEnv` in claude-cli.ts, which is what actually fixed
 * that), and real typed prompts run long - p90 of the clean first prompts on this machine
 * is 5,515 chars. A length cutoff would now reject nothing but genuine asks, and the most
 * detailed ones at that. Bounding what gets STORED is `clampPrompt`'s job instead.
 *
 * Pure, for testing.
 */
export function substantivePrompt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Closed blocks go first, so what's left leading a turn can only be an UNCLOSED tag.
  // Order matters: a caveat block usually PRECEDES real prose rather than replacing it
  // (121 of 236 sampled occurrences), so testing the leading tag before stripping would
  // throw those prompts away.
  const stripped = raw.replace(DROP_RE, " ");
  if (LEADING_MACHINE_TAG_RE.test(stripped)) return null;
  const text = stripped
    .replace(UNWRAP_RE, (_m, _tag, inner: string) => ` ${inner} `)
    .replace(/\s+/g, " ")
    .trim();
  if (!text || ECHO_RE.test(text) || META_COMMAND_RE.test(text)) return null;
  return text;
}

/**
 * Cap on a stored prompt. Sized to hold a whole real ask: the clean first prompts measured
 * on this machine run to a 371-char median and a 5,515-char p90, so this keeps every
 * ordinary one intact and only bites on a pasted log or file dump.
 */
const PROMPT_CAP = 4000;
/** How much of an over-cap prompt is kept from the end. See `clampPrompt`. */
const PROMPT_TAIL = 1000;

/**
 * Bound a prompt for storage, keeping the head AND the tail when it's over the cap.
 *
 * Head-only truncation is the obvious choice and the wrong one: "here is the failing log:
 * <8KB> - work out why it breaks" puts the entire ask in the last line, and a head-only
 * clamp would store 4KB of log and no question. Keeping both ends means the clamp can only
 * ever elide the middle of a paste, which is the part least likely to carry the goal.
 *
 * Mirrors `readTranscriptWindow`'s head+tail split for the same reason, at a smaller scale.
 */
export function clampPrompt(text: string, cap = PROMPT_CAP): string {
  if (text.length <= cap) return text;
  const tail = Math.min(PROMPT_TAIL, Math.floor(cap / 2));
  return `${text.slice(0, cap - tail)} […] ${text.slice(-tail)}`;
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

/**
 * Bytes to scan from the tail for a passive transcript read - shared by the
 * runtime-metadata and idle/working scanners, which the poller derives from a
 * single tail read per tick. Sized so the newest record (a tool result can be
 * large) is captured whole rather than split off the front.
 */
export const PASSIVE_TAIL_BYTES = 256 * 1024;

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
 * Read the tail of a session's transcript and derive its runtime metadata, or
 * null when the file is missing/unreadable or yields nothing.
 */
export function readRuntimeMeta(path: string): RuntimeMetaRead | null {
  return computeRuntimeMeta(readTailLines(path, PASSIVE_TAIL_BYTES));
}

// ---- hook-free session activity (idle / working, from the transcript) ------

/** What a transcript read yields about a session's liveness. */
export interface SessionActivityRead {
  /**
   * `idle` ONLY when the newest main-chain record is an assistant turn that ended
   * cleanly; everything else - a pending tool call, a tool result the agent hasn't
   * answered yet, a bare user prompt - reads `working`. The bias is deliberate: a
   * false `working` merely makes the queue wait, a false `idle` types into a busy
   * session, so the ambiguous tails all fall to `working`.
   */
  state: "idle" | "working";
  /** Epoch ms of that newest datable main-chain record. */
  lastActivity: number;
}

/** Stop reasons that mean the assistant handed control back to the human, so the
 *  session is genuinely parked rather than mid-turn. */
const TURN_DONE = new Set(["end_turn", "stop_sequence"]);

/**
 * Derive a session's idle/working state from a window of transcript lines: scan
 * newest-first for the last main-chain (non-sidechain) user/assistant record that
 * carries a timestamp, and read `idle` off it only when it is an assistant turn
 * that stopped cleanly. Null when nothing datable is found. Pure, for testing.
 *
 * This is the hook-free source of session state. Hooks remain primary (exact,
 * instant, carry permission mode); this exists so a session whose hooks lapsed -
 * a 30-min silence, or every session for the moment after a daemon restart wipes
 * the in-memory overlays - can still be seen as idle and have its queue delivered,
 * because the transcript is on disk and re-derived every poll tick.
 */
export function computeSessionActivity(lines: string[]): SessionActivityRead | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t || t.indexOf('"role"') < 0) continue; // main-chain records carry a role
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    if (o.type !== "user" && o.type !== "assistant") continue;
    const m = o.message as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    const done = m.role === "assistant" && TURN_DONE.has(String(m.stop_reason));
    return { state: done ? "idle" : "working", lastActivity: ts };
  }
  return null;
}

/**
 * Read the tail of a session's transcript and derive its idle/working state, or
 * null when the file is missing/unreadable or yields nothing datable.
 */
export function readSessionActivity(path: string): SessionActivityRead | null {
  return computeSessionActivity(readTailLines(path, PASSIVE_TAIL_BYTES));
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
 * The transcript's current byte size - the anchor a work item records at delivery
 * so its verify window can start exactly at its first turn. An O(1) stat; null
 * when the file is missing. See `readTranscriptSince` for why bytes and not a
 * timestamp or a turn count.
 */
export function transcriptSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

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
    return { messages: [], truncated: false, headCount: 0 };
  }
  if (size < offset) return { messages: [], truncated: false, reset: true, headCount: 0 };
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
  // headCount is 0 even when truncated: this window drops a PREFIX rather than a
  // middle, so the turns it returns are always contiguous and a reader slicing
  // forward from 0 can never run back into an elided boundary.
  return { messages: parseLines(lines), truncated, headCount: 0 };
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
/**
 * Credit the turns Foreman and the dashboard typed to them, so the log doesn't read as
 * the human having asked for work they never asked for.
 *
 * Deliberately not inside `toMessage`: that's a pure parse of a file, this is a fact only
 * the running daemon holds (see injections.ts). Only the SSE stream is annotated - the
 * one-shot window feeds Foreman's own reviewer, which is reading for what the AGENT did.
 */
function attribute(sessionId: string | undefined, messages: TranscriptMessage[]): TranscriptMessage[] {
  if (!sessionId) return messages;
  return messages.map((m) => {
    if (m.role !== "user" || !m.text) return m;
    const origin = originOf(sessionId, m.text);
    return origin ? { ...m, origin } : m;
  });
}

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
        await send({ type: "init", messages: attribute(id, init.messages) });
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
            await send({ type: "append", messages: attribute(id, messages) });
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
