import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readToken } from "@shared/harness-runtime.mjs";
import { canonicalJson, SHAPING_LIMIT_RANGES, type ShapingContext, type ShapingRequest } from "@shared/shaping.ts";
import { executableLocator } from "../../executables/locator.ts";
import { cappedFetch, fetchOnOrigin, ResponseCapError } from "../../origin-fetch.ts";
import { holdsResolvedValue, redactResolved, type ResolvedValue } from "../references.ts";
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
  /** Whether a named value was scrubbed from that reason before it was kept. */
  readonly failureRedacted: boolean;
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
function latch(): { lost: Promise<never>; fail(reason: string, redacted?: boolean): void; readonly failure: string | null; readonly redacted: boolean } {
  let failure: string | null = null;
  let marked = false;
  let reject!: (error: Error) => void;
  const lost = new Promise<never>((_resolve, rejectLost) => { reject = rejectLost; });
  lost.catch(() => {});
  return {
    lost,
    fail(reason, redacted = false) {
      if (failure !== null) return;
      failure = reason;
      marked = redacted;
      reject(new Error(reason));
    },
    get failure() { return failure; },
    get redacted() { return marked; },
  };
}

/** The key one server is shared under for the rest of a run. */
function connectionKey(shaper: ShaperOf<"mcp">, ctx: TransportContext, headers: Readonly<Record<string, string>> | null): string {
  return `mcp\u0000${canonicalJson(shaper.transport.server)}\u0000${ctx.root ?? ""}\u0000${headers ? canonicalJson(headers) : ""}`;
}

/** How much of a local server's stderr is kept for a diagnostic, before the redaction margin. */
const STDERR_KEEP_CHARS = 4_000;

/** How long after a reply stream ends its reply may still be on its way through the client's parser. */
const REPLY_SETTLE_MS = 100;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The JSON-RPC id and method of the request a POST body carries, when it is one. */
function requestOf(body: unknown): { id: string | number; method: string } | null {
  if (typeof body !== "string") return null;
  try {
    const message = JSON.parse(body) as { id?: unknown; method?: unknown };
    return typeof message.method === "string" && (typeof message.id === "string" || typeof message.id === "number")
      ? { id: message.id, method: message.method }
      : null;
  } catch {
    return null;
  }
}

/**
 * The call a request belongs to. `callMcp` runs each `tools/call` inside its own store, and the
 * client sends the request from within it, so the `fetch` that carries it knows which call to
 * tell when its response stream ends early, with nothing added to what the server receives.
 */
const pendingCall = new AsyncLocalStorage<{ interrupted(): void }>();

/**
 * The reason for a reply that is not JSON, or not a JSON-RPC message. Fixed text: a parser's
 * message quotes a cut-down excerpt of what it read, which can hold a piece of a header value no
 * search for the whole value finds, so it is never quoted.
 */
function malformedReason(error: unknown): string | null {
  if (error instanceof SyntaxError) return "The MCP server sent a reply that is not JSON.";
  if (error instanceof Error && error.name === "ZodError") return "The MCP server sent JSON that is not a JSON-RPC message.";
  return null;
}

/** Why a streamable-HTTP connection is gone when nothing more specific is known. */
const CLOSED_REASON = "The MCP server closed the connection.";

/** What a call answers when its own response stream ended before its reply. */
const INTERRUPTED_REASON = "The MCP server's response stream ended before the reply arrived.";

/**
 * A `fetch` that reports a request whose own successful event stream ends, or breaks, without
 * its reply having arrived shortly after: `answered` says whether it did. A `tools/call` tells
 * only the call it belongs to, so the shared connection and its other calls carry on; the
 * handshake's `initialize` fails the connection, which cannot be used without it. Only a POST
 * that carries a request and is answered with an event stream is watched; a JSON reply that
 * breaks already fails its request where the client reads it.
 */
