import type { HookIngest } from "@shared/protocol.ts";
import type { HookReading, HookSpec } from "../types.ts";

export const CODEX_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
  "Stop", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop",
] as const;

function toState(evt: HookIngest): HookReading {
  if (evt.event === "SessionStart" || evt.event === "Stop") {
    return { state: "idle", activity: evt.event === "Stop" ? null : "Session started" };
  }
  if (evt.event === "UserPromptSubmit") return { state: "working", activity: evt.prompt ?? null };
  if (evt.event === "PreToolUse" || evt.event === "PostToolUse") {
    return { state: "working", activity: evt.toolName ? `Using ${evt.toolName}` : "Using a tool" };
  }
  return { state: "working", activity: null };
}

export const codexHooks: HookSpec = {
  events: CODEX_HOOK_EVENTS,
  matcherEvents: [],
  toState,
  promptText: (evt) => evt.event === "UserPromptSubmit" && evt.prompt?.trim() ? evt.prompt.trim() : null,
};
