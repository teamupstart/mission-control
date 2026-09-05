import type { Session } from "@shared/types.ts";
import type { TranscriptSpec } from "../types.ts";
import type { ToolCall, TranscriptMessage } from "@shared/types.ts";
import { jsonlMessages } from "../../transcript.ts";
import { readTailLines } from "../../util/file-tail.ts";
import { TOOL_INPUT_CAP } from "../claude/transcript.ts";
import {
  findRolloutForSession,
  readRolloutPassive,
  retainRolloutMeta,
  rolloutBelongsToSession,
} from "./rollout.ts";

// Codex's transcript capability: runtime metadata, AND messages.
//
// This file used to say `messages: null` was its whole point - that a rollout carried the
// model, the reasoning effort and a token count and nothing renderable as conversation.
// That was a claim about the format, and it was wrong: a rollout's `event_msg` records
// carry the conversation's prose verbatim - as `user_message` / `agent_message`, or as
// `item_completed` (see `itemProse`) - and its tool calls arrive as separate
// records that accumulate into a turn of their own. Hence `parseBatch` rather than `parse` -
// a run of calls is several records and one turn, so the grouping needs the whole window
// rather than a line at a time - and hence
// `GOAL_UNSUPPORTED.codex` (`@shared/goal.ts`) is null, which `harness-transcript.test.ts`
// pins against this capability.
//
// The reason the null mattered is still live for any harness that DOES lack a reader:
// answering a window read with `[]` says "this session has said nothing", which no caller
// can tell from the truth, so a capability with nothing to read declines instead.

/**
 * How long to wait before re-scanning the filesystem for a session that hasn't matched
 * a rollout yet. A rollout is found by walking a dated directory tree, so unlike
 * Claude's two `existsSync` calls it is not something to redo every tick.
 */
const RESCAN_MS = 30_000;

/** A cached lookup for one session (path null = looked, none yet). */
interface RolloutBinding {
  cwd: string;
  agentSessionId: string | null;
  path: string | null;
  triedAt: number;
}

/**
 * The cache lives HERE, not in the poller.
 *
 * It was born in `runtime-meta.ts`, which meant the generic loop over every live session
 * carried a `Map<string, CodexBinding>` and a Codex-specific rescan constant. That is the
 * shape this migration exists to remove: a third harness that also has to search for its
 * file would have added a second map beside it, and the poller would have become the
 * place every vendor keeps its state.
 */
const bindings = new Map<string, RolloutBinding>();

/**
 * The rollout path for a session, cached. A found path is reused until the session's cwd
 * or agent session changes; a miss is retried only every `RESCAN_MS`, so a rollout-less session doesn't
 * trigger a filesystem walk every tick.
 */
function locate(s: Session): string | null {
  if (s.transcriptPath) {
    return rolloutBelongsToSession(s.transcriptPath, s) ? s.transcriptPath : null;
  }
  if (!s.cwd) return null;
  const now = Date.now();
  const hit = bindings.get(s.id);
  if (
    hit &&
    hit.cwd === s.cwd &&
    hit.agentSessionId === s.agentSessionId &&
    (hit.path !== null || now - hit.triedAt < RESCAN_MS)
  ) {
    return hit.path;
  }
  const path = findRolloutForSession(s);
  bindings.set(s.id, { cwd: s.cwd, agentSessionId: s.agentSessionId, path, triedAt: now });
  return path;
}

function cappedInput(value: unknown): string | undefined {
  let text: string | undefined;
  try { text = typeof value === "string" ? value : JSON.stringify(value); } catch { return undefined; }
  if (!text || text === "{}" || text === "null") return undefined;
  return text.length > TOOL_INPUT_CAP ? `${text.slice(0, TOOL_INPUT_CAP)}…` : text;
}

/**
 * The prose of an `event_msg/item_completed` item, or null when it carries none.
 *
 * Codex CLI 0.153.4 moved a conversation's prose out of `event_msg/user_message` and
 * `event_msg/agent_message` and into `event_msg/item_completed`, whose `item.type` is
 * `UserMessage` or `AgentMessage`. Its tool calls did NOT move - they are still
 * `response_item/custom_tool_call`, read further down unchanged - and that asymmetry is the
 * whole shape of the regression: a session rendered its folded run of commands and not one
 * word on either side of it, which reads like an agent that ran fourteen things in silence.
 *
 * Both spellings are read, and both stay read. This is NOT a rename to follow: 0.153.4
 * writes the older records for a subagent thread (`thread_source: guardian_review`), so
 * measured against `~/.codex/sessions` the two shapes sit side by side under one
 * `cli_version`, and a reader that accepted only the new names would be the same defect
 * facing the other way.
 *
 * The content element's `type` is `Text` on an agent item and `text` on a user one. The text
 * is therefore taken from the FIELD rather than gated on the element type - a reader that
 * trusted that casing would drop exactly half of every conversation. Parts concatenate and
 * trim, which is what Claude's reader already does with its own text blocks.
 *
 * An item with no prose returns null rather than an empty turn, and the caller drops it.
 * That covers `Reasoning`, `CommandExecution` and `FileChange`, which are the same work the
 * `response_item` records already describe, and it matters beyond tidiness: an empty
 * assistant turn would absorb the tool calls that follow it into a run whose id does not
 * start with `tool:`, which is the one thing `joinCodexBatches` cannot rejoin across a
 * window seam.
 */
