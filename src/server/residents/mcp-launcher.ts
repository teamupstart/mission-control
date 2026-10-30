// The resident MCP scoped launcher, bundled to `dist/satellites/resident-mcp-launcher.mjs`.
//
// A harness starts this as an ordinary stdio MCP server whose arguments name only the run, the
// server and a credential file - never a secret. It:
//
// 1. reads the credential file and removes it, so the ticket is on disk only until now;
// 2. redeems the single-use ticket over the daemon's loopback API for this one server's
//    definition and secret values, and nothing about any other server;
// 3. for a stdio server, starts it from that definition with the secrets in ITS environment
//    only, handing it this process's stdin and stdout; for an HTTP server, acts as a stdio
//    bridge that adds the secret headers and query values itself.
//
// A missing, spent or expired ticket starts nothing. Nothing here logs a ticket, a definition
// or a value. Deliberately standalone: no import reaches the daemon's server graph.

import { spawn } from "node:child_process";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  plaintextCredentialProblem,
  type ResidentMcpCredentialFile,
  type ResidentMcpLauncherDefinition,
} from "../../shared/resident-mcp.ts";

function fail(message: string): never {
  process.stderr.write(`resident-mcp-launcher: ${message}\n`);
  process.exit(1);
}

function argValue(flag: string): string {
  const at = process.argv.indexOf(flag);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (!value) fail(`missing ${flag}`);
  return value;
}

/** Read the credential file once and remove it before anything else can. */
function takeCredential(path: string): ResidentMcpCredentialFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail("the credential file is missing; this server was already started or its ticket expired");
  } finally {
    rmSync(path, { force: true });
  }
  try {
    const parsed = JSON.parse(text) as Partial<ResidentMcpCredentialFile>;
    if (typeof parsed.ticket !== "string" || typeof parsed.expiresAt !== "number" || typeof parsed.redeemUrl !== "string") {
      throw new Error("shape");
    }
    return parsed as ResidentMcpCredentialFile;
  } catch {
    fail("the credential file is unreadable");
  }
}

async function redeem(credential: ResidentMcpCredentialFile, runId: string, server: string): Promise<ResidentMcpLauncherDefinition> {
  if (credential.expiresAt <= Date.now()) fail("the launch ticket expired before this server started");
  const url = new URL(credential.redeemUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") {
    fail("the redemption address is not on this machine");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: credential.ticket, runId, server }),
    });
  } catch {
    fail("Mission Control did not answer the launch ticket");
  }
  const body = (await response.json().catch(() => ({}))) as { definition?: ResidentMcpLauncherDefinition; error?: string };
  if (!response.ok || !body.definition) fail(body.error ?? `the launch ticket was refused (${response.status})`);
  return body.definition;
}

function runStdio(runtime: Extract<ResidentMcpLauncherDefinition, { transport: "stdio" }>): void {
  const child = spawn(runtime.command, runtime.args, {
    cwd: runtime.cwd ?? process.cwd(),
    // The harness's environment for this server, plus this server's own values. The values exist
    // in this process's memory and the child's environment only.
    env: { ...process.env, ...runtime.env },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  // Never the command: a global server's definition is private as a whole, and this stderr
  // reaches the harness's logs.
  child.on("error", () => fail("could not start this server's command"));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

/** Redirects a bridge request may follow before it gives up. */
const MAX_REDIRECTS = 5;

/**
 * Every request the bridge makes, the event stream included, carries the server's headers - and
 * only to the configured origin. Redirects are handled here rather than by `fetch`, which would
 * follow one to another origin with these headers attached: a redirect within the origin is
 * followed with them, and one that leaves it is refused, so no other host ever receives them.
 */
export async function fetchOnOrigin(
  origin: string,
  secretHeaders: Readonly<Record<string, string>>,
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  let target = new URL(input instanceof Request ? input.url : String(input));
  let request: RequestInit = input instanceof Request
    ? { method: input.method, headers: input.headers, body: input.body, signal: input.signal, ...init }
    : { ...init };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (target.origin !== origin) {
      throw new Error("the MCP server redirected to another origin, which never receives its headers");
    }
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(secretHeaders)) headers.set(name, value);
    const response = await fetch(target, { ...request, headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    void response.body?.cancel().catch(() => {});
    target = new URL(location, target);
    // As a browser would: 303, and 301 or 302 after a POST, continue as a GET without a body.
    const method = (request.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const { body: _body, ...rest } = request;
      request = { ...rest, method: "GET" };
    }
  }
  throw new Error("the MCP server redirected too many times");
}

async function runBridge(definition: Extract<ResidentMcpLauncherDefinition, { transport: "http" | "sse" }>): Promise<void> {
  const [{ StdioServerTransport }, { StreamableHTTPClientTransport }, { SSEClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
  ]);
  const url = new URL(definition.url);
  // Never put a credential on the wire unencrypted, whatever the snapshot says.
  if ((Object.keys(definition.headers).length > 0 || url.search) && plaintextCredentialProblem(url)) {
    fail("refusing to send this server's credentials over plain http to another host");
  }
  const withHeaders = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fetchOnOrigin(url.origin, definition.headers, input, init);
  const remote = definition.transport === "sse"
    ? new SSEClientTransport(url, { fetch: withHeaders })
    : new StreamableHTTPClientTransport(url, { fetch: withHeaders });
  const local = new StdioServerTransport();
  const close = (): void => {
    void remote.close().catch(() => {});
    void local.close().catch(() => {});
    process.exit(0);
  };
  local.onclose = close;
  remote.onclose = close;
  remote.onerror = () => {};
  local.onerror = () => {};
  remote.onmessage = (message) => {
    // The negotiated version rides every later request, as an MCP client would send it.
    const result = (message as { result?: { protocolVersion?: unknown } }).result;
    if (typeof result?.protocolVersion === "string" && "setProtocolVersion" in remote) {
      (remote as { setProtocolVersion(version: string): void }).setProtocolVersion(result.protocolVersion);
    }
    void local.send(message).catch(() => {});
  };
  local.onmessage = (message) => {
    void remote.send(message).catch((error: unknown) => {
      // A request the remote never answered must not leave the harness waiting forever.
      const request = message as { id?: string | number; method?: string };
      if (request.id === undefined || request.method === undefined) return;
      void local.send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: `the MCP server did not answer: ${error instanceof Error ? error.message : String(error)}` },
      }).catch(() => {});
    });
  };
  await remote.start();
  await local.start();
}

async function main(): Promise<void> {
  const runId = argValue("--run");
  const server = argValue("--server");
  const credential = takeCredential(argValue("--credential"));
  const definition = await redeem(credential, runId, server);
  if (definition.transport === "stdio") runStdio(definition);
  else await runBridge(definition);
}

// Run as the launcher; imported (by a test, for `fetchOnOrigin`) it starts nothing.
const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === entry) void main().catch(() => fail("the server could not be started"));