/**
 * Which watched requests have had their reply. Only a request whose own response stream is open is
 * tracked, and its entry goes when that stream ends, so a stale or unsolicited reply, or one for a
 * request id not yet in flight, is never recorded and cannot mark a later request as answered.
 */
function replyTracker() {
  const awaiting = new Set<string | number>();
  const answered = new Set<string | number>();
  return {
    watch(id: string | number): void { awaiting.add(id); answered.delete(id); },
    record(id: string | number): void { if (awaiting.has(id)) answered.add(id); },
    /** Stop tracking `id`, and say whether its reply arrived while it was watched. */
    settle(id: string | number): boolean {
      const replied = answered.has(id);
      awaiting.delete(id);
      answered.delete(id);
      return replied;
    },
  };
}
type ReplyTracker = ReturnType<typeof replyTracker>;

function watchReplyStreams(base: FetchLike, replies: ReplyTracker, handshakeInterrupted: () => void): FetchLike {
  return async (input, init) => {
    const call = pendingCall.getStore();
    const response = await base(input, init);
    const request = requestOf(init?.body);
    const stream = response.ok && (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
    if (request === null || !stream || !response.body) return response;
    const { id, method } = request;
    const source = response.body.getReader();
    // A stream that carried an event id is resumable: the server may close it before replying
    // and the client resumes it from that id (MCP 2025-11-25), so its end is left to the client
    // and the call's own budget. Only a stream with no id fails its call when it ends early.
    // The SDK resumes from the id of an event its parser dispatched: one ended by a blank line,
    // with a data line, whose own `id` is not empty. An id on an event the stream never finished
    // gives it nothing. Lines are read whole across chunks, and each event's fields are tracked.
    const decoder = new TextDecoder();
    let partial = "";
    // The previous chunk ended on a CR: an LF that opens this one completes that CRLF.
    let skipLf = false;
    let resumable = false;
    let eventId: string | undefined;
    let eventHasData = false;
    replies.watch(id);
    const ended = () => setTimeout(() => {
      if (replies.settle(id) || resumable) return;
      if (method === "initialize") handshakeInterrupted();
      else call?.interrupted();
    }, REPLY_SETTLE_MS);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try { read = await source.read(); } catch (error) { ended(); controller.error(error); return; }
        if (read.done) { ended(); controller.close(); return; }
        if (!resumable) {
          let text = partial + decoder.decode(read.value, { stream: true });
          if (skipLf && text.startsWith("\n")) text = text.slice(1);
          skipLf = text.endsWith("\r");
          const lines = text.split(/\r\n|\r|\n/);
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (line === "") {
              if (eventHasData && eventId) resumable = true;
              eventId = undefined;
              eventHasData = false;
              continue;
            }
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? "" : line.slice(line[colon + 1] === " " ? colon + 2 : colon + 1);
            if (field === "data") eventHasData = true;
            else if (field === "id") eventId = value.includes("\u0000") ? undefined : value;
          }
        }
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
function observeReplies<Message>(transport: { onmessage?: (message: Message) => void }, replies: ReplyTracker): void {
  transport.onmessage = (message: Message) => {
    const reply = message as { id?: unknown; method?: unknown } | null;
    if (reply && reply.method === undefined && (typeof reply.id === "string" || typeof reply.id === "number")) replies.record(reply.id);
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

/**
 * How long a shared handshake may take: the longest step there is, not any one call's budget.
 * Every call waits on it only for its own budget (`untilAborted`), so a call that opened the
 * connection with a short budget cannot fail a call with a longer one that joined it, and the
 * run's end closes the client, which stops a handshake still going. No wall clock is read.
 */
function handshakeMs(): number {
  return SHAPING_LIMIT_RANGES.deadlineMs.max;
}

async function openStdio(shaper: ShaperOf<"mcp">, ctx: TransportContext): Promise<Connection> {
  const server = shaper.transport.server;
  if (server.type !== "stdio") throw new Error("not a stdio server");
  const [{ Client: McpClient }, { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS }] = await Promise.all([
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
  // Resolution can wait, and the run can end meanwhile. Its cleanup has already run, so a server
  // started now would have nothing to stop it: none is started.
  if (ctx.scope.closed) {
    void removeScratch(scratch);
    throw new UnavailableError("The shaping run ended before the MCP server could start.");
  }
  // A value the operator named in `env` is a credential the server may echo, as it is for a
  // `command` shaper: removed from replies under its name, and from every diagnostic.
  const credentials = credentialBearingValues(executable.env);
  const named: ResolvedValue[] = [
    ...server.env.filter((name) => !carriedEnvName(name)).flatMap((name) => {
      // The child environment's own string only: an unset `constructor` must not read the
      // inherited function, which scrubbing would then call string methods on.
      const value = Object.hasOwn(executable.env, name) ? executable.env[name] : undefined;
      return typeof value === "string" && value !== "" ? [{ name, value }] : [];
    }),
    ...credentials,
  ];
  const inherited = receivedValues(executable.env, server.env);
  const received: ReceivedValues = {
    values: [...new Set([...inherited.values, ...credentials.map(({ value }) => value)])].sort((a, b) => b.length - a.length),
    named: new Set([...inherited.named, ...credentials.map(({ value }) => value)]),
  };
  const state = latch();
  // The SDK spawns with its own inherited defaults (HOME, LOGNAME, PATH, SHELL, TERM, USER) under
  // the environment it is given. Each one this environment left out is named as undefined, which
  // Node leaves out of the child's, so the server receives exactly the filtered environment that
  // every diagnostic is redacted against.
  const spawnEnv: Record<string, string | undefined> = { ...executable.env };
  for (const name of DEFAULT_INHERITED_ENV_VARS) if (!Object.hasOwn(spawnEnv, name)) spawnEnv[name] = undefined;
  const transport = new StdioClientTransport({
    command: executable.path,
    args: server.args,
    env: spawnEnv as Record<string, string>,
    cwd: scratch,
    stderr: "pipe",
    maxBufferSize: REMOTE_REPLY_BYTES,
  });
  // Kept a value's length beyond the tail it needs, as the `command` transport keeps it: once the
  // front is cut, a value cut there survives only as a piece no search recognises, so that
  // margin is dropped in the original text's positions before anything is recorded.
  let stderr = "";
  let stderrCut = false;
  // Six times the longest value: a JSON `\u` escape spells one character in six, and a value cut
  // at the front in that spelling must fall wholly inside the margin that is dropped.
  const longest = (received.values[0]?.length ?? 0) * 6;
  // Decoded as a stream, as the `command` transport decodes it: a character split across two
  // chunks is kept whole, so a non-ASCII value the child received still matches when redacted.
  const stderrDecoder = new StringDecoder("utf8");
  transport.stderr?.on("data", (chunk: Buffer) => {
    const joined = stderr + stderrDecoder.write(chunk);
    const keep = STDERR_KEEP_CHARS + longest;
    if (joined.length > keep) stderrCut = true;
    stderr = joined.slice(-keep);
  });
  // What the child wrote, scrubbed of everything it received, then of each named value in any
  // spelling (JSON escapes and spacing variants included), and only then collapsed and cut.
  const scrubDiagnostic = (text: string, dropBefore = 0): string => {
    const scrubbed = redactReceived(text, received, dropBefore);
    const named2 = redactResolved(scrubbed, named);
    return redactResolved(redactReceived(named2.replace(/\s+/g, " "), received), named).trim();
  };
  // A passed value with inner whitespace can be spelled with any amount of whitespace there, so
  // no margin bounds where a spelling cut at the front of the buffer ends. Once the buffer is cut,
  // its stderr is then not quoted at all.
  const unsafeCut = () => stderrCut && named.some(({ value }) => /\s/.test(value));
  const tail = (): string => {
    if (unsafeCut()) return ". Its stderr is not quoted: it was too long to scrub safely.";
    const text = scrubDiagnostic(stderr, stderrCut ? longest : 0).slice(-500);
    return text ? `: ${text}` : ".";
  };
  const client = new McpClient(CLIENT_INFO, { capabilities: {} });
  transport.onerror = (error) => {
    if (stdioOverflow(error)) {
      state.fail(capReason());
      // Stopped now, not when the run ends: a server that overflowed stays useless.
      void client.close().catch(() => {});
      return;
    }
    // A line on stdout that is not an MCP message: the stream is no longer one the client can
    // trust, and a call waiting on it would only time out. The parser's message quotes a cut-down
    // excerpt of the line, which can hold a piece of a value no search for the whole value finds,
    // so the reason is fixed text and never quotes the line.
    if (error instanceof SyntaxError) {
      state.fail("The MCP server wrote a line on stdout that is not JSON, so it is not an MCP message.");
      void client.close().catch(() => {});
    } else if (error instanceof Error && error.name === "ZodError") {
      state.fail("The MCP server wrote a JSON line on stdout that is not a JSON-RPC message.");
      void client.close().catch(() => {});
    }
  };
  const stderrNamed = () => holdsResolvedValue(stderr, named) || holdsResolvedValue(stderr.replace(/\s+/g, " "), named);
  transport.onclose = () => state.fail(`The MCP server exited${tail()}`, stderrNamed());
  ctx.scope.defer(async () => {
    try { await client.close(); } finally { await removeScratch(scratch, (text) => redactReceived(text, received)); }
  });
  try {
    // Raced against the latch: an overflow or an exit during the handshake answers at once.
    await Promise.race([client.connect(transport, { timeout: handshakeMs() }), state.lost]);
  } catch (error) {
    if (state.failure) throw new ConnectError(state.failure, state.redacted);
    // The SDK's message can carry what the server wrote, which can repeat anything in its
    // environment, so the whole sentence is scrubbed of every value the child received.
    const said = `The MCP server did not complete its handshake: ${requestFailure(error)}`;
    const marked = holdsResolvedValue(said, named) || stderrNamed();
    throw new ConnectError(`${scrubDiagnostic(said)}${tail()}`, marked);
  }
  return { client, lost: state.lost, get failure() { return state.failure; }, get failureRedacted() { return state.redacted; }, resolved: named };
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
  // The imports can wait, and the run can end meanwhile. Its cleanup has already run, so a
  // handshake started now would send the configured headers for a run nobody is waiting on.
  if (ctx.scope.closed) throw new UnavailableError("The shaping run ended before the MCP server could be reached.");
  const state = latch();
  const url = new URL(server.url);
  // The configured headers ride every request, only to the server's origin; the launch's trace
  // context and work unit id ride every request through `requestInit`, created once for the run.
  // `headers` already holds the carried ones beside the configured; only the configured go here.
  // They are set over the client's own on every request, so any the client owns are left out.
  const configured = withoutOwnedHeaders(withoutCarriedHeaders(headers), MCP_OWNED_HEADERS);
  // A redirect that would resend a request as a GET without its body is refused, not followed.
  const onOrigin = (input: string | URL | Request, init?: RequestInit) =>
    fetchOnOrigin(url.origin, configured, input, { ...init, credentials: "omit" }, undefined, { keepMethod: true });
  const capped = cappedFetch(onOrigin, REMOTE_REPLY_BYTES, (_error: ResponseCapError) => {
    state.fail(capReason());
    void client.close().catch(() => {});
  });
  // A request's reply can arrive on its own response stream. One that ends, or breaks, before
  // the reply came leaves its call waiting for an answer that will never come, while the
  // transport stays open: that call answers at once (`watchReplyStreams`), and only a broken
  // handshake fails the connection.
  const replies = replyTracker();
  const interrupted = () => {
    state.fail(INTERRUPTED_REASON);
    void client.close().catch(() => {});
  };
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: watchReplyStreams(capped, replies, interrupted),
    requestInit: { headers: carriedHeaders(ctx.trace, ctx.workUnitId) },
    // A resumable stream gets two short attempts to resume, within its call's budget; a stream
    // that is not resumable is never retried, and its call answers at once.
    reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 250, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 2 },
  });
  transport.onclose = () => state.fail(CLOSED_REASON);
  // A malformed event on a response stream reaches only `onerror`: the call it carried would wait
  // out its budget. The connection fails with the fixed reason, and the next call reconnects.
  transport.onerror = (error) => {
    const malformed = malformedReason(error);
    if (!malformed) return;
    state.fail(malformed);
    void client.close().catch(() => {});
  };
  observeReplies(transport, replies);
  const client = new McpClient(CLIENT_INFO, { capabilities: {} });
  ctx.scope.defer(async () => {
    if (state.failure === null) {
      await withTimeout(transport.terminateSession().catch(() => {}), END_SESSION_MS, new AbortController().signal);
    }
    await client.close();
  });
  const connecting = client.connect(transport, { timeout: handshakeMs() });
  try {
    await Promise.race([connecting, state.lost]);
  } catch (error) {
    // A failed `initialize` makes the client close its transport before `connect` rejects, so the
    // latch can hold the generic close first. The handshake's own error says why; a specific
    // failure on the latch, an oversized message or a broken stream, says it better.
    if (state.failure && state.failure !== CLOSED_REASON) throw new ConnectError(state.failure, state.redacted);
    const cause = await connecting.then(() => error, (reason: unknown) => reason);
    const malformed = malformedReason(cause);
    if (malformed) throw new ConnectError(`The MCP server did not complete its handshake: ${malformed}`, false);
    // The SDK's message can carry the server's own reply body, which can echo a header value
    // in any spelling: scrubbed the way a tool error is, escapes and spacing included.
    const detail = quoted(requestFailure(cause), resolved);
    throw new ConnectError(`The MCP server did not complete its handshake: ${detail.text}`, detail.redacted);
  }
  return { client, lost: state.lost, get failure() { return state.failure; }, get failureRedacted() { return state.redacted; }, resolved };
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
    const resolution = callHeaders(server.headers, request, ctx, MCP_OWNED_HEADERS);
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
  // Settled when this call's own response stream ends before its reply; cancels the request too.
  const stop = new AbortController();
  let interrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
  interrupted.catch(() => {});
  const marker = new Error(INTERRUPTED_REASON);
  try {
    result = await Promise.race([
      pendingCall.run({ interrupted: () => { interrupt(marker); stop.abort(marker); } }, () => connection.client.callTool(
        { name: tool, arguments: mcpToolArguments(request, contextDelivery), ...(meta ? { _meta: meta } : {}) },
        undefined,
        { signal: AbortSignal.any([signal, stop.signal]), timeout: Math.max(1, ctx.timeoutMs) },
      )),
      connection.lost,
      interrupted,
    ]);
  } catch (error) {
    if (connection.failure) return failure("failed", connection.failure, resolved, connection.failureRedacted);
    if (stop.signal.aborted && !signal.aborted) return failure("failed", INTERRUPTED_REASON, resolved);
    if (signal.aborted || (error as { code?: unknown } | null)?.code === -32001) return timedOut();
    const malformed = malformedReason(error);
    if (malformed) return { kind: "failed", reason: malformed };
    const detail = quoted(requestFailure(error), resolved);
    return failure("failed", `The MCP call failed: ${detail.text}`, resolved, detail.redacted);
  }
  if (connection.failure) return failure("failed", connection.failure, resolved, connection.failureRedacted);
  if (result.isError === true) {
    const detail = quoted(contentText(result.content).join(" "), resolved);
    return failure("failed", `The tool returned an error${detail.text ? `: ${detail.text}` : "."}`, resolved, detail.redacted);
  }
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) return dataReply(structured, resolved);
  const [text] = contentText(result.content);
  return dataReply(text ?? null, resolved);
};