function itemProse(
  item: Record<string, unknown>,
): { role: "user" | "assistant"; text: string; id: string | null } | null {
  const kind = item.type;
  if (kind !== "UserMessage" && kind !== "AgentMessage") return null;
  let text = "";
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (!part || typeof part !== "object") continue;
    const value = (part as Record<string, unknown>).text;
    if (typeof value === "string") text += value;
  }
  text = text.trim();
  if (!text) return null;
  return {
    role: kind === "UserMessage" ? "user" : "assistant",
    text,
    id: typeof item.id === "string" && item.id ? item.id : null,
  };
}

/**
 * Distinguishes one parse from the next in the ids synthesized below.
 *
 * A window read parses head and tail as two separate batches and then de-dupes the
 * merged result BY ID. Most rollout records carry no id of their own, so theirs is
 * synthesized - and a per-batch counter restarting at 0 made a tail record collide with
 * an unrelated head record that happened to share a timestamp, silently dropping a real
 * message from the transcript. Head and tail byte ranges cannot overlap (the split path
 * runs only when the file exceeds both windows), so nothing is lost by making synthesized
 * ids batch-unique: only records carrying their OWN id are de-dupable, which is the truth.
 */
let parseSeq = 0;

/** Parse Codex rollout records into clean user/assistant segments, grouping tool calls. */
export function parseCodexMessages(records: unknown[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let currentAssistant: TranscriptMessage | null = null;
  const batch = parseSeq++;
  let seq = 0;
  for (const value of records) {
    if (!value || typeof value !== "object") continue;
    const rec = value as Record<string, unknown>;
    const p = (rec.payload ?? {}) as Record<string, unknown>;
    const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) || 0 : 0;
    const id = String(p.id ?? p.call_id ?? `${rec.timestamp ?? "codex"}:b${batch}:${seq++}`);
    // Codex records an operator interrupt as lifecycle only. Unlike Claude, it writes no
    // companion user turn, so ignoring this record makes the conversation jump directly
    // from the cut-off response to the next prompt with no indication that anyone stopped
    // it. Project the marker Claude already writes verbatim so both harnesses tell the same
    // human story. Narrowing to the measured reason matters: another future abort reason
    // must not be attributed to the operator merely because it shares the record kind.
    if (
      rec.type === "event_msg" &&
      p.type === "turn_aborted" &&
      p.reason === "interrupted"
    ) {
      out.push({
        id: `interrupt:${String(p.turn_id ?? id)}`,
        role: "user",
        text: "[Request interrupted by user]",
        tools: [],
        ts,
      });
      currentAssistant = null;
      continue;
    }
    // The 0.153.4 spelling, beside the older one rather than instead of it - the two test
    // different record types and neither shadows the other. Both branches build the same
    // `TranscriptMessage`, so everything downstream - the tool-run grouping below,
    // `joinCodexBatches`, the browser's fold - cannot tell which shape a session was
    // recorded in, which is the point.
    if (rec.type === "event_msg" && p.type === "item_completed") {
      const prose = itemProse((p.item ?? {}) as Record<string, unknown>);
      if (!prose) continue;
      const msg: TranscriptMessage = {
        id: prose.id ?? id,
        role: prose.role,
        text: prose.text,
        tools: [],
        ts,
      };
      out.push(msg);
      currentAssistant = prose.role === "assistant" ? msg : null;
      continue;
    }
    if (rec.type === "event_msg" && (p.type === "user_message" || p.type === "agent_message")) {
      const text = typeof p.message === "string" ? p.message : typeof p.text === "string" ? p.text : "";
      const role = p.type === "user_message" ? "user" : "assistant";
      const msg: TranscriptMessage = { id, role, text, tools: [], ts };
      out.push(msg);
      currentAssistant = role === "assistant" ? msg : null;
      continue;
    }
    if (rec.type !== "custom_tool_call" && rec.type !== "function_call" &&
        !(rec.type === "response_item" && (p.type === "custom_tool_call" || p.type === "function_call"))) continue;
    const body = rec.type === "response_item" ? p : rec;
    const bp = ((body.payload ?? body) as Record<string, unknown>);
    const tool: ToolCall = { name: String(bp.name ?? "tool") };
    const input = cappedInput(bp.arguments ?? bp.input);
    if (input) tool.input = input;
    // A run of commands is its OWN assistant turn, never an extension of the prose turn above
    // it. This used to append to whichever `agent_message` came last, which made every Codex
    // turn carry both prose and tools - and `transcriptRows` (`src/web/lib/tools.ts`) folds
    // tool-ONLY turns, so the fold could not fire for this harness at all. A stretch of work
    // that reads as one record on Claude read as one block per command here.
    //
    // The rollout agrees with the split: `custom_tool_call` is its own record, with `reasoning`
    // records between calls, and the prose arrives as a separate `agent_message`. Consecutive
    // calls still accumulate into ONE turn, so nothing downstream sees more turns than before -
    // only turns of a single kind.
    if (!currentAssistant || currentAssistant.text) {
      currentAssistant = { id: `tool:${id}`, role: "assistant", text: "", tools: [], ts };
      out.push(currentAssistant);
    }
    currentAssistant.tools.push(tool);
  }
  return out;
}

