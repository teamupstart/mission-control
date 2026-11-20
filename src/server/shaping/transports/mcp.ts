import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readToken } from "@shared/harness-runtime.mjs";
import { canonicalJson, type ShapingContext, type ShapingRequest } from "@shared/shaping.ts";
import { executableLocator } from "../../executables/locator.ts";
import { cappedFetch, fetchOnOrigin, ResponseCapError } from "../../origin-fetch.ts";
import type { ResolvedValue } from "../references.ts";
import { carriedEnvName, carriedHeaders, carriedMeta, withoutCarriedHeaders } from "./carriers.ts";
import {
  credentialBearingValues, folderCommand, receivedValues, redactReceived, removeScratch, shaperCommandEnv, withTimeout,
  type ReceivedValues,
} from "./command.ts";
import {
  callHeaders, callSignal, dataReply, egressRefusal, failure, MCP_OWNED_HEADERS, quoted, REMOTE_REPLY_BYTES, requestFailure, seconds,
  withoutOwnedHeaders,
} from "./remote.ts";
import type { ShaperOf, ShapingTransport, TransportContext } from "./types.ts";

/**
 * The `mcp` transport: one `tools/call` per repository on an MCP server, started as a local
 * process or reached over streamable HTTP. The server is connected once per shaping run, shared
 * by every call of the run that names the same server, and closed when the run ends.
 *
 * Every message from the server is capped at 256 KiB while it is received, the cap an `http` body
 * has: over stdio through the SDK's read buffer, over streamable HTTP through a `fetch` that stops
 * reading a body, or one event of an event stream, at the cap. Either way the call answers
 * `failed` at once, naming the cap, the server is closed and nothing over the cap is parsed.
 */

// ---------------------------------------------------------------------------------------------
// What the tool is called with

