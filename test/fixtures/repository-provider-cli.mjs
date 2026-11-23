#!/usr/bin/env node
// Stand in for the executable across the version probe, Codex MCP list and Claude SDK stream.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const fixture = JSON.parse(readFileSync("capabilities.json", "utf8"));
const record = (step) => appendFileSync("launches.log", step + "\n");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  record("version");
  console.log(fixture.version);
} else if (args.slice(0, 3).join(" ") === "mcp list --json") {
  record("mcp list");
  console.log(JSON.stringify(fixture.servers));
} else {
  record("session");
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    if (frame.type === "control_request") {
      console.log(JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: frame.request_id, response: {} },
      }));
    } else if (frame.type === "user") {
      record("init");
      console.log(JSON.stringify({
        type: "system", subtype: "init", tools: fixture.tools,
        mcp_servers: [{ name: "repository", status: "connected" }],
      }));
      // A provider offering a verdict cannot rescue a mismatched inventory.
      console.log(JSON.stringify({
        type: "result", subtype: "success", is_error: false,
        structured_output: { result: { kind: "persona_verdict", verdict: fixture.verdict } },
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0,
      }));
      break;
    }
  }
}