/**
 * Repair a window that opens part-way through an assistant turn.
 *
 * Two different jobs, and only one of them is a merge. A window whose first message is a
 * synthesized tool-only run began mid-turn either way, so the answer is always "keep scanning
 * back" - but what to DO with the two halves depends on what sits above the seam:
 *
 *   - Another tool-only run: the seam fell inside ONE run of commands, and the halves are
 *     joined. The scroll-back contract requires a windowed walk to reconstruct the whole-file
 *     parse exactly (`test/transcript-scrollback.test.ts`), so this cannot be left to the
 *     browser-side fold even though that fold would draw the same thing.
 *   - A prose turn: a different turn, and joining them is precisely the bug above. The join is
 *     still ACCEPTED, so the window keeps widening far enough back to include the prose the run
 *     followed; the two are simply returned unchanged. `repairLeadingBatch` re-tests the newly
 *     prepended leading message on the next pass, so this terminates.
 */
export function joinCodexBatches(
  earlier: TranscriptMessage[],
  later: TranscriptMessage[],
): { earlier: TranscriptMessage[]; later: TranscriptMessage[] } | null {
  const left = earlier.at(-1);
  const right = later[0];
  if (
    !left ||
    left.role !== "assistant" ||
    !right ||
    right.role !== "assistant" ||
    right.text !== "" ||
    right.tools.length === 0 ||
    !right.id.startsWith("tool:")
  ) {
    return null;
  }
  if (left.text !== "") return { earlier, later };
  return {
    earlier: [
      ...earlier.slice(0, -1),
      { ...left, tools: [...left.tools, ...right.tools] },
    ],
    later: later.slice(1),
  };
}

export function latestCodexNarration(lines: string[]): string | null {
  let active = false;
  let narration: string | null = null;
  for (const value of lines) {
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(value) as Record<string, unknown>; } catch { continue; }
    const p = (rec.payload ?? {}) as Record<string, unknown>;
    if (rec.type !== "event_msg") continue;
    if (p.type === "task_started") { active = true; narration = null; }
    else if (p.type === "agent_message" && active) narration = typeof p.message === "string" ? p.message : narration;
    // The 0.153.4 spelling of the same thing. Both AgentMessage phases narrate - a
    // `commentary` preamble is the running turn's most recent word about itself just as much
    // as a `final_answer` is, and the older `agent_message` record it replaced carried both.
    else if (p.type === "item_completed" && active) {
      const prose = itemProse((p.item ?? {}) as Record<string, unknown>);
      if (prose?.role === "assistant") narration = prose.text;
    }
    else if (p.type === "task_complete" || p.type === "turn_aborted") { active = false; narration = null; }
  }
  return active ? narration : null;
}

export const codexTranscript: TranscriptSpec = {
  metaSource: "codex-rollout",
  locate,
  // Codex lifecycle markers report task start/completion directly; `readRolloutPassive`
  // reads them from the same bounded tail as runtime metadata.
  passiveRead: readRolloutPassive,
  messages: jsonlMessages({
    parseBatch: parseCodexMessages,
    joinBatches: joinCodexBatches,
    narration: (path) => latestCodexNarration(readTailLines(path, 128 * 1024)),
  }),
  retain: (live) => {
    for (const id of bindings.keys()) if (!live.has(id)) bindings.delete(id);
    // The path-keyed half of the same cache. Dropping only the session bindings would
    // leave `rolloutTurnMeta` growing one entry per rollout for the life of the daemon.
    const held = new Set<string>();
    for (const b of bindings.values()) if (b.path) held.add(b.path);
    retainRolloutMeta(held);
  },
};
