import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { FeatureFlagsConfigSchema, resolveFeatureFlags } from "@shared/feature-flags.ts";
import { HOME_DISPATCH_CAPABILITY, HEADLESS_MODE_FLAG_ID } from "@shared/home-dispatch.ts";
import {
  AnswerTaskInputSchema,
  answerTaskProblem,
  CheckinInputSchema,
  HOME_DISPATCH_MCP_TOOLS,
  ReadDispatchOptionsInputSchema,
  ReadInboxInputSchema,
  StartDispatchInputSchema,
  SubmitBriefInputSchema,
  type HomeDispatchMcpTool,
  type HomeDispatchToolResult,
} from "@shared/home-dispatch-tools.ts";

/**
 * Headless mode's six MCP tools (spec 2.3, 7.10).
 *
 * WP1 lands the seam and stubs. The tools are registered DISABLED, so a server that never
 * enables them lists exactly the tools it listed before: flag off is byte-identical.
 * `refresh` enables them while the daemon lists `home-dispatch-v1` in `/api/health` and this
 * process is not a Mission Control worker, and disables them otherwise. `McpServer` sends
 * `notifications/tools/list_changed` itself on each change. WP5a replaces the stub handlers and
 * adds the real handlers.
 *
 * `follow` keeps the tools in step with the flag for the whole session: it opens the daemon's
 * `/events` stream, applies the flag from the reconnect snapshot and from each `feature_flags`
 * event, and reconnects with backoff while the daemon is down. Turning the flag off therefore
 * removes the tools from a session that is already open, with a `tools/list_changed`
 * notification. A worker never subscribes.
 */

export type HomeDispatchHttp = (path: string, method: string, body?: unknown) => Promise<Response>;

export interface HomeDispatchToolsOptions {
  /** Defaults to `process.env`. A worker is a process Mission Control launched: it has `MISSION_SESSION_ID`. */
  env?: NodeJS.ProcessEnv;
  /** Reads the daemon's `/api/health` body, or null when it is unreachable. Injected for tests. */
  readHealth?: () => Promise<unknown>;
  /** Opens the daemon's `/events` stream. Injected so tests and the server choose the transport. */
  openEvents?: (signal: AbortSignal) => Promise<Response>;
}

export interface HomeDispatchTools {
  /** Re-read the flag (through health) and enable or disable the tools to match. */
  refresh(): Promise<boolean>;
  /** Enable or disable directly. Never enables inside a worker. */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /** Follow the flag through the daemon's event stream until `stop`. No-op inside a worker. */
  follow(): void;
  /** Stop following and release the stream, so the process can exit. */
  stop(): void;
  readonly names: readonly HomeDispatchMcpTool[];
}

/** Whether the flag is on in a flag config as the event stream carries it. Never cached. */
export function headlessFlagOn(config: unknown): boolean {
  const parsed = FeatureFlagsConfigSchema.safeParse(config);
  return parsed.success && resolveFeatureFlags(parsed.data)[HEADLESS_MODE_FLAG_ID] === true;
}

/** The flag config in one SSE data frame: the reconnect snapshot's, or a `feature_flags` event's. */
function configFromFrame(data: string): unknown {
  try {
    const event = JSON.parse(data) as { type?: string; config?: unknown; featureFlags?: unknown };
    if (event.type === "feature_flags") return event.config;
    if (event.type === "snapshot") return event.featureFlags;
  } catch { /* a partial or foreign frame says nothing about the flag */ }
  return undefined;
}

async function readFrames(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    pending += decoder.decode(value, { stream: true });
    for (let end = pending.search(/\r?\n\r?\n/); end !== -1; end = pending.search(/\r?\n\r?\n/)) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end).replace(/^\r?\n\r?\n/, "");
      const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) onData(data);
    }
  }
}

const INPUT_SHAPES: Record<HomeDispatchMcpTool, ZodRawShape> = {
  start_dispatch: StartDispatchInputSchema.shape,
  submit_brief: SubmitBriefInputSchema.shape,
  checkin: CheckinInputSchema.shape,
  read_inbox: ReadInboxInputSchema.shape,
  answer_task: AnswerTaskInputSchema.shape,
  read_dispatch_options: ReadDispatchOptionsInputSchema.shape,
};

