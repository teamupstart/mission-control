// Used only by the fixture provider binaries inside the executor's disposable provider cwd.
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const tools = ["read", "search", "glob", "git_status", "git_diff", "git_show", "git_log", "git_blame"];
async function review(mcp, prompt) {
  // The browser changes the live checkout after the capture event, then releases this fixture.
  const release = new URL("../repository-review-ready", import.meta.url);
  const expires = Date.now() + 30_000;
  while (!existsSync(release)) {
    if (Date.now() >= expires) throw Error("Timed out waiting for the fixture checkout change");
    await delay(25);
  }
  const args = prompt.includes("E2E_REPOSITORY_MCP_FAILURE")
    ? mcp.args.map(arg => arg.startsWith("REPOSITORY_MCP_DESCRIPTOR=") ? "REPOSITORY_MCP_DESCRIPTOR=/missing-fixture-descriptor" : arg)
    : mcp.args;
  const child = spawn(mcp.command, args, { env: mcp.env, stdio: ["pipe", "pipe", "inherit"] });
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  async function request(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
    for (;;) {
      const line = await lines.next();
      if (line.done) throw Error("Repository MCP closed before answering");
      const reply = JSON.parse(line.value);
      if (reply.id === id) {
        if (reply.error) throw Error("Repository MCP refused fixture request");
        return reply.result;
      }
    }
  }
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const call = async (name, args) => JSON.parse((await request("tools/call", { name, arguments: args })).content[0].text);
    if (prompt.includes("E2E_QUERY_SNAPSHOTS")) {
      const read = await call("read", { path: "submitted.txt", length: 2 });
      const evidence = [{ kind: "repository", operationId: read.operationId, evidenceHandleId: read.items[0].evidenceHandleId }];
      if (read.items[0].text === "submitted working line") return { result: { kind: "persona_verdict", verdict: {
        verdict: "fail", summary: "Replace the placeholder", confidence: 1, requestedChanges: [{
          basis: "substantive", path: "submitted.txt", line: 1, category: null, title: "Replace the placeholder",
          rationale: "The submitted file still contains the placeholder.", evidence,
        }],
      } } };
      if (read.items[0].text !== "later checkout") throw Error("Unexpected resubmitted checkout");
      return { result: { kind: "persona_verdict", verdict: { verdict: "pass", summary: "Placeholder replaced",
        confidence: 1, approvalDetails: { reason: "Verified the replacement line.", evidence } } } };
    }
    await call("read", { path: ".env" });
    const read = await call("read", { path: "submitted.txt" });
    const bytes = await call("read", { path: "submitted.txt", unit: "byte", length: 3 });
    const diff = await call("git_diff", { paths: ["submitted.txt"], pair: "index_worktree" });
    const staged = await call("read", { path: "submitted.txt", layer: "index" });
    const untracked = await call("read", { path: "untracked.txt" });
    const head = await call("git_diff", { paths: ["submitted.txt"], pair: "head_index" });
    await call("git_log", { revision: "a".repeat(40) });
    if (read.items[0]?.text !== "submitted working line" || staged.items[0]?.text !== "staged line"
      || untracked.items[0]?.text !== "untracked line" || !head.items[0]?.text.includes("-committed line")) {
      throw Error("Repository MCP did not return the submitted layers");
    }
    if (prompt.includes("E2E_HISTORY_LIMIT")) {
      const boundary = await call("git_show", { revision: /FRONTIER=([a-f0-9]{40})/.exec(prompt)[1], patch: true });
      const omitted = await call("git_show", { revision: /OMITTED=([a-f0-9]{40})/.exec(prompt)[1] });
      if (boundary.code !== "history_boundary" || omitted.code !== "revision_out_of_range" || omitted.items.length) {
        throw Error("Repository history boundary was not enforced");
      }
    }
    const evidence = [read, bytes, diff].map(result => ({
      kind: "repository", operationId: result.operationId, evidenceHandleId: result.items[0].evidenceHandleId,
    }));
    if (prompt.includes("E2E_INVALID_REPOSITORY_CITATION")) evidence[0].evidenceHandleId = "6f550ec8-0964-4adb-88fd-218790637fd3";
    if (prompt.includes("E2E_REVIEW_CORRECTION") && !prompt.includes("Correction required:")) {
      return { result: { kind: "persona_verdict", verdict: { verdict: "fail", summary: "Coverage registration objection",
        confidence: 1, requestedChanges: [{ basis: "coverage_registration", path: null, line: null, category: null, title: "Register evidence",
          rationale: "Fixture registration objection", evidence }] } } };
    }
    return { result: { kind: "persona_verdict", verdict: {
      verdict: "pass", summary: "Reviewed the submitted checkout", confidence: 1,
      approvalDetails: { reason: "The reviewer inspected the working file and its staged difference.", evidence },
    } } };
  } finally {
    child.stdin.end();
    await closed;
  }
}
export async function runFakeRepositoryReview(provider, argv) {
  if (argv.includes("--version")) {
    process.stdout.write(provider === "codex" ? "codex-cli 0.166.0\n" : "2.1.319 (Claude Code)\n");
    return;
  }
  if (provider === "codex") {
    if (argv.includes("list")) { emit([{ name: "repository", enabled: true }]); return; }
    const config = argv.find(arg => arg.startsWith("mcp_servers.repository.args="));
    if (!config) throw Error("Missing Codex repository arguments");
    const args = JSON.parse(config.slice(config.indexOf("=") + 1));
    let prompt = "";
    for await (const chunk of process.stdin) prompt += chunk;
    const answer = await review({ command: "/usr/bin/env", args, env: {} }, prompt);
    emit({ type: "thread.started", thread_id: "fixture" });
    emit({ type: "item.completed", item: { id: "reply", type: "agent_message", text: JSON.stringify(answer) } });
    emit({ type: "turn.completed", usage: { input_tokens: 12, output_tokens: 5, cached_input_tokens: 0 } });
    return;
  }
  const config = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]);
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    if (frame.type === "control_request") {
      emit({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: {} } });
    } else if (frame.type === "user") {
      emit({ type: "system", subtype: "init", session_id: "fixture", tools: tools.map(t => "mcp__repository__" + t),
        mcp_servers: [{ name: "repository", status: "connected" }] });
      if (JSON.stringify(frame).includes("E2E_REPOSITORY_QUOTA")) {
        emit({ type: "result", subtype: "error_during_execution", session_id: "fixture", is_error: true,
          terminal_reason: "budget_exhausted", errors: ["usage limit reached"] });
        return;
      }
      const answer = await review(config.mcpServers.repository, JSON.stringify(frame));
      emit({ type: "result", subtype: "success", session_id: "fixture", is_error: false, result: JSON.stringify(answer),
        structured_output: answer, usage: { input_tokens: 12, output_tokens: 5 }, total_cost_usd: 0 });
      return;
    }
  }
}
