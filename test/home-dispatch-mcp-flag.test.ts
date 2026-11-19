// F1: the MCP server publishes the dispatch tools only while the daemon lists home-dispatch-v1.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { HOME_DISPATCH_MCP_TOOLS } from "../src/shared/home-dispatch-tools.ts";
import { connectFakeFormsClient, eventually, startFakeDaemon } from "./helpers/home-dispatch-fakes.ts";

const home = mkdtempSync(join(tmpdir(), "mission-home-dispatch-mcp-"));
after(() => rmSync(home, { recursive: true, force: true }));

test("F1 MCP flag off: the tool list has no dispatch tools", async () => {
  const daemon = await startFakeDaemon({ flag: false });
  const session = await connectFakeFormsClient({ daemonPort: daemon.port, forms: true, home });
  try {
    await eventually(() => daemon.requests.some((r) => r.path === "/api/health") || false);
    const tools = await session.listTools();
    assert.ok(tools.length > 0);
    for (const name of HOME_DISPATCH_MCP_TOOLS) assert.ok(!tools.includes(name), name);
  } finally {
    await session.close();
    await daemon.close();
  }
});

const hasAll = (list: string[]) => HOME_DISPATCH_MCP_TOOLS.every((n) => list.includes(n));
const hasNone = (list: string[]) => HOME_DISPATCH_MCP_TOOLS.every((n) => !list.includes(n));

test("F1 MCP flag on: all six dispatch tools appear beside the existing ones", async () => {
  const daemon = await startFakeDaemon({ flag: true });
  const session = await connectFakeFormsClient({ daemonPort: daemon.port, forms: true, home });
  try {
    const tools = await eventually(async () => {
      const list = await session.listTools();
      return hasAll(list) ? list : false;
    });
    assert.ok(tools.includes("create_task"), "the existing tools are still there");
  } finally {
    await session.close();
    await daemon.close();
  }
});

test("F1 MCP live: turning the flag off removes the tools from an open session, and on brings them back", async () => {
  const daemon = await startFakeDaemon({ flag: false });
  const session = await connectFakeFormsClient({ daemonPort: daemon.port, forms: true, home });
  let changed = 0;
  session.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
  try {
    assert.ok(hasNone(await session.listTools()), "off at start");
    daemon.setFlag(true);
    await eventually(async () => (hasAll(await session.listTools()) ? true : false));
    daemon.setFlag(false);
    await eventually(async () => (hasNone(await session.listTools()) ? true : false));
    const afterOff = await session.client.callTool({ name: "read_inbox", arguments: {} }).catch((e: unknown) => e);
    assert.ok(afterOff instanceof Error || (afterOff as { isError?: boolean }).isError === true, "a disabled tool cannot be called");
    daemon.setFlag(true);
    await eventually(async () => (hasAll(await session.listTools()) ? true : false));
    assert.ok(changed >= 3, "each change sends tools/list_changed: " + changed);
  } finally {
    await session.close();
    await daemon.close();
  }
});

test("F1 MCP reconnect: a stream cut while the flag changes is settled by the reconnect snapshot", async () => {
  const daemon = await startFakeDaemon({ flag: true });
  const session = await connectFakeFormsClient({ daemonPort: daemon.port, forms: true, home });
  try {
    await eventually(async () => (hasAll(await session.listTools()) ? true : false));
    // The stream is cut and the flag turns off while nothing is listening: no event can carry it.
    daemon.dropStreams();
    daemon.setFlag(false);
    await eventually(async () => (hasNone(await session.listTools()) ? true : false), 10_000);
    // And the other way: cut again, flag back on, the next snapshot restores the tools.
    daemon.dropStreams();
    daemon.setFlag(true);
    await eventually(async () => (hasAll(await session.listTools()) ? true : false), 10_000);
  } finally {
    await session.close();
    await daemon.close();
  }
});

