import type { HookIngest } from "@shared/protocol.ts";
import type { HookSpec } from "../types.ts";

export const piHooks: HookSpec = {
  scope: "machine",
  events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "PreCompact", "PostCompact", "Stop", "SessionEnd"],
  matcherEvents: [],
  toState(evt) {
    switch (evt.event) {
      case "SessionStart": return { state: "idle", activity: `Started${evt.reason ? ` (${evt.reason})` : ""}` };
      case "SessionEnd": return { state: "exited", activity: `Ended${evt.reason ? ` (${evt.reason})` : ""}` };
      case "Stop": return { state: "idle", activity: null };
      case "UserPromptSubmit": return { state: "working", activity: evt.prompt ?? null };
      case "PermissionRequest": return { state: "awaiting_input", activity: evt.message ?? "Waiting for input" };
      case "PreCompact": return { state: "working", activity: "Compacting context" };
      case "PostCompact": return { state: "working", activity: "Context compacted" };
      case "PreToolUse": case "PostToolUse": return { state: "working", activity: evt.toolName ? `Using ${evt.toolName}` : null };
      default: return { state: "working", activity: null };
    }
  },
  workCycleSignal(evt) {
    switch (evt.event) {
      case "UserPromptSubmit": case "PreToolUse": case "PostToolUse": case "PreCompact": case "PostCompact": return "work_started";
      case "Stop": return "turn_completed";
      default: return null;
    }
  },
  promptText,
  submittedPromptText: (evt) => evt.event === "UserPromptSubmit" ? evt.prompt ?? null : null,
};
function promptText(evt: HookIngest): string | null {
  return evt.event === "UserPromptSubmit" ? evt.prompt?.trim() || null : null;
}
