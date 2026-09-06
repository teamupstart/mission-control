import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  armProductIssueAuthorization,
  clearProductIssueAuthorizations,
  serveProductIssueAuthorization,
} from "../src/main/product-issue-authorization.ts";
import type { ProductIssueAuthorizationReply } from "../src/server/product-issue-authorization.ts";

interface FakeChild extends EventEmitter {
  replies: ProductIssueAuthorizationReply[];
  postMessage(message: unknown): void;
}

function child(): FakeChild {
  const result = new EventEmitter() as FakeChild;
  result.replies = [];
  result.postMessage = (message: unknown): void => {
    result.replies.push(message as ProductIssueAuthorizationReply);
  };
  return result;
}

const INPUT = {
  requestId: "11111111-2222-4333-8444-555555555555",
  draftIdentity: "a".repeat(64),
};

function ask(target: FakeChild, overrides: Record<string, unknown> = {}): void {
  target.emit("message", {
    type: "mission:product-issue-authorization",
    id: "question-1",
    ...INPUT,
    target: "acme/public-issues",
    title: "One click",
    ...overrides,
  });
}

test("one exact armed Report click is consumed once", () => {
  clearProductIssueAuthorizations();
  const target = child();
  serveProductIssueAuthorization(target as never);
  assert.equal(armProductIssueAuthorization(INPUT), true);

  ask(target);
  assert.equal(target.replies[0]?.granted, true);
  ask(target);
  assert.equal(target.replies[1]?.granted, false);
});

test("an unarmed or differently derived report is refused", () => {
  clearProductIssueAuthorizations();
  const target = child();
  serveProductIssueAuthorization(target as never);
  assert.equal(armProductIssueAuthorization(INPUT), true);

  ask(target, { draftIdentity: "b".repeat(64) });
  assert.equal(target.replies[0]?.granted, false);
  ask(target, { requestId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
  assert.equal(target.replies[1]?.granted, false);
});

test("malformed renderer authorization input is rejected", () => {
  clearProductIssueAuthorizations();
  assert.equal(armProductIssueAuthorization({ ...INPUT, requestId: "not-a-uuid" }), false);
  assert.equal(armProductIssueAuthorization({ ...INPUT, draftIdentity: "short" }), false);
  assert.equal(armProductIssueAuthorization(null), false);
});
