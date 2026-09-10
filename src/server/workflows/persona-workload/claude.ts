import { claudeExecutable } from "../../harness/claude/sdk-deps.ts";
import type { ClaudeSdkMessage, ClaudeSdkUserMessage } from "../../harness/claude/sdk-types.ts";
import { claudeImageUserMessage } from "../../llm/claude-input.ts";
import { validateLlmImages } from "../../llm/images.ts";
import {
  assertProviderNeutralLaunch,
  personaProviderSubprocessEnv,
  type PersonaProviderLaunch,
  type PersonaProviderResult,
  type PersonaWorkloadProviderAdapter,
} from "./provider.ts";

interface ClaudeWorkloadOptions {
  cwd: string;
  pathToClaudeCodeExecutable: string;
  env: Record<string, string | undefined>;
  abortController: AbortController;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: Record<string, unknown>;
  strictMcpConfig: boolean;
  permissionMode: "dontAsk";
  settingSources: [];
  maxTurns: number;
  model: string;
  outputFormat: { type: "json_schema"; schema: Record<string, unknown> };
  persistSession: false;
  canUseTool: (toolName: string) => Promise<{ behavior: "allow" } | { behavior: "deny"; message: string; interrupt: true }>;
}

export interface ClaudeWorkloadDeps {
  query(params: {
    prompt: string | AsyncIterable<ClaudeSdkUserMessage>;
    options: ClaudeWorkloadOptions;
  }): Promise<AsyncIterable<ClaudeSdkMessage>>;
  executable(): Promise<string>;
  env(cwd: string): Record<string, string | undefined>;
}

const defaultClaudeWorkloadDeps: ClaudeWorkloadDeps = {
  async query(params) {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    return query(params as never) as unknown as AsyncIterable<ClaudeSdkMessage>;
  },
  executable: claudeExecutable,
  env: () => personaProviderSubprocessEnv(process.env),
};

function oneMessage(message: ClaudeSdkUserMessage): AsyncIterable<ClaudeSdkUserMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      yield message;
    },
  };
}

function frameToolNames(frame: ClaudeSdkMessage): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "tool_use" && typeof record.name === "string") found.push(record.name);
    for (const child of Object.values(record)) visit(child);
  };
  visit(frame);
  return found;
}

function resultText(frame: ClaudeSdkMessage): string {
  if (!("structured_output" in frame)) throw new Error("Claude workload returned no structured verdict");
  const encoded = JSON.stringify(frame.structured_output);
  if (!encoded) throw new Error("Claude workload returned an empty structured verdict");
  return encoded;
}

export class ClaudePersonaWorkloadAdapter implements PersonaWorkloadProviderAdapter {
  readonly id = "claude" as const;

  constructor(private readonly deps: ClaudeWorkloadDeps = defaultClaudeWorkloadDeps) {}

  async run(launch: PersonaProviderLaunch, signal: AbortSignal): Promise<PersonaProviderResult> {
    assertProviderNeutralLaunch(launch);
    if (launch.provider !== this.id) throw new Error("Claude workload adapter received another provider");
    const images = validateLlmImages(launch.images);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const allowed = new Set(launch.allowedTools);
    const options: ClaudeWorkloadOptions = {
      cwd: launch.workingDirectory,
      pathToClaudeCodeExecutable: await this.deps.executable(),
      env: { ...this.deps.env(launch.workingDirectory), MISSION_HEADLESS: "1", MISSION_PERSONA_WORKLOAD: "1" },
      abortController: controller,
      tools: [...launch.allowedTools],
      allowedTools: [...launch.allowedTools],
      disallowedTools: ["Bash", "Read", "Grep", "Glob", "Write", "Edit", "WebFetch", "WebSearch", "Task", "Skill", "NotebookEdit"],
      mcpServers: {
        [launch.repositoryMcp.serverName]: {
          type: "stdio",
          command: launch.repositoryMcp.command,
          args: [...launch.repositoryMcp.args],
          env: { ...launch.repositoryMcp.env },
        },
      },
      strictMcpConfig: true,
      permissionMode: "dontAsk",
      settingSources: [],
      maxTurns: launch.budgets.maxCalls + 3,
      model: launch.model,
      outputFormat: { type: "json_schema", schema: launch.outputSchema },
      persistSession: false,
      canUseTool: async (toolName) => allowed.has(toolName)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Persona workloads expose repository MCP tools only", interrupt: true },
    };
    const prompt = images.length === 0
      ? launch.prompt
      : oneMessage(claudeImageUserMessage(launch.prompt, images));
    const calls: string[] = [];
    try {
      const stream = await this.deps.query({ prompt, options });
      for await (const frame of stream) {
        for (const tool of frameToolNames(frame)) {
          if (!allowed.has(tool)) throw new Error(`Claude workload attempted unavailable tool ${tool}`);
          calls.push(tool);
        }
        if (frame.type !== "result") continue;
        if (frame.subtype !== "success" || frame.is_error === true) {
          throw new Error("Claude workload provider returned a failed result");
        }
        return {
          rawVerdict: resultText(frame),
          usage: typeof frame.usage === "object" && frame.usage !== null
            ? frame.usage as Record<string, unknown>
            : null,
          repositoryToolCalls: calls,
        };
      }
      throw new Error("Claude workload stream ended without a result");
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