const DESCRIPTIONS: Record<HomeDispatchMcpTool, string> = {
  start_dispatch: "Start a Mission Control dispatch from this session: pick the kind and what runs after the work, then confirm.",
  submit_brief: "Add the description and context to a dispatch draft, then show the summary and the confirm form.",
  checkin: "Show the tasks Mission Control is running for this repository, and answer the ones waiting on you.",
  read_inbox: "Read this repository's Mission Control inbox as plain text.",
  answer_task: "Send the person's answer to a waiting Mission Control task. Send only what the person said.",
  read_dispatch_options: "Read the dispatch choices as plain questions, for clients that cannot show forms.",
};

export function isMissionWorker(env: NodeJS.ProcessEnv): boolean {
  return env.MISSION_SESSION_ID !== undefined;
}

export function registerHomeDispatchTools(
  server: McpServer,
  _http: HomeDispatchHttp,
  options: HomeDispatchToolsOptions = {},
): HomeDispatchTools {
  const env = options.env ?? process.env;
  const worker = isMissionWorker(env);

  const handles = HOME_DISPATCH_MCP_TOOLS.map((name) => {
    const handle = server.registerTool(
      name,
      { description: DESCRIPTIONS[name], inputSchema: INPUT_SHAPES[name] },
      async (input: unknown) => {
        if (name === "answer_task") {
          // Action-specific fields, checked before anything else, as the answers route would.
          const problem = answerTaskProblem(input as Parameters<typeof answerTaskProblem>[0]);
          if (problem) {
            return { content: [{ type: "text" as const, text: `invalid answer_task input: ${problem}` }], isError: true };
          }
        }
        const structuredContent: HomeDispatchToolResult = { outcome: "not-implemented" };
        const text = name + " is not implemented yet in this build of " + HEADLESS_MODE_FLAG_ID + ".";
        return { content: [{ type: "text" as const, text }], structuredContent, isError: true };
      },
    );
    handle.disable();
    return handle;
  });

  const setEnabled = (enabled: boolean): void => {
    const on = enabled && !worker;
    for (const handle of handles) {
      if (handle.enabled === on) continue;
      if (on) handle.enable();
      else handle.disable();
    }
  };

  const controller = new AbortController();
  const isEnabled = (): boolean => handles.length > 0 && handles.every((handle) => handle.enabled);

  // Bumped whenever the event stream decides the flag (a snapshot, an event, or losing the
  // stream). The startup health read is only a first guess: if the stream has spoken since the
  // read began, the read is stale and must not overwrite it.
  let streamDecisions = 0;
  const decideFromStream = (enabled: boolean): void => {
    streamDecisions++;
    setEnabled(enabled);
  };

  const refresh = async (): Promise<boolean> => {
    if (worker || !options.readHealth) return false;
    const before = streamDecisions;
    let on = false;
    try {
      const health = (await options.readHealth()) as { capabilities?: unknown } | null;
      on = Array.isArray(health?.capabilities) && health.capabilities.includes(HOME_DISPATCH_CAPABILITY);
    } catch {
      on = false;
    }
    if (streamDecisions !== before || controller.signal.aborted) return isEnabled();
    setEnabled(on);
    return on;
  };

  let following = false;
  const follow = (): void => {
    if (worker || !options.openEvents || following) return;
    following = true;
    const open = options.openEvents;
    void (async () => {
      let delay = 500;
      while (!controller.signal.aborted) {
        try {
          const res = await open(controller.signal);
          if (res.ok && res.body) {
            delay = 500;
            await readFrames(res.body, (data) => {
              const config = configFromFrame(data);
              if (config !== undefined) decideFromStream(headlessFlagOn(config));
            });
          }
        } catch { /* daemon down or stream cut: reconnect below */ }
        if (controller.signal.aborted) return;
        // Fail closed: with no stream the flag is unknown, so the tools go until a reconnect
        // snapshot says otherwise. A daemon that is down could not serve them anyway.
        decideFromStream(false);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        delay = Math.min(delay * 2, 15_000);
      }
    })();
  };

  return { refresh, setEnabled, isEnabled, follow, stop: () => controller.abort(), names: HOME_DISPATCH_MCP_TOOLS };
}
