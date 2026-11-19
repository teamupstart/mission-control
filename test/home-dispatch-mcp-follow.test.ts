// F1: the dispatch tools follow the flag safely when the startup read and the stream disagree.
import assert from "node:assert/strict";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHomeDispatchTools } from "../src/mcp/home-dispatch/index.ts";
import { HOME_DISPATCH_CAPABILITY } from "../src/shared/home-dispatch.ts";
import { eventually } from "./helpers/home-dispatch-fakes.ts";

const on = { overrides: { "headless-mode": true }, enableAll: false };
const off = { overrides: {}, enableAll: false };
const frame = (type: "snapshot" | "feature_flags", config: unknown) =>
  "data: " + JSON.stringify(type === "snapshot" ? { type, featureFlags: config } : { type, config }) + "\n\n";

/** A controllable SSE response: push frames, then end it as a dropped connection would. */
function controllableStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

function tools(options: Parameters<typeof registerHomeDispatchTools>[2]) {
  const server = new McpServer({ name: "t", version: "1" });
  return registerHomeDispatchTools(server, async () => new Response("{}"), { env: {}, ...options });
}

test("F1 MCP follow: a delayed startup health read that says on cannot override a newer off event", async () => {
  const stream = controllableStream();
  let releaseHealth!: (body: unknown) => void;
  const health = new Promise<unknown>((resolve) => { releaseHealth = resolve; });
  const t = tools({ readHealth: () => health, openEvents: async () => stream.response });
  try {
    const refreshed = t.refresh(); // started first, answers last
    t.follow();
    stream.push(frame("snapshot", off));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.isEnabled(), false);
    releaseHealth({ capabilities: [HOME_DISPATCH_CAPABILITY] }); // the stale answer: flag was on when asked
    assert.equal(await refreshed, false, "the stale read reports the live state, not its own");
    assert.equal(t.isEnabled(), false, "the tools stay off");
  } finally {
    t.stop();
  }
});

test("F1 MCP follow: the startup health read still decides when the stream has said nothing", async () => {
  const t = tools({ readHealth: async () => ({ capabilities: [HOME_DISPATCH_CAPABILITY] }) });
  assert.equal(await t.refresh(), true);
  assert.equal(t.isEnabled(), true);
  t.stop();
});

test("F1 MCP follow: losing the stream fails closed, and a reconnect snapshot restores the tools", async () => {
  const first = controllableStream();
  const second = controllableStream();
  let opens = 0;
  let daemonUp = true;
  const t = tools({
    openEvents: async () => {
      opens++;
      if (opens === 1) return first.response;
      if (!daemonUp) throw new Error("connect ECONNREFUSED");
      return second.response;
    },
  });
  try {
    t.follow();
    first.push(frame("snapshot", on));
    await eventually(() => t.isEnabled() || false);
    // The daemon goes away: stream cut, and every reconnect fails. The flag cannot be known.
    daemonUp = false;
    first.end();
    await eventually(() => !t.isEnabled() || false);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(t.isEnabled(), false, "still closed through failed reconnect attempts");
    // The daemon returns with the flag on: the reconnect snapshot restores the tools.
    daemonUp = true;
    await eventually(async () => (opens >= 3 ? true : false), 10_000);
    second.push(frame("snapshot", on));
    await eventually(() => t.isEnabled() || false, 10_000);
    second.push(frame("feature_flags", off));
    await eventually(() => !t.isEnabled() || false);
  } finally {
    t.stop();
  }
});
