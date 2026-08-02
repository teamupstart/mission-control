import type { ThinkingLevel } from "@shared/types.ts";
import { effectiveContextWindow, isLongContext, parseContextWindowSize } from "@shared/model.ts";
import type { RuntimeMetaRead, SessionActivityRead, TranscriptPassiveRead } from "../types.ts";
import { readTailLines } from "../../util/file-tail.ts";

// What a Claude transcript says about a session's live runtime, off one bounded tail read.
//
// Every shape read here is Anthropic's: the `usage` object's three token fields, the
// `stop_reason` vocabulary, the local-command echo `/effort` writes. Codex answers the
// same two questions from an entirely different file (`harness/codex/rollout.ts`), which
// is the whole reason these are behind a capability rather than inline in the poller.

/**
 * Bytes to scan from the tail for a passive read - shared by the runtime-metadata and
 * idle/working scanners, which come out of a single tail read per tick. Sized so the
 * newest record (a tool result can be large) is captured whole rather than split off
 * the front.
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
  return latestEffort(lines).level;
}

function latestEffort(lines: string[]): { level: ThinkingLevel | null; revision: string | null } {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes("effort")) continue; // cheap pre-filter before regex
    const m = EFFORT_SET_RE.exec(line) ?? EFFORT_WITH_RE.exec(line);
    if (!m) continue;
    let revision: string | null = null;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (typeof record.uuid === "string") revision = record.uuid;
      else if (typeof record.timestamp === "string") revision = record.timestamp;
    } catch {
      revision = null;
    }
    return { level: m[1]!.toLowerCase() as ThinkingLevel, revision };
  }
  return { level: null, revision: null };
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
  const effort = latestEffort(lines);
  const thinkingLevel = effort.level;
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
    effortRevision: effort.revision,
  };
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
 *
 * CLIENT-SIDE COMMANDS ARE NOT TURNS. A local slash command (`/reload-skills`,
 * `/clear`, `/context`) writes a main-chain `user` record that no assistant ever
 * answers and no `Stop` hook ever follows. Counted as a turn it reads as a live
 * human prompt, which pins a FINISHED session at `working` for as long as the
 * transcript stands - the precise failure this passive read exists to prevent, and
 * one that strands a bound task because `settledIdle` never comes true again.
 *
 * Two structural markers disqualify such a record, neither of them a content sniff:
 *
 *   - `isMeta`, which the client sets on records it injects itself: the
 *     `<local-command-caveat>` preamble, and a skill's payload attachment.
 *   - a `system` record with `subtype: "local_command"`, whose `parentUuid` names
 *     the `<command-name>` record it ran. Scanning newest-first is what makes this
 *     usable - the marker is always read BEFORE the record it disqualifies.
 *
 * Deliberately NOT keyed on the `<command-name>` tag itself: a prompt-expanding
 * custom prompt-expanding commands write that same tag and DO open a turn, so
 * skipping on the tag would report a working session as idle - strictly worse than
 * the bug being fixed, because it invites Foreman to ship mid-turn. The
 * `local_command` marker is the only thing that separates the two.
 */
export function computeSessionActivity(lines: string[]): SessionActivityRead | null {
  /** uuids of `<command-name>` records a `local_command` system record claims. */
  const localCommands = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    // Main-chain records carry a role. The local_command marker carries neither a role
    // nor anything else we read off it, but it still has to be PARSED - it is the only
    // evidence that the record below it was a client-side command.
    if (!t || (t.indexOf('"role"') < 0 && t.indexOf('"local_command"') < 0)) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.isSidechain) continue;
    if (o.type === "system" && o.subtype === "local_command") {
      if (typeof o.parentUuid === "string") localCommands.add(o.parentUuid);
      continue;
    }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (o.isMeta === true) continue;
    if (typeof o.uuid === "string" && localCommands.has(o.uuid)) continue;
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
 * One bounded tail read feeding both axes: runtime metadata, and the hook-free
 * idle/working signal that keeps a quiet or post-restart session's queue moving.
 *
 * Both derive from the same lines on purpose - reading the file twice per tick, once
 * per axis, would double the I/O of the poller's hot loop for no new information.
 */
export function claudePassiveRead(path: string): TranscriptPassiveRead {
  const lines = readTailLines(path, PASSIVE_TAIL_BYTES);
  return { meta: computeRuntimeMeta(lines), activity: computeSessionActivity(lines) };
}
