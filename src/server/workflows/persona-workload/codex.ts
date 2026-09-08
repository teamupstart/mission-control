import {
  AppServerClient,
  type AppServerTransport,
} from "../../harness/codex/app-server/client.ts";
import type {
  ErrorNotification,
  InitializeParams,
  InitializeResponse,
  ItemCompletedNotification,
  RequestId,
  ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartResponse,
  UserInput,
} from "../../harness/codex/app-server/protocol.ts";
import { codexExecutable, spawnAppServer } from "../../harness/codex/sdk-deps.ts";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertProviderNeutralLaunch,
  codexRepositoryMcpArgs,
  personaProviderSubprocessEnv,
  PERSONA_CODEX_DISABLED_FEATURES,
  type PersonaProviderLaunch,
  type PersonaProviderResult,
  type PersonaWorkloadProviderAdapter,
} from "./provider.ts";
import { validateLlmImages } from "../../llm/images.ts";
import {
  REPOSITORY_MCP_SERVER_NAME,
  repositoryMcpToolName,
} from "@shared/repository-access.ts";

const CLIENT_INFO = { name: "mission-control-persona-workload", title: "Mission Control Persona Workload", version: "1.0.0" };
// Enterprise-managed Codex installations may refuse `never`. The workload client rejects
// every interactive provider request above, so `on-request` remains non-interactive and
// fail-closed while satisfying the provider's managed approval-policy floor.
const APPROVAL_POLICY = "on-request" as const;

interface CodexWorkloadDeps {
  connect(args: readonly string[], cwd: string, options: CodexConnectionOptions): Promise<AppServerTransport>;
}

interface CodexConnectionOptions {
  signal: AbortSignal;
  deadline: number;
}

interface CodexStopGuard {
  promise: Promise<never>;
  dispose(): void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function createStopGuard(signal: AbortSignal, deadline: number, deadlineMessage: string): CodexStopGuard {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let rejectGuard: (error: Error) => void = () => {};
  const abort = () => rejectGuard(signal.reason instanceof Error ? signal.reason : new Error("Codex workload cancelled"));
  const scheduleDeadline = () => {
    if (disposed) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      rejectGuard(new Error(deadlineMessage));
      return;
    }
    timer = setTimeout(scheduleDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
    timer.unref?.();
  };
  const promise = new Promise<never>((_resolve, reject) => {
    rejectGuard = reject;
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else scheduleDeadline();
  });
  promise.catch(() => {});
  return {
    promise,
    dispose() {
      disposed = true;
      signal.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
    },
  };
}

interface CodexConfigLayerName {
  type?: unknown;
}

interface CodexConfigRead {
  config?: {
    mcp_servers?: unknown;
    web_search?: unknown;
    tools?: { web_search?: unknown };
    features?: Record<string, unknown>;
  };
  origins?: Record<string, { name?: CodexConfigLayerName; version?: unknown }>;
  layers?: Array<{
    name?: CodexConfigLayerName;
    version?: unknown;
    config?: {
      tools?: { web_search?: unknown };
      features?: Record<string, unknown>;
    };
  }>;
}

function resolvedSessionFlagIsFalse(
  effective: CodexConfigRead,
  path: string,
  valueFromLayer: (layer: NonNullable<CodexConfigRead["layers"]>[number]) => unknown,
): boolean {
  // Current Codex versions can resolve the launch override correctly while omitting its
  // flattened value. In that response shape, require the authoritative origin to point at
  // the exact session-flags layer that contains our fail-closed override. A false value in
  // any inherited layer is insufficient because a later layer could still replace it.
  const origin = effective.origins?.[path];
  if (origin?.name?.type !== "sessionFlags" || typeof origin.version !== "string") return false;
  const originType = origin.name.type;
  const layer = effective.layers?.find((candidate) => (
    candidate.name?.type === originType && candidate.version === origin.version
  ));
  return layer !== undefined && valueFromLayer(layer) === false;
}

function nativeWebSearchIsDisabled(effective: CodexConfigRead): boolean {
  return effective.config?.tools?.web_search === false || resolvedSessionFlagIsFalse(
    effective,
    "tools.web_search",
    (layer) => layer.config?.tools?.web_search,
  );
}

function featureIsDisabled(effective: CodexConfigRead, feature: string): boolean {
  return effective.config?.features?.[feature] === false || resolvedSessionFlagIsFalse(
    effective,
    `features.${feature}`,
    (layer) => layer.config?.features?.[feature],
  );
}

export function codexInheritedMcpDisableArgs(serverNames: readonly string[]): string[] {
  const inherited = [...new Set(serverNames)]
    .filter((name) => name !== REPOSITORY_MCP_SERVER_NAME)
    .sort((left, right) => left.localeCompare(right));
  for (const name of inherited) {
    // Codex's config override parser rejects quoted dotted-key segments. Fail closed if
    // an inherited definition cannot be named by its accepted bare-key grammar.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`Codex workload cannot safely disable inherited MCP server ${JSON.stringify(name)}`);
    }
  }
  return inherited.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
}

