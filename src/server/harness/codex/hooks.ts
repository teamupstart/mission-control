import type { HookIngest } from "@shared/protocol.ts";
import type { HookReading, HookSpec, WorkCycleSignal } from "../types.ts";

export const CODEX_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
  "Stop", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop",
] as const;

function toState(evt: HookIngest): HookReading {
  if (evt.event === "SessionStart" || evt.event === "Stop") {
    return { state: "idle", activity: evt.event === "Stop" ? null : "Session started" };
  }
  if (evt.event === "UserPromptSubmit") return { state: "working", activity: evt.prompt ?? null };
  // The one event that exists to say "a human has to answer this" - Claude's `Notification`
  // by another name. Left on the `working` fallback it would read as busy, which is the
  // inverse of the fact, and on the exact event a Codex session is least able to restate:
  // it is blocked, so nothing else will fire until the prompt is answered.
  if (evt.event === "PermissionRequest") {
    return { state: "awaiting_input", activity: evt.toolName ? `Needs approval: ${evt.toolName}` : "Needs approval" };
  }
  if (evt.event === "PreToolUse" || evt.event === "PostToolUse") {
    return { state: "working", activity: evt.toolName ? `Using ${evt.toolName}` : "Using a tool" };
  }
  // The remaining four events we actually install. They are all "still going, here is
  // what it is doing" - but they have to SAY so, because the fallback below says nothing
  // and would leave the ticker showing whatever it last knew for the whole of a compact.
  if (evt.event === "PreCompact") return { state: "working", activity: "Compacting context" };
  if (evt.event === "PostCompact") return { state: "working", activity: "Context compacted" };
  if (evt.event === "SubagentStart") return { state: "working", activity: "Subagent started" };
  if (evt.event === "SubagentStop") return { state: "working", activity: "Subagent finished" };
  // An event we don't model - a newer Codex's, or one someone wired by hand. `working`
  // because a hook fired at all means the process is alive and running something; a null
  // activity leaves the ticker showing the last thing we knew.
  return { state: "working", activity: null };
}

/** Codex hook vocabulary to the generic work-cycle lifecycle. */
function workCycleSignal(evt: HookIngest): WorkCycleSignal | null {
  switch (evt.event) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "PreCompact":
    case "PostCompact":
    case "SubagentStart":
    case "SubagentStop":
      return "work_started";
    case "Stop":
      return "turn_completed";
    default:
      return null;
  }
}

/** Codex has no scaffolding grammar, so its two prompt readings are the same trim. */
const codexPromptText = (evt: HookIngest): string | null =>
  evt.event === "UserPromptSubmit" && evt.prompt?.trim() ? evt.prompt.trim() : null;

export const codexHooks: HookSpec = {
  scope: "launch",
  events: CODEX_HOOK_EVENTS,
  matcherEvents: [],
  toState,
  workCycleSignal,
  promptText: codexPromptText,
  submittedPromptText: codexPromptText,
};
