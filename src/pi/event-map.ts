import type { HookIngest, StatusLineIngest } from "@shared/protocol.ts";
import { THINKING_LEVELS } from "@shared/types.ts";
import { captureTerminalEnv } from "@shared/harness-runtime.mjs";
import { opensPullRequest, pullRequestUrlsIn } from "@shared/pr-command.mjs";
import type { PiContext, PiEvent } from "./api.ts";

export const PI_EVENTS = {
  session_start: "SessionStart", input: "UserPromptSubmit",
  tool_execution_start: "PreToolUse", tool_execution_end: "PostToolUse",
  ui_prompt_start: "PermissionRequest", ui_prompt_end: "PostToolUse",
  session_before_compact: "PreCompact", session_compact: "PostCompact",
  agent_settled: "Stop", session_shutdown: "SessionEnd",
} as const;

export function hookBody(event: PiEvent, ctx: PiContext, command?: string): HookIngest | null {
  const mapped = PI_EVENTS[event.type as keyof typeof PI_EVENTS];
  if (!mapped || (event.type === "input" && !["interactive", "rpc"].includes(event.source ?? ""))) return null;
  const body: HookIngest = {
    agent: "pi", event: mapped, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
    transcriptPath: ctx.sessionManager.getSessionFile() ?? null, env: captureTerminalEnv(), ts: Date.now(),
    toolName: event.toolName, prompt: event.text, source: event.source, reason: event.reason,
    message: event.kind ? [event.kind, event.title].filter(Boolean).join(": ") : undefined,
  };
  if (event.type === "tool_execution_end" && event.toolName === "bash") {
    const text = event.result?.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") ?? "";
    const urls = pullRequestUrlsIn(text);
    if (urls.length) { body.prUrls = urls; body.prUrl = urls[0]; }
    if (command && opensPullRequest(command)) body.prCreated = true;
  }
  return body;
}

export function statusBody(event: PiEvent, ctx: PiContext): StatusLineIngest {
  const model = event.model ?? ctx.model;
  const usage = ctx.getContextUsage();
  const level = event.level ?? ctx.thinkingLevel;
  const effort = THINKING_LEVELS.find((shared) => shared === level);
  return {
    sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, env: captureTerminalEnv(), ts: Date.now(),
    model: model ? { id: model.id, displayName: model.name } : undefined,
    contextWindow: usage ? { tokens: usage.tokens ?? undefined, contextWindowSize: usage.contextWindow, usedPercentage: usage.percent ?? undefined } : undefined,
    effort,
    nativeEffort: effort === undefined ? level || undefined : undefined,
    thinkingEnabled: level ? level !== "off" : undefined,
  };
}
