// A bare stdio MCP server for the handshake cases the SDK's own server cannot produce. Run as
// `node raw-stdio-mcp.mjs <mode> [args...]`. No network, no tokens.
//
// Modes:
//   overflow-init <bytes> <pidfile>  Writes its pid, ignores SIGTERM, and answers `initialize` with one
//                                    message this many bytes long, then stays running.
//   error-init <NAME>                Answers `initialize` with an error that repeats the environment
//                                    variable `NAME`, then stays running until stdin ends.
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

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method !== "initialize") continue;
  if (mode === "overflow-init") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion, capabilities: {},
      serverInfo: { name: "x".repeat(Number(args[0] ?? 300 * 1024)), version: "1.0.0" },
    } });
  } else if (mode === "error-init") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `denied for ${process.env[args[0] ?? ""] ?? "<unset>"}` } });
  }
}
