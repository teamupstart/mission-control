import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HOME_DISPATCH_CAPABILITY } from "../../src/shared/home-dispatch.ts";

/**
 * Fakes for headless mode (FR-05), shared by the hook, CLI and MCP tests (spec 8.1 rule 1).
 * Tests never touch a real daemon, `~/.claude` or `~/.mission-control`, and spend no model
 * tokens (spec 3 rules 11 and 12).
 */

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface FakeDaemon {
  readonly port: number;
  readonly requests: RecordedRequest[];
  /** What `/api/feature-flags` and `/api/health` report from now on. */
  setFlag(on: boolean): void;
  /** End every open event stream, as a daemon restart or a dropped connection would. */
  dropStreams(): void;
  /** Script an answer for `METHOD /path`. Unscripted routes answer 404. */
  route(key: string, status: number, body?: unknown): void;
  close(): Promise<void>;
}

/**
 * A fake daemon for hook and CLI tests: `/api/health` lists `home-dispatch-v1` only while the
 * flag is on, `/api/feature-flags` answers with the config shape the real route does, and
 * every request is recorded.
 */
export async function startFakeDaemon(options: { flag?: boolean } = {}): Promise<FakeDaemon> {
  let flag = options.flag ?? false;
  const streams = new Set<import("node:http").ServerResponse>();
  const flagConfig = () => ({ enableAll: false, overrides: flag ? { "headless-mode": true } : {} });
  const requests: RecordedRequest[] = [];
  const scripted = new Map<string, { status: number; body: unknown }>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0]!;
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text === "" ? null : text;
      try { if (text) body = JSON.parse(text); } catch { /* keep the raw text */ }
      requests.push({ method: req.method ?? "GET", path, headers: req.headers, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const key = `${req.method} ${path}`;
      if (key === "GET /events") {
        // The real daemon only needs a loopback Host here, but the client sends its token like
        // every other call; refusing a tokenless stream keeps that from regressing unnoticed.
        if (!req.headers["x-harness-token"]) return send(401, { error: "unauthorized" });
        // The daemon's event stream: a snapshot with the flag config, then `feature_flags` events.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "snapshot", featureFlags: flagConfig() })}\n\n`);
        streams.add(res);
        res.on("close", () => streams.delete(res));
        return;
      }
      const hit = scripted.get(key);
      if (hit) return send(hit.status, hit.body);
      if (key === "GET /api/health") {
        return send(200, { ok: true, service: "mission-control", capabilities: flag ? [HOME_DISPATCH_CAPABILITY] : [] });
      }
      if (key === "GET /api/feature-flags") {
        return send(200, { config: flagConfig() });
      }
      return send(404, { error: "not scripted" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    setFlag: (on) => {
      flag = on;
      for (const res of streams) res.write(`data: ${JSON.stringify({ type: "feature_flags", config: flagConfig() })}\n\n`);
    },
    dropStreams: () => { for (const res of streams) { streams.delete(res); res.end(); } },
    route: (key, status, body = {}) => { scripted.set(key, { status, body }); },
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

/** One form the server asked this fake client to show. */
export interface ShownForm {
  message: string;
  requestedSchema: unknown;
}

export type FormAnswer = { action: "accept"; content: Record<string, string | boolean | number> } | { action: "decline" } | { action: "cancel" };

export interface FakeFormsClient {
  readonly client: Client;
  readonly shown: ShownForm[];
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * A fake MCP client for the dispatch tools. With `forms: true` it declares
 * `elicitation: { form: {} }` and answers each form from `answer`; with `forms: false` it
 * declares nothing, which is the fallback path. It spawns the real `src/mcp/server.ts` against
 * a fake daemon, so a `tools/list` here is what a Claude Code session would see.
 */
export async function connectFakeFormsClient(options: {
  daemonPort: number;
  forms?: boolean;
  answer?: (form: ShownForm) => FormAnswer;
  env?: Record<string, string>;
  home: string;
}): Promise<FakeFormsClient> {
  const shown: ShownForm[] = [];
  const client = new Client(
    { name: "home-dispatch-fake-client", version: "1" },
    { capabilities: options.forms ? { elicitation: { form: {} } } : {} },
  );
  if (options.forms) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const form: ShownForm = { message: request.params.message, requestedSchema: (request.params as { requestedSchema?: unknown }).requestedSchema };
      shown.push(form);
      return (options.answer?.(form) ?? { action: "cancel" }) as never;
    });
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("../../src/mcp/server.ts", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: options.home,
      MISSION_HOME: options.home,
      MISSION_PORT: String(options.daemonPort),
      MISSION_API_TOKEN: "fake-token",
      ...options.env,
    },
    stderr: "ignore",
  });
  await client.connect(transport);
  return {
    client,
    shown,
    listTools: async () => (await client.listTools()).tools.map((t) => t.name),
    close: () => client.close(),
  };
}

/** Poll until `check` holds, for notifications that arrive after a call returns. */
export async function eventually<T>(check: () => Promise<T | false> | T | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== false) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}
