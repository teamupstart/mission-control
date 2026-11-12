import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { nullAsAbsent } from "../src/server/llm/json-schema.ts";
import { ModelReplyMiss, parseModelReply, runStructured } from "../src/server/llm/structured.ts";

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

// The retry must say what was actually wrong: valid JSON that missed the schema is not
// "not valid JSON", and the reply's own content is never echoed back.
const Shape = z.object({ verdict: z.enum(["pass", "fail"]), path: z.string().optional() });

async function retryPromptFor(reply: string): Promise<{ retry: string; reason: string }> {
  const prompts: string[] = [];
  const result = await runStructured(
    async (p) => {
      prompts.push(p);
      return reply;
    },
    "prompt",
    (raw) => parseModelReply(raw, Shape),
    "The test model",
  );
  assert.equal(prompts.length, 2);
  assert.equal(result.kind, "failed");
  return { retry: prompts[1]!, reason: result.kind === "failed" ? result.reason : "" };
}

test("a schema miss retries with its field paths, not a false JSON complaint", async () => {
  const { retry, reason } = await retryPromptFor(JSON.stringify({ verdict: "maybe-LEAK", path: null }));
  assert.ok(!retry.includes("not valid JSON"));
  assert.match(retry, /valid JSON but did not match the required shape/);
  assert.match(retry, /- verdict: Expected one of "pass" \| "fail"/);
  assert.match(retry, /- path: Expected string, received null/);
  assert.match(retry, /Omit an optional field you have no value for instead of sending null/);
  assert.ok(!retry.includes("LEAK"));
  assert.match(reason, /verdict: Expected one of/);
});

test("the JSON complaint is kept for a reply that really is not JSON", async () => {
  const { retry, reason } = await retryPromptFor("I think this passes.");
  assert.match(retry, /Your previous reply was not valid JSON/);
  assert.equal(reason, "The test model could not parse a valid reply from the model.");
});

test("a schema miss reports at most three clipped issues", () => {
  const Wide = z.object(Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`field${i}`, z.string().refine(() => false, "x".repeat(500))]),
  ));
  const miss = parseModelReply(JSON.stringify(Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => [`field${i}`, "v"]),
  )), Wide);
  assert.ok(miss instanceof ModelReplyMiss);
  assert.equal(miss.issues.length, 3);
  assert.ok(miss.issues.every((issue) => issue.length < 250));
});

test("null reads as absent through nullAsAbsent, as it reads an omitted key", () => {
  const Optional = z.object({ path: nullAsAbsent(z.string().optional()) });
  for (const raw of ['{"path":null}', "{}"]) {
    assert.equal((parseModelReply(raw, Optional) as { path?: string }).path, undefined);
  }
  assert.deepEqual(parseModelReply('{"path":"a"}', Optional), { path: "a" });
});