test("F1 MCP stubs: each of the six tools takes its own valid input and answers its not-implemented stub", async () => {
  const daemon = await startFakeDaemon({ flag: true });
  const session = await connectFakeFormsClient({ daemonPort: daemon.port, forms: true, home });
  try {
    await eventually(async () => (hasAll(await session.listTools()) ? true : false));
    const valid: Record<string, Record<string, unknown>> = {
      start_dispatch: { entry: "conversation", brief: "add retries", kind: "ship", intent: "backlog", context: "c", repo: "r" },
      submit_brief: { draftId: "d1", words: "w", context: "c", repo: "r" },
      checkin: {},
      read_inbox: {},
      answer_task: { action: "approve_plan", reviewId: "r1", revisionHash: "abc123" },
      read_dispatch_options: { kind: "plan", brief: "b", entry: "command" },
    };
    assert.deepEqual(Object.keys(valid).sort(), [...HOME_DISPATCH_MCP_TOOLS].sort());
    for (const [name, args] of Object.entries(valid)) {
      const result = await session.client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.deepEqual(result.structuredContent, { outcome: "not-implemented" }, name);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      assert.match(text, new RegExp(`^${name} is not implemented yet`), name);
    }
    for (const args of [
      { action: "request_changes", reviewId: "r1", text: "Needs revision" },
      { action: "answer", reviewId: "r1", option: "Keep" },
      { action: "answer", reviewId: "r1", text: "free text" },
      { action: "approve_review", reviewId: "r1" },
      { action: "reject_review", reviewId: "r1", text: "no" },
    ]) {
      const ok = await session.client.callTool({ name: "answer_task", arguments: args });
      assert.deepEqual(ok.structuredContent, { outcome: "not-implemented" }, JSON.stringify(args));
    }
    assert.equal(session.shown.length, 0, "a stub shows no form");
  } finally {
    await session.close();
    await daemon.close();
  }
});

test("F1 MCP input schemas: each tool refuses input its own schema forbids, before any handler runs", async () => {
  const daemon = await startFakeDaemon({ flag: true });
  const session = await connectFakeFormsClient({ daemonPort: daemon.port, forms: true, home });
  try {
    await eventually(async () => (hasAll(await session.listTools()) ? true : false));
    const invalid: Array<[string, Record<string, unknown>]> = [
      ["start_dispatch", { kind: "pipeline" }],
      ["start_dispatch", { entry: "everywhere" }],
      ["start_dispatch", { intent: "later" }],
      ["submit_brief", {}],
      ["submit_brief", { draftId: "" }],
      ["answer_task", { action: "approve_plan" }],
      ["answer_task", { action: "bogus", reviewId: "r1" }],
      ["answer_task", { action: "answer", reviewId: "" }],
      // Fields one action needs and another does not: the route contract, enforced by the tool.
      ["answer_task", { action: "approve_plan", reviewId: "r1" }],
      ["answer_task", { action: "approve_plan", reviewId: "r1", revisionHash: "" }],
      ["answer_task", { action: "request_changes", reviewId: "r1" }],
      ["answer_task", { action: "request_changes", reviewId: "r1", text: "" }],
      ["answer_task", { action: "answer", reviewId: "r1" }],
      ["read_dispatch_options", { entry: "nowhere" }],
      ["read_dispatch_options", { kind: "resident" }],
    ];
    for (const [name, args] of invalid) {
      const outcome = await session.client.callTool({ name, arguments: args }).catch((e: unknown) => e);
      const text = outcome instanceof Error
        ? outcome.message
        : (outcome as { isError?: boolean; content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");
      if (!(outcome instanceof Error)) assert.equal((outcome as { isError?: boolean }).isError, true, name);
      assert.doesNotMatch(text, /is not implemented yet/, `${name} ${JSON.stringify(args)} reached the handler`);
      assert.match(text, /invalid|validation|required|expected/i, `${name} ${JSON.stringify(args)}`);
    }
  } finally {
    await session.close();
    await daemon.close();
  }
});

test("F1 MCP worker: a Mission Control worker never publishes the dispatch tools, even with the flag on", async () => {
  const daemon = await startFakeDaemon({ flag: true });
  const session = await connectFakeFormsClient({ daemonPort: daemon.port, forms: true, home, env: { MISSION_SESSION_ID: "worker-1" } });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const tools = await session.listTools();
    for (const name of HOME_DISPATCH_MCP_TOOLS) assert.ok(!tools.includes(name), name);
  } finally {
    await session.close();
    await daemon.close();
  }
});

test("F1 MCP daemon down: the server still starts and lists its tools without the dispatch tools", async () => {
  const daemon = await startFakeDaemon({ flag: true });
  const port = daemon.port;
  await daemon.close();
  const session = await connectFakeFormsClient({ daemonPort: port, forms: false, home });
  try {
    const tools = await session.listTools();
    assert.ok(tools.includes("create_task"));
    for (const name of HOME_DISPATCH_MCP_TOOLS) assert.ok(!tools.includes(name), name);
  } finally {
    await session.close();
  }
});
