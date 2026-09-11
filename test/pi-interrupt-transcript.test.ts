// An abort is durable conversation evidence even when Pi produced no visible content.
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piMessages } from "../src/server/harness/pi/transcript.ts";
import { PI_SESSION_LINES } from "./fixtures/pi-sessions.ts";

const capturedAbort = JSON.parse(PI_SESSION_LINES[8]!);
const marker = {
  id: "interrupt:b70e3d09", role: "user", text: "[Request interrupted by user]",
  tools: [], ts: Date.parse(capturedAbort.timestamp),
};

test("Pi's captured empty abort survives initial, streaming, history and bounded reads", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-interrupt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, PI_SESSION_LINES.slice(0, 8).join("\n") + "\n");
  const initial = piMessages.initial(path);
  const offset = piMessages.size(path)!;
  const line = JSON.stringify(capturedAbort);
  appendFileSync(path, line.slice(0, -1));
  assert.deepEqual(piMessages.appended(path, offset).messages, [], "unfinished JSONL is not an interrupt");
  appendFileSync(path, line.slice(-1) + "\n");
  assert.equal(initial.messages.length, 5);
  assert.deepEqual(piMessages.appended(path, offset).messages, [marker]);
  assert.deepEqual(piMessages.since(path, offset).messages, [marker]);
  assert.deepEqual(piMessages.after(path, offset).messages, [marker]);
  assert.deepEqual(piMessages.window(path).messages.at(-1), marker);
  assert.deepEqual(piMessages.initial(path).messages.at(-1), marker);
  assert.deepEqual(piMessages.before(path, piMessages.size(path)!).messages.at(-1), marker);
  const resumed = piMessages.appended(path, offset);
  assert.deepEqual(piMessages.appended(path, resumed.pos).messages, [], "resuming does not replay an abort");
});

test("Pi preserves partial prose and tools before a separate interrupt, and accepts the next turn", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-interrupt-partial-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  const aborted = { ...capturedAbort, message: { ...capturedAbort.message, content: [
    { type: "text", text: "Partial response" },
    { type: "tool_call", name: "bash", arguments: { command: "sleep 10" } },
  ] } };
  const next = { type: "message", id: "next", message: { role: "user", content: "continue" } };
  writeFileSync(path, [aborted, next].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const messages = piMessages.window(path).messages;
  assert.equal(messages.length, 3);
  assert.equal(messages[0]!.role, "assistant");
  assert.equal(messages[0]!.text, "Partial response");
  assert.deepEqual(messages[0]!.tools, [{ name: "bash", input: '{"command":"sleep 10"}' }]);
  assert.deepEqual(messages[1], marker);
  assert.equal(messages[2]!.text, "continue");
});

test("Pi only attributes assistant stopReason aborted to an interruption", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-interrupt-negative-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  const records = [null, {}, { type: "message", message: null },
    ...["stop", "length", "error", "toolUse", "unknown"].map((stopReason) => ({
      ...capturedAbort, message: { ...capturedAbort.message, stopReason },
    })),
    ...["user", "toolResult"].map((role) => ({
      ...capturedAbort, message: { ...capturedAbort.message, role },
    })),
  ];
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.deepEqual(piMessages.window(path).messages, []);
});
