import { execFile } from "node:child_process";
import { z } from "zod";
import { Codex } from "@openai/codex-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  REPOSITORY_OPERATION_IDS,
  PersonaWorkloadProviderResultSchema,
  type PersonaWorkloadRequest,
  type RepositoryCapabilityReason,
} from "@shared/repository-access.ts";
import { providerJsonSchema } from "../../llm/json-schema.ts";
import { validateLlmImages } from "../../llm/images.ts";

export interface RepositoryProviderLaunch {
  request: PersonaWorkloadRequest;
  binary: string;
  cwd: string;
  env: Record<string, string>;
  mcp: { command: string; args: string[]; env: Record<string, string> };
  signal: AbortSignal;
}
export interface RepositoryProviderResult {
  verdict: unknown;
  usage: Record<string, number>;
}
export type RepositoryProvider = (
  launch: RepositoryProviderLaunch,
) => Promise<RepositoryProviderResult>;
export class RepositoryCapabilityError extends Error {
  constructor(readonly reason: RepositoryCapabilityReason) {
    super(reason);
  }
}
export const REPOSITORY_TOOL_NAMES = REPOSITORY_OPERATION_IDS.map(
  (name) => `mcp__repository__${name}`,
);
const schema = providerJsonSchema(PersonaWorkloadProviderResultSchema);
function providerVerdict(value: unknown): unknown {
  const parsed = PersonaWorkloadProviderResultSchema.safeParse(value);
  return parsed.success ? parsed.data.result.verdict : undefined;
}