/** One value on one line of the folded block: a line break in it would read as another line. */
function inline(value: string): string {
  return value.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function orNone(value: string | null | undefined): string {
  return value ? inline(value) : "none";
}

/**
 * The fixed block `folded` mode appends to the prompt: every field of the request's `context`
 * except local paths, one line each. Pure, so a test pins its text, and a test that walks the
 * context schema fails when a field has no line here.
 */
export function foldedContextBlock(context: ShapingContext): string {
  const harness = `${orNone(context.harness)}${context.runtime ? ` (${inline(context.runtime)})` : ""}`;
  const afterWork = context.afterWork
    ? `${orNone(context.afterWork.name)} (workflow ${orNone(context.afterWork.workflowId)})`
    : "none";
  const caller = `${context.caller.user ? inline(context.caller.user) : "undeclared"} (agent ${orNone(context.caller.agent)}, conversation ${orNone(context.caller.conversation)})`;
  const repositories = context.repositories.map((repo) =>
    `${repo.slot} ${inline(repo.name)} (${repo.role}, branch ${orNone(repo.branch)}, base ${orNone(repo.baseSha)})`).join(", ");
  return [
    "Task context from Mission Control:",
    `- Task: ${orNone(context.taskId)}`,
    `- Title: ${orNone(context.title)}`,
    `- Kind: ${orNone(context.kind)}`,
    `- Harness: ${harness}`,
    `- After-work step: ${afterWork}`,
    `- Labels: ${context.labels.length > 0 ? context.labels.map(inline).join(", ") : "none"}`,
    `- Priority: ${orNone(context.priority)}`,
    `- Caller: ${caller}`,
    `- This call is about: ${context.target}`,
    `- Repositories: ${repositories || "none"}`,
  ].join("\n");
}

/**
 * The tool's arguments. `folded`: exactly FR-02's `{ task, repo, version? }`, with the context
 * block after the prompt. `argument`: the prompt alone and the whole `context` as a fourth. Either
 * way the complete collected input reaches the tool, and `repo` never carries a path.
 */
export function mcpToolArguments(request: ShapingRequest, delivery: "folded" | "argument"): Record<string, unknown> {
  const repo = {
    name: request.repo.name,
    ...(request.repo.facts ? { facts: request.repo.facts } : {}),
    ...(request.repo.summary !== undefined ? { summary: request.repo.summary } : {}),
  };
  const version = request.version !== undefined ? { version: request.version } : {};
  if (delivery === "argument") return { task: request.task, repo, ...version, context: request.context };
  const block = foldedContextBlock(request.context);
  return { task: request.task ? `${request.task}\n\n${block}` : block, repo, ...version };
}

// ---------------------------------------------------------------------------------------------
// One connection per run

interface Connection {
  client: Client;
  /** Rejects when the connection failed or closed, with the reason the calls on it answer. */
  readonly lost: Promise<never>;
  /** Why the connection was lost, once it was. */
  readonly failure: string | null;
  /** Values the server was handed, scrubbed from whatever it sends back. */
  readonly resolved: readonly ResolvedValue[];
}

interface Opened {
  connection: Promise<Connection>;
}

const CLIENT_INFO = { name: "mission-control-task-shaping", version: "1" };
/** How long ending a streamable-HTTP session may take before the client is closed anyway. */
const END_SESSION_MS = 2_000;

function capReason(): string {
  return `A message from the MCP server was larger than ${REMOTE_REPLY_BYTES / 1024} KiB, so it was not read and the server was closed.`;
}

/** Whether an error is the SDK's stdio read buffer passing the cap it was given. */
function stdioOverflow(error: unknown): boolean {
  return error instanceof Error && /ReadBuffer exceeded maximum size/.test(error.message);
}

/** A lost-connection latch: `fail` settles `lost` once, and every later call sees the first reason. */
function latch(): { lost: Promise<never>; fail(reason: string): void; readonly failure: string | null } {
  let failure: string | null = null;
  let reject!: (error: Error) => void;
  const lost = new Promise<never>((_resolve, rejectLost) => { reject = rejectLost; });
  lost.catch(() => {});
  return {
    lost,
    fail(reason) {
      if (failure !== null) return;
      failure = reason;
      reject(new Error(reason));
    },
    get failure() { return failure; },
  };
}

/** The key one server is shared under for the rest of a run. */
function connectionKey(shaper: ShaperOf<"mcp">, ctx: TransportContext, headers: Readonly<Record<string, string>> | null): string {
  return `mcp\u0000${canonicalJson(shaper.transport.server)}\u0000${ctx.root ?? ""}\u0000${headers ? canonicalJson(headers) : ""}`;
}

/** How long after a reply stream ends its reply may still be on its way through the client's parser. */
const REPLY_SETTLE_MS = 100;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The JSON-RPC id of the request a POST body carries, when it is one. */
function requestId(body: unknown): string | number | null {
  if (typeof body !== "string") return null;
  try {
    const message = JSON.parse(body) as { id?: unknown; method?: unknown };
    return typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
  } catch {
    return null;
  }
}

/**
 * A `fetch` that tells `interrupted` when a request's own successful event stream ends, or
 * breaks, and its reply has not arrived shortly after: `answered` says whether it did. Only a
 * POST that carries a request and is answered with an event stream is watched; a JSON reply
 * that breaks already fails its request where the client reads it.
 */
function watchReplyStreams(base: FetchLike, answered: (id: string | number) => boolean, interrupted: () => void): FetchLike {
  return async (input, init) => {
    const response = await base(input, init);
    const id = requestId(init?.body);
    const stream = response.ok && (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
    if (id === null || !stream || !response.body) return response;
    const source = response.body.getReader();
    const ended = () => setTimeout(() => { if (!answered(id)) interrupted(); }, REPLY_SETTLE_MS);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try { read = await source.read(); } catch (error) { ended(); controller.error(error); return; }
        if (read.done) { ended(); controller.close(); return; }
        controller.enqueue(read.value);
      },
      cancel(reason) { return source.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * Record the id of every reply the transport delivers. Set before the client connects: the client
 * keeps a handler already on the transport and calls it before its own for every message.
 */
function observeReplies<Message>(transport: { onmessage?: (message: Message) => void }, answered: Set<string | number>): void {
  transport.onmessage = (message: Message) => {
    const reply = message as { id?: unknown; method?: unknown } | null;
    if (reply && reply.method === undefined && (typeof reply.id === "string" || typeof reply.id === "number")) answered.add(reply.id);
  };
}

/** Every value in `lists`, each name and value once. */
function mergeResolved(...lists: ReadonlyArray<readonly ResolvedValue[]>): ResolvedValue[] {
  const seen = new Set<string>();
  return lists.flat().filter(({ name, value }) => {
    const key = `${name}\u0000${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** How long the handshake may take: what is left of the whole step, never more. */
function handshakeMs(ctx: TransportContext): number {
  return Math.max(1, ctx.deadline - Date.now());
}

async function openStdio(shaper: ShaperOf<"mcp">, ctx: TransportContext): Promise<Connection> {
  const server = shaper.transport.server;
  if (server.type !== "stdio") throw new Error("not a stdio server");
  const [{ Client: McpClient }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  // The `command` transport's environment and rules: scrubbed, plus only the variables the shaper
  // names, with the launch's trace context and work unit id. One process per run, so the run's.
  const env = shaperCommandEnv(process.env, server.env, readToken(), ctx.trace, ctx.workUnitId);
  let command = server.command;
  if (command.startsWith("./")) {
    const located = folderCommand(command, ctx.root);
    if ("problem" in located) throw new UnavailableError(located.problem);
    command = located.path;
  }
  const scratch = mkdtempSync(join(tmpdir(), "mission-shaper-mcp-"));
  const executable = await executableLocator.resolveCommand(command, { env, cwd: scratch }).catch(() => null);
  if (!executable) {
    void removeScratch(scratch);
    throw new UnavailableError(`The command "${server.command}" was not found.`);
  }
  // A value the operator named in `env` is a credential the server may echo, as it is for a
  // `command` shaper: removed from replies under its name, and from every diagnostic.
  const credentials = credentialBearingValues(executable.env);
  const named: ResolvedValue[] = [
    ...server.env.filter((name) => !carriedEnvName(name)).flatMap((name) => {
      const value = executable.env[name];
      return value ? [{ name, value }] : [];
    }),
    ...credentials,
  ];
  const inherited = receivedValues(executable.env, server.env);
  const received: ReceivedValues = {
    values: [...new Set([...inherited.values, ...credentials.map(({ value }) => value)])].sort((a, b) => b.length - a.length),
    named: new Set([...inherited.named, ...credentials.map(({ value }) => value)]),
  };
  const state = latch();
  const transport = new StdioClientTransport({
    command: executable.path,
    args: server.args,
    env: executable.env as Record<string, string>,
    cwd: scratch,
    stderr: "pipe",
    maxBufferSize: REMOTE_REPLY_BYTES,
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_000); });
  const tail = (): string => {
    const text = redactReceived(stderr, received).replace(/\s+/g, " ").trim().slice(-500);
    return text ? `: ${text}` : ".";
  };
  const client = new McpClient(CLIENT_INFO, { capabilities: {} });
  transport.onerror = (error) => {
    if (!stdioOverflow(error)) return;
    state.fail(capReason());
    // Stopped now, not when the run ends: a server that overflowed stays useless.
    void client.close().catch(() => {});
  };
  transport.onclose = () => state.fail(`The MCP server exited${tail()}`);
  ctx.scope.defer(async () => {
    try { await client.close(); } finally { await removeScratch(scratch, (text) => redactReceived(text, received)); }
  });
  try {
    // Raced against the latch: an overflow or an exit during the handshake answers at once.
    await Promise.race([client.connect(transport, { timeout: handshakeMs(ctx) }), state.lost]);
  } catch (error) {
    if (state.failure) throw new Error(state.failure);
    // The SDK's message can carry what the server wrote, which can repeat anything in its
    // environment, so the whole sentence is scrubbed of every value the child received.
    const said = `The MCP server did not complete its handshake: ${requestFailure(error)}`;
    const marked = named.some(({ value }) => said.includes(value) || stderr.includes(value));
    throw new ConnectError(`${redactReceived(said, received)}${tail()}`, marked);
  }
  return { client, lost: state.lost, get failure() { return state.failure; }, resolved: named };
}

async function openHttp(
  shaper: ShaperOf<"mcp">,
  ctx: TransportContext,
  headers: Readonly<Record<string, string>>,
  resolved: readonly ResolvedValue[],
): Promise<Connection> {
  const server = shaper.transport.server;
  if (server.type !== "http") throw new Error("not an http server");
  const [{ Client: McpClient }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const state = latch();
  const url = new URL(server.url);
  // The configured headers ride every request, only to the server's origin; the launch's trace
  // context and work unit id ride every request through `requestInit`, created once for the run.
  // `headers` already holds the carried ones beside the configured; only the configured go here.
  // They are set over the client's own on every request, so any the client owns are left out.
  const configured = withoutOwnedHeaders(withoutCarriedHeaders(headers), MCP_OWNED_HEADERS);
  const onOrigin = (input: string | URL | Request, init?: RequestInit) => fetchOnOrigin(url.origin, configured, input, { ...init, credentials: "omit" });
  const capped = cappedFetch(onOrigin, REMOTE_REPLY_BYTES, (_error: ResponseCapError) => {
    state.fail(capReason());
    void client.close().catch(() => {});
  });
  // A request's reply can arrive on its own response stream. One that ends, or breaks, before
  // the reply came leaves the call waiting for an answer that will never come, while the
  // transport itself stays open: the connection is failed at once, so the call answers and the
  // next call of the run connects again.
  const answered = new Set<string | number>();
  const interrupted = () => {
    state.fail("The MCP server's response stream ended before the reply arrived.");
    void client.close().catch(() => {});
  };
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: watchReplyStreams(capped, (id) => answered.has(id), interrupted),
    requestInit: { headers: carriedHeaders(ctx.trace, ctx.workUnitId) },
    // A lost stream is not retried: the call it belonged to answers, and the run moves on.
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
  });
  transport.onclose = () => state.fail("The MCP server closed the connection.");
  observeReplies(transport, answered);
  const client = new McpClient(CLIENT_INFO, { capabilities: {} });
  ctx.scope.defer(async () => {
    if (state.failure === null) {
      await withTimeout(transport.terminateSession().catch(() => {}), END_SESSION_MS, new AbortController().signal);
    }
    await client.close();
  });
  try {
    await Promise.race([client.connect(transport, { timeout: handshakeMs(ctx) }), state.lost]);
  } catch (error) {
    if (state.failure) throw new Error(state.failure);
    throw new Error(`The MCP server did not complete its handshake: ${requestFailure(error)}`);
  }
  return { client, lost: state.lost, get failure() { return state.failure; }, resolved };
}

/** A connection that could not be opened because of the shaper's own config, not the server. */
class UnavailableError extends Error {}

/** A connection that failed, with a reason already scrubbed and whether a named value was removed from it. */
class ConnectError extends Error {
  constructor(message: string, readonly redacted: boolean) {
    super(message);
  }
}

/**
 * The run's connection to this shaper's server, opened by the first call that needs it and shared
 * by every later one. A connection that failed or was lost is forgotten, so the next call of the
 * run opens a fresh one rather than answering with the old failure.
 */
function connectionFor(
  shaper: ShaperOf<"mcp">,
  ctx: TransportContext,
  http: { headers: Record<string, string>; resolved: ResolvedValue[] } | null,
): Promise<Connection> {
  const key = connectionKey(shaper, ctx, http?.headers ?? null);
  const existing = ctx.scope.shared.get(key) as Opened | undefined;
  if (existing) return existing.connection;
  const connection = http ? openHttp(shaper, ctx, http.headers, http.resolved) : openStdio(shaper, ctx);
  const opened: Opened = { connection };
  ctx.scope.shared.set(key, opened);
  const forget = () => { if (ctx.scope.shared.get(key) === opened) ctx.scope.shared.delete(key); };
  connection.then((open) => open.lost.catch(forget), forget);
  return connection;
}

/** `pending`, or a rejection the moment `signal` aborts. */
function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** The text a tool put in its content, for a reply or an error. */
function contentText(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) =>
    item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"
      ? [(item as { text: string }).text]
      : []);
}

export const callMcp: ShapingTransport<"mcp"> = async (request, shaper, ctx) => {
  const { server, tool, contextDelivery } = shaper.transport;
  let http: { headers: Record<string, string>; resolved: ResolvedValue[] } | null = null;
  if (server.type === "http") {
    const refused = egressRefusal(server.url);
    if (refused) return { kind: "unavailable", reason: refused };
    const resolution = callHeaders(server.headers, request, ctx);
    if (!resolution.ok) return { kind: "unavailable", reason: resolution.reason };
    http = { headers: resolution.headers, resolved: resolution.resolved };
  }
  const signal = callSignal(ctx);
  const timedOut = () => ({ kind: "timed_out" as const, reason: `Timed out after ${seconds(ctx.timeoutMs)}.` });
  let connection: Connection;
  try {
    connection = await untilAborted(connectionFor(shaper, ctx, http), signal);
  } catch (error) {
    if (error instanceof UnavailableError) return { kind: "unavailable", reason: error.message };
    if (error instanceof ConnectError) return failure("failed", error.message, http?.resolved ?? [], error.redacted);
    if (signal.aborted) return timedOut();
    return failure("failed", error instanceof Error ? error.message : String(error), http?.resolved ?? []);
  }
  // This call's own resolved values as well as the connection's: two shapers can reach one
  // connection with the same header text built from different references, and each call scrubs
  // what it resolved itself.
  const resolved = mergeResolved(http?.resolved ?? [], connection.resolved);
  const meta = carriedMeta(ctx.trace, ctx.workUnitId);
  let result: Awaited<ReturnType<Client["callTool"]>>;
  try {
    result = await Promise.race([
      connection.client.callTool(
        { name: tool, arguments: mcpToolArguments(request, contextDelivery), ...(meta ? { _meta: meta } : {}) },
        undefined,
        { signal, timeout: Math.max(1, ctx.timeoutMs) },
      ),
      connection.lost,
    ]);
  } catch (error) {
    if (connection.failure) return failure("failed", connection.failure, resolved);
    if (signal.aborted || (error as { code?: unknown } | null)?.code === -32001) return timedOut();
    const detail = quoted(requestFailure(error), resolved);
    return failure("failed", `The MCP call failed: ${detail.text}`, resolved, detail.redacted);
  }
  if (connection.failure) return failure("failed", connection.failure, resolved);
  if (result.isError === true) {
    const detail = quoted(contentText(result.content).join(" "), resolved);
    return failure("failed", `The tool returned an error${detail.text ? `: ${detail.text}` : "."}`, resolved, detail.redacted);
  }
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) return dataReply(structured, resolved);
  const [text] = contentText(result.content);
  return dataReply(text ?? null, resolved);
};
