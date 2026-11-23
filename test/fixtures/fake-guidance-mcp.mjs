// A local MCP server with a `get_guidance` tool and a `route_skills` tool (FR-04), for the `mcp`
// shaping transport's tests. No network beyond loopback, no tokens, no model. `route_skills`
// answers in every mode as `get_guidance` does, except `ok`, where it routes one skill.
//
// Over stdio: `node fake-guidance-mcp.mjs <mode> [args...]`.
// Over streamable HTTP: `startGuidanceHttp({ mode, args, json })` from a test, which listens on
// 127.0.0.1 and records every request's method and headers.
//
// Modes:
//   ok                 FR-02-shaped structured content, one entry named after the repository.
//   text               The same reply as a JSON string in text content, with no structured content.
//   echo [env=NAME..]  One entry whose body is JSON of everything the call saw: its arguments,
//                      `params._meta`, the named environment variables, the trace and work unit
//                      variables, the request headers over HTTP, and the server's pid.
//   degraded           A degraded reply with a note.
//   error              A tool error.
//   slow <ms>          Waits, then answers as `ok`.
//   overflow <bytes>   A text reply this many bytes long, so one message passes the 256 KiB cap.
//   two-messages <bytes> A logging notification this many bytes long, then a valid `ok` reply padded
//                      to the same size: two messages on one response stream, each under the cap
//                      when `bytes` is, together over it.
//   echo-header <name> An entry whose body repeats the request header `name`.
//   error-header <name> A tool error whose text repeats the request header `name`.
//   echo-env <NAME>    An entry whose body repeats the server's environment variable `NAME`.
//   helper <pidfile>   Over stdio only: starts a helper in its own process group that runs until
//                      killed, writes the helper's pid to `pidfile`, then answers as `ok`.
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const structured = (value) => ({ structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] });

function okReply(args) {
  const name = args?.repo?.name ?? "unknown";
  return { version: "v1.4.0", guidance: [{ id: `guide/${name}`, title: "Guide", body: `guidance for ${name}` }] };
}

/** A low-level server, so the tool sees its arguments exactly as sent, with nothing stripped. */
export function createGuidanceServer(mode = "ok", args = []) {
  const server = new Server({ name: "fake-guidance", version: "1.0.0" }, { capabilities: { tools: {}, logging: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ["get_guidance", "route_skills"].map((name) => ({
      name,
      description: name === "get_guidance" ? "Guidance for a task in a repository." : "Skills for a task in a repository.",
      inputSchema: { type: "object", properties: { task: { type: "string" }, repo: { type: "object" }, version: { type: "string" } }, required: ["task", "repo"] },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== "get_guidance" && request.params.name !== "route_skills") {
      return { isError: true, content: [{ type: "text", text: `no tool named ${request.params.name}` }] };
    }
    if (request.params.name === "route_skills" && mode === "ok") {
      return structured({ version: "fr04-1", skills: [{ name: "lint-fix", lifecycle_point: "during", reason_id: "fixture/lint" }] });
    }
    const callArgs = request.params.arguments ?? {};
    const headers = extra.requestInfo?.headers ?? null;
    const header = (name) => {
      const value = headers?.[name.toLowerCase()];
      return Array.isArray(value) ? value.join(", ") : value ?? "<missing>";
    };
    switch (mode) {
      case "ok":
        return structured(okReply(callArgs));
      case "text":
        return { content: [{ type: "text", text: JSON.stringify(okReply(callArgs)) }] };
      case "echo": {
        const named = args.filter((arg) => arg.startsWith("env=")).map((arg) => arg.slice(4));
        const env = Object.fromEntries(["TRACEPARENT", "TRACESTATE", "WORK_UNIT_ID", ...named].map((name) => [name, process.env[name] ?? null]));
        return structured({ guidance: [{ id: "echo", title: "Echo", body: JSON.stringify({
          arguments: callArgs, meta: request.params._meta ?? null, env, envKeys: Object.keys(process.env), headers, pid: process.pid,
        }) }] });
      }
      case "degraded":
        return structured({ degraded: true, notes: ["The guidance index is rebuilding."], guidance: [{ id: "fallback", body: "fallback guidance" }] });
      case "error":
        return { isError: true, content: [{ type: "text", text: "the caller may not read this guidance" }] };
      case "slow":
        await sleep(Number(args[0] ?? 5_000));
        return structured(okReply(callArgs));
      case "two-messages": {
        const bytes = Number(args[0] ?? 200 * 1024);
        // Related to this request, so over streamable HTTP it rides the call's own event stream
        // as an event of its own, ahead of the reply's event.
        await extra.sendNotification({ method: "notifications/message", params: { level: "info", data: "n".repeat(bytes) } });
        const reply = okReply(callArgs);
        return structured({ ...reply, notes: ["p".repeat(Math.min(bytes, 900))], guidance: [{ ...reply.guidance[0], body: "g".repeat(bytes) }] });
      }
      case "overflow":
        return { content: [{ type: "text", text: "x".repeat(Number(args[0] ?? 300 * 1024)) }] };
      case "echo-header":
        return structured({ guidance: [{ id: "echoed", title: "Echoed", body: `the server received ${header(args[0] ?? "x-api-key")}` }] });
      case "error-header":
        return { isError: true, content: [{ type: "text", text: `denied for ${header(args[0] ?? "x-api-key")}` }] };
      case "echo-env":
        return structured({ guidance: [{ id: "env", title: "Env", body: `the server holds ${process.env[args[0] ?? ""] ?? "<unset>"}` }] });
      default:
        return { isError: true, content: [{ type: "text", text: `unknown mode ${mode}` }] };
    }
  });
  return server;
}

/**
 * The server over streamable HTTP on loopback, stateless: every POST gets a fresh server and
 * transport. `json` answers with JSON bodies, otherwise with an event stream. Every request's
 * method and headers are recorded in `requests`, so a test can check what each one carried.
 */
export async function startGuidanceHttp({ mode = "ok", args = [], json = true } = {}) {
  const requests = [];
  const http = createServer(async (req, res) => {
    requests.push({ method: req.method, headers: { ...req.headers } });
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const server = createGuidanceServer(mode, args);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: json });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const { port } = http.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise((done) => { http.closeAllConnections(); http.close(() => done()); }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let [mode = "ok", ...args] = process.argv.slice(2);
  if (mode === "helper") {
    // A helper with stdio of its own, so nothing but its process group ties it to the server.
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(`${args[0]}.partial`, String(helper.pid));
    renameSync(`${args[0]}.partial`, args[0]);
    helper.unref();
    [mode, args] = ["ok", []];
  }
  const server = createGuidanceServer(mode, args);
  await server.connect(new StdioServerTransport());
  process.stdin.on("end", () => process.exit(0));
}