function enabledMcpServerNames(servers: unknown): string[] | null {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  return Object.entries(servers as Record<string, unknown>)
    .filter(([, value]) => (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || (value as { enabled?: unknown }).enabled !== false
    ))
    .map(([name]) => name);
}

async function configuredMcpServerNames(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: CodexConnectionOptions,
): Promise<string[]> {
  const transport = spawnAppServer(executable, args, cwd, environment);
  let client: AppServerClient;
  client = new AppServerClient(transport, {
    request(method, id) {
      client.respondError(id, -32_603, `Persona workload configuration probe rejects ${method}`);
    },
    notification() {},
  });
  const pump = client.pump();
  pump.catch(() => {});
  const stopped = createStopGuard(options.signal, options.deadline, "Codex workload deadline exceeded during configuration probe");
  try {
    await Promise.race([client.request<InitializeResponse>("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true, requestAttestation: false },
    }), stopped.promise]);
    const effective = await Promise.race([client.request<CodexConfigRead>("config/read", {
      cwd,
      includeLayers: false,
    }), stopped.promise]);
    const servers = effective.config?.mcp_servers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      throw new Error("Codex workload could not enumerate inherited MCP servers");
    }
    return Object.keys(servers as Record<string, unknown>);
  } finally {
    stopped.dispose();
    await client.close().catch(() => {});
    await pump.catch(() => {});
  }
}

