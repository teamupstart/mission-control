/** The structural subset of Pi 0.85.1 used by the bundled extension. No runtime import
 * from Pi: a symlink loads from the operator's extension directory. */
export interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  model?: { id: string; name?: string };
  thinkingLevel?: string;
  getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}
export interface PiEvent {
  type: string;
  source?: string;
  text?: string;
  reason?: string;
  toolName?: string;
  toolCallId?: string;
  args?: { command?: string };
  result?: { content?: { type: string; text?: string }[] };
  kind?: string;
  title?: string;
  model?: { id: string; name?: string };
  level?: string;
  systemPrompt?: string;
  systemPromptOptions?: { appendSystemPrompt?: string };
}
export interface PiTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: Record<string, unknown>;
  execute(id: string, args: unknown, signal?: AbortSignal): Promise<{
    content: { type: "text"; text: string }[]; details: Record<string, unknown>;
  }>;
}
export interface PiApi {
  on(event: string, handler: (event: PiEvent, context: PiContext) => Promise<unknown>): void;
  registerTool(tool: PiTool): void;
}
