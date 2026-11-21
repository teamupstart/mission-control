// A bare stdio MCP server for the handshake cases the SDK's own server cannot produce. Run as
// `node raw-stdio-mcp.mjs <mode> [args...]`. No network, no tokens.
//
// Modes:
//   overflow-init <bytes> <pidfile>  Writes its pid, ignores SIGTERM, and answers `initialize` with one
//                                    message this many bytes long, then stays running.
//   error-init <NAME>                Answers `initialize` with an error that repeats the environment
//                                    variable `NAME`, then stays running until stdin ends.
//   stderr-exit <NAME> <lines>       Writes the variable `NAME` and then that many newlines to stderr,
//                                    and exits before answering anything.
//   json-stderr-exit <NAME>          Writes a JSON diagnostic that holds `NAME`'s value, every
//                                    character a \u escape, to stderr, and exits.
//   split-utf8-exit <NAME>           Writes `NAME`'s value to stderr in two chunks split inside its first
//                                    multibyte character, and exits before answering anything.
//   garbage-reply                    Answers `initialize`, then answers the next request with a line
//                                    that is not JSON, and stays running.
import { renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [mode = "error-init", ...args] = process.argv.slice(2);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (mode === "overflow-init" && args[1]) {
  writeFileSync(`${args[1]}.partial`, String(process.pid));
  renameSync(`${args[1]}.partial`, args[1]);
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

if (mode === "json-stderr-exit") {
  const escaped = [...(process.env[args[0] ?? ""] ?? "")].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  process.stderr.write(`{"level":"error","msg":"auth failed for ${escaped}"}\n`, () => process.exit(1));
}

if (mode === "split-utf8-exit") {
  const bytes = Buffer.from(`auth failed for ${process.env[args[0] ?? ""] ?? ""}\n`, "utf8");
  // Inside the first multibyte character: after its lead byte, before its continuation.
  const at = bytes.findIndex((byte) => byte >= 0xc0) + 1;
  process.stderr.write(bytes.subarray(0, at), () => {
    setTimeout(() => process.stderr.write(bytes.subarray(at), () => process.exit(1)), 100);
  });
}

if (mode === "stderr-exit") {
  process.stderr.write(`${process.env[args[0] ?? ""] ?? ""}${"\n".repeat(Number(args[1] ?? 0))}`, () => process.exit(1));
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method !== "initialize" && mode !== "garbage-reply") continue;
  if (mode === "garbage-reply") {
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "garbage", version: "1.0.0" } } });
    } else if (message.id !== undefined) {
      process.stdout.write(`this is not json for request ${message.id}\n`);
    }
    continue;
  }
  if (mode === "overflow-init") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion, capabilities: {},
      serverInfo: { name: "x".repeat(Number(args[0] ?? 300 * 1024)), version: "1.0.0" },
    } });
  } else if (mode === "error-init") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `denied for ${process.env[args[0] ?? ""] ?? "<unset>"}` } });
  }
}