export async function connectIsolatedCodexWorkload(
  args: readonly string[],
  cwd: string,
  options: CodexConnectionOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AppServerTransport> {
  const isolatedStateRoot = join(cwd, ".codex-workload-state");
  const isolatedLogRoot = join(isolatedStateRoot, "logs");
  await mkdir(isolatedLogRoot, { mode: 0o700, recursive: true });
  const configuredStateRoot = environment.CODEX_HOME || join(homedir(), ".codex");
  const providerEnvironment = {
    ...personaProviderSubprocessEnv(environment),
    CODEX_HOME: configuredStateRoot,
  };
  const stateArgs = [
    "-c", `sqlite_home=${JSON.stringify(isolatedStateRoot)}`,
    "-c", `log_dir=${JSON.stringify(isolatedLogRoot)}`,
  ];
  const executable = await codexExecutable();
  const inheritedServers = await configuredMcpServerNames(
    executable,
    [...args, ...stateArgs],
    cwd,
    providerEnvironment,
    options,
  );
  return spawnAppServer(
    executable,
    [...args, ...stateArgs, ...codexInheritedMcpDisableArgs(inheritedServers)],
    cwd,
    providerEnvironment,
  );
}

const defaultDeps: CodexWorkloadDeps = {
  connect: connectIsolatedCodexWorkload,
};

export class CodexPersonaWorkloadAdapter implements PersonaWorkloadProviderAdapter {
  readonly id = "codex" as const;

  constructor(private readonly deps: CodexWorkloadDeps = defaultDeps) {}

  async run(launch: PersonaProviderLaunch, signal: AbortSignal): Promise<PersonaProviderResult> {
    assertProviderNeutralLaunch(launch);
    if (launch.provider !== this.id) throw new Error("Codex workload adapter received another provider");
    const images = validateLlmImages(launch.images);
    const connection = this.deps.connect(
      codexRepositoryMcpArgs(launch.repositoryMcp),
      launch.workingDirectory,
      { signal, deadline: launch.deadline },
    );
    const connecting = createStopGuard(signal, launch.deadline, "Codex workload deadline exceeded during connection setup");
    let transport: AppServerTransport;
    try {
      transport = await Promise.race([connection, connecting.promise]);
    } catch (error) {
      void connection.then((lateTransport) => lateTransport.close()).catch(() => {});
      throw error;
    } finally {
      connecting.dispose();
    }
    let threadId: string | null = null;
    let turnId: string | null = null;
    let finalResponse = "";
    let usage: Record<string, unknown> | null = null;
    let hostedSearchMode: "unverified" | "disabled" | "cached" = "unverified";
    const calls: string[] = [];
    let settle: (result: PersonaProviderResult) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const completed = new Promise<PersonaProviderResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    completed.catch(() => {});
    const providerFailure = completed.then<never>(() => new Promise<never>(() => {}));
    providerFailure.catch(() => {});
    let client: AppServerClient;
    client = new AppServerClient(transport, {
      request(method: string, id: RequestId) {
        client.respondError(id, -32_603, `Persona workloads do not accept provider request ${method}`);
        fail(new Error(`Codex workload attempted interactive provider request ${method}`));
      },
      notification(method: string, params: unknown) {
        try {
          if (method === "item/completed") {
            const item = (params as ItemCompletedNotification).item;
            switch (item.type) {
              case "userMessage":
                // Protocol echo of the input submitted by this client. It grants no
                // capability and produces no workload output.
                break;
              case "agentMessage":
                finalResponse = item.text;
                break;
              case "reasoning":
                break;
              case "mcpToolCall": {
                if (item.server !== launch.repositoryMcp.serverName) {
                  throw new Error(`Codex workload attempted unavailable MCP server ${item.server}`);
                }
                const tool = repositoryMcpToolName(item.tool as never);
                if (!launch.allowedTools.includes(tool)) {
                  throw new Error(`Codex workload attempted unavailable tool ${tool}`);
                }
                calls.push(tool);
                break;
              }
              case "webSearch":
                if (hostedSearchMode !== "cached") {
                  throw new Error("Codex workload exposed hosted search outside the cached-only policy");
                }
                break;
              default:
                throw new Error(`Codex workload exposed forbidden provider item ${item.type}`);
            }
          } else if (method === "thread/tokenUsage/updated") {
            usage = (params as ThreadTokenUsageUpdatedNotification).tokenUsage.last as unknown as Record<string, unknown>;
          } else if (method === "error") {
            const error = params as ErrorNotification;
            if (!error.willRetry) throw new Error(error.error.message || "Codex workload failed");
          } else if (method === "turn/completed") {
            const turn = (params as TurnCompletedNotification).turn;
            if (turn.status !== "completed") throw new Error(turn.error?.message || `Codex workload ended ${turn.status}`);
            if (!finalResponse.trim()) throw new Error("Codex workload returned no final verdict");
            settle({ rawVerdict: finalResponse, usage, repositoryToolCalls: calls });
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    const pump = client.pump();
    pump.catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
    const abort = () => {
      if (threadId && turnId) void client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const stopped = createStopGuard(signal, launch.deadline, "Codex workload deadline exceeded");
    const request = <Result>(method: string, params: unknown): Promise<Result> => Promise.race([
      client.request<Result>(method, params),
      providerFailure,
      stopped.promise,
    ]);
    try {
      const initialize: InitializeParams = {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true, requestAttestation: false },
      };
      await request<InitializeResponse>("initialize", initialize);
      const effective = await request<CodexConfigRead>("config/read", {
        cwd: launch.workingDirectory,
        includeLayers: true,
      });
      const serverNames = enabledMcpServerNames(effective.config?.mcp_servers);
      if (!serverNames) {
        throw new Error("Codex workload could not verify its isolated MCP configuration");
      }
      if (serverNames.length !== 1 || serverNames[0] !== launch.repositoryMcp.serverName) {
        throw new Error("Codex workload inherited an MCP server outside the repository capability");
      }
      const webSearch = effective.config?.web_search;
      if (webSearch !== "disabled" && webSearch !== launch.hostedSearchMaximum) {
        throw new Error("Codex workload exceeded the cached-only hosted-search policy");
      }
      hostedSearchMode = webSearch;
      if (!nativeWebSearchIsDisabled(effective)) {
        throw new Error("Codex workload did not disable tools.web_search");
      }
      for (const feature of PERSONA_CODEX_DISABLED_FEATURES) {
        if (!featureIsDisabled(effective, feature)) {
          throw new Error(`Codex workload did not disable ${feature}`);
        }
      }
      const started = await request<ThreadStartResponse>("thread/start", {
        cwd: launch.workingDirectory,
        model: launch.model,
        approvalPolicy: APPROVAL_POLICY,
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions:
          "This isolated Persona workload may use only the repository MCP tools. " +
          "Do not use shell, file changes, web search, network, or native repository tools.",
      });
      threadId = started.thread.id;
      const input: UserInput[] = [
        ...images.map((image): UserInput => ({ type: "localImage", path: image.path })),
        { type: "text", text: launch.prompt, text_elements: [] },
      ];
      const turn = await request<TurnStartResponse>("turn/start", {
        threadId,
        input,
        model: launch.model,
        approvalPolicy: APPROVAL_POLICY,
        outputSchema: launch.outputSchema,
      });
      turnId = turn.turn.id;
      if (signal.aborted) abort();
      return await Promise.race([completed, stopped.promise]);
    } finally {
      stopped.dispose();
      signal.removeEventListener("abort", abort);
      await client.close().catch(() => {});
      await pump.catch(() => {});
    }
  }
}