/** One capability declaration translated into each provider's transport, never a general grant. */
export function codexRepositoryConfig(mcp: RepositoryProviderLaunch["mcp"]) {
  return {
    agents: { enabled: false },
    web_search: "disabled",
    tools: { view_image: false },
    features: {
      shell_tool: false,
      unified_exec: false,
      view_image: false,
      apps: false,
      browser_use: false,
      browser_use_external: false,
      computer_use: false,
      image_generation: false,
      multi_agent: false,
      plugins: false,
      skill_search: false,
      tool_suggest: false,
      goals: false,
      sleep_tool: false,
      hooks: false,
      code_mode: {
        enabled: true,
        excluded_tool_namespaces: ["functions", "clock", "collaboration"],
      },
    },
    mcp_servers: {
      repository: {
        ...mcp,
        required: true,
        enabled_tools: [...REPOSITORY_OPERATION_IDS],
        default_tools_approval_mode: "auto",
      },
    },
  };
}
// Native tool inventories are not a stable SDK API. Upgrade this allowlist only with the executable probe.
const VERIFIED_PROVIDER_BUILDS = {
  codex: "codex-cli 0.166.0",
  claude: "2.1.319 (Claude Code)",
} as const;
function providerProbe(
  executable: string,
  args: string[],
  launch: RepositoryProviderLaunch,
  maxBuffer: number,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      args,
      {
        cwd: launch.cwd,
        env: launch.env,
        signal: launch.signal,
        timeout: 10000,
        maxBuffer,
        encoding: "utf8",
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}
async function verifyProviderBuild(launch: RepositoryProviderLaunch) {
  const stdout = await providerProbe(
    launch.binary,
    ["--version"],
    launch,
    4096,
  );
  if (
    stdout.trim() !==
    VERIFIED_PROVIDER_BUILDS[launch.request.execution.provider]
  )
    throw new RepositoryCapabilityError("unverified_build");
}
function toml(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(",")}}`;
  throw Error("Invalid provider configuration");
}
async function verifyCodexMcpInventory(launch: RepositoryProviderLaunch) {
  const args = Object.entries(codexRepositoryConfig(launch.mcp)).flatMap(
    ([key, value]) => ["-c", `${key}=${toml(value)}`],
  );
  const stdout = await providerProbe(
    launch.binary,
    ["mcp", "list", "--json", ...args],
    launch,
    1048576,
  );
  let servers;
  try {
    servers = z.array(z.object({ name: z.string().max(200), enabled: z.boolean() }))
      .max(64).parse(JSON.parse(stdout));
  } catch {
    throw new RepositoryCapabilityError("tool_inventory");
  }
  const enabled = servers.filter((s) => s.enabled);
  if (enabled.length !== 1 || enabled[0]?.name !== "repository")
    throw new RepositoryCapabilityError("tool_inventory");
}
export async function runCodexRepositoryWorkload(
  launch: RepositoryProviderLaunch,
  deps: {
    createClient?: (
      options: ConstructorParameters<typeof Codex>[0],
    ) => Pick<Codex, "startThread">;
  } = {},
): Promise<RepositoryProviderResult> {
  await verifyProviderBuild(launch);
  validateLlmImages(launch.request.images);
  await verifyCodexMcpInventory(launch);
  launch.signal.throwIfAborted();
  const client = (deps.createClient ?? ((options) => new Codex(options)))({
    apiKey: launch.env.OPENAI_API_KEY,
    codexPathOverride: launch.binary,
    env: launch.env,
    config: codexRepositoryConfig(launch.mcp),
  });
  const thread = client.startThread({
    model: launch.request.execution.model,
    modelReasoningEffort: launch.request.execution.effort,
    workingDirectory: launch.cwd,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    webSearchMode: "disabled",
    networkAccessEnabled: false,
  });
  const result = await thread.run(
    [
      ...launch.request.images.map((i) => ({
        type: "local_image" as const,
        path: i.path,
      })),
      { type: "text", text: launch.request.prompt },
    ],
    { signal: launch.signal, outputSchema: schema },
  );
  return {
    verdict: providerVerdict(JSON.parse(result.finalResponse)),
    usage: result.usage ? { ...result.usage } : {},
  };
}
export const runClaudeRepositoryWorkload: RepositoryProvider = async (
  launch,
) => {
  await verifyProviderBuild(launch);
  if (launch.request.execution.effort === "xhigh")
    throw new RepositoryCapabilityError("unsupported_effort");
  const images = validateLlmImages(launch.request.images);
  const controller = new AbortController();
  const abort = () => controller.abort();
  launch.signal.addEventListener("abort", abort, { once: true });
  if (launch.signal.aborted) controller.abort();
  async function* prompt() {
    yield {
      type: "user" as const,
      parent_tool_use_id: null,
      session_id: "",
      message: {
        role: "user" as const,
        content: [
          ...images.map((i) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: i.mimeType,
              data: i.data.toString("base64"),
            },
          })),
          { type: "text" as const, text: launch.request.prompt },
        ],
      },
    };
  }
  const run = query({
    prompt: prompt(),
    options: {
      pathToClaudeCodeExecutable: launch.binary,
      cwd: launch.cwd,
      env: launch.env,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      mcpServers: { repository: launch.mcp },
      canUseTool: async (name, input) =>
        REPOSITORY_TOOL_NAMES.includes(name)
          ? { behavior: "allow", updatedInput: input }
          : {
              behavior: "deny",
              message: "Repository workload does not grant this tool",
            },
      model: launch.request.execution.model,
      effort: launch.request.execution.effort,
      maxTurns: launch.request.budgets.attemptCalls + 3,
      abortController: controller,
      outputFormat: { type: "json_schema", schema },
    },
  });
  try {
    let ready = false;
    for await (const frame of run) {
      if (frame.type === "system" && frame.subtype === "init") {
        const expected = new Set([
          ...REPOSITORY_TOOL_NAMES,
          "StructuredOutput",
        ]);
        if (
          frame.tools.some((name) => !expected.has(name)) ||
          REPOSITORY_TOOL_NAMES.some((name) => !frame.tools.includes(name)) ||
          frame.mcp_servers.length !== 1 ||
          frame.mcp_servers.some(
            (server) =>
              server.name !== "repository" || server.status !== "connected",
          )
        )
          throw new RepositoryCapabilityError("tool_inventory");
        ready = true;
      }
      if (frame.type === "result") {
        if (!ready) throw new RepositoryCapabilityError("tool_inventory");
        if (
          frame.subtype !== "success" ||
          frame.is_error ||
          frame.structured_output === undefined
        )
          throw Error("Invalid provider result");
        return {
          verdict: providerVerdict(frame.structured_output),
          usage: {
            input_tokens: frame.usage.input_tokens,
            output_tokens: frame.usage.output_tokens,
            total_cost_usd: frame.total_cost_usd,
          },
        };
      }
    }
    throw Error("Missing provider result");
  } finally {
    launch.signal.removeEventListener("abort", abort);
    run.close();
  }
};
export const REPOSITORY_PROVIDERS = {
  claude: runClaudeRepositoryWorkload,
  codex: runCodexRepositoryWorkload,
} as const;
