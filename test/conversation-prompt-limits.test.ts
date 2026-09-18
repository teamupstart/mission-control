import assert from "node:assert/strict";
import test from "node:test";

import {
  AddWorkItemSchema,
  CONVERSATION_TEXT_MAX_LENGTH,
  InjectPromptSchema,
} from "../src/shared/protocol.ts";

test("conversation paste accepts 100,000 characters and refuses one more", () => {
  assert.equal(CONVERSATION_TEXT_MAX_LENGTH, 100_000);
  assert.equal(
    InjectPromptSchema.safeParse({ text: "x".repeat(CONVERSATION_TEXT_MAX_LENGTH) }).success,
    true,
  );
  assert.equal(
    InjectPromptSchema.safeParse({ text: "x".repeat(CONVERSATION_TEXT_MAX_LENGTH + 1) }).success,
    false,
  );
});

test("raising the conversation paste limit does not widen queued work-item intents", () => {
  assert.equal(AddWorkItemSchema.safeParse({ intent: "x".repeat(8_000) }).success, true);
  assert.equal(AddWorkItemSchema.safeParse({ intent: "x".repeat(8_001) }).success, false);
});
