import assert from "node:assert/strict";
import test from "node:test";
import { runStructured } from "../src/server/llm/structured.ts";

// Pins the three return sites `structured.ts`'s own contract comment describes: a genuine
// judgment is durable, but a failure must never be stamped as one - and `cause` is what lets
// a caller (the Goal refiner, in particular) tell which kind of failure it is holding without
// parsing `reason`'s free text.

test("a spawn/timeout/exit failure carries cause: transport", async () => {
  const result = await runStructured(
    async () => {
      throw new Error("claude exited 1: boom");
    },
    "prompt",
    () => null,
    "The test model",
  );
  assert.equal(result.kind, "failed");
  assert.equal(result.cause, "transport");
});

test("an observer stop before an attempt carries cause: cancelled", async () => {
  const result = await runStructured(
    async () => "irrelevant - the observer never lets this run",
    "prompt",
    () => null,
    "The test model",
    { start: () => false, finish: () => {} },
  );
  assert.equal(result.kind, "failed");
  assert.equal(result.cause, "cancelled");
});

test("an unparseable reply, even after the retry, carries cause: parse", async () => {
  const result = await runStructured(
    async () => "not json at all",
    "prompt",
    () => null,
    "The test model",
  );
  assert.equal(result.kind, "failed");
  assert.equal(result.cause, "parse");
});

test("a value that parses on the first attempt never reaches a cause at all", async () => {
  const result = await runStructured(
    async () => '{"ok":true}',
    "prompt",
    (raw) => JSON.parse(raw) as { ok: boolean },
    "The test model",
    undefined,
    { shapeGuaranteed: true },
  );
  assert.deepEqual(result, { kind: "ok", value: { ok: true } });
});
