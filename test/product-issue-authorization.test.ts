import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  noProductIssueAuthorization,
  parentPortProductIssueAuthorization,
  PRODUCT_ISSUE_AUTHORIZATION_UNAVAILABLE,
  type ProductIssueAuthorizationMessage,
} from "../src/server/product-issue-authorization.ts";

interface FakePort extends EventEmitter {
  posted: ProductIssueAuthorizationMessage[];
  postMessage(message: unknown): void;
}

function fakePort(): FakePort {
  const port = new EventEmitter() as FakePort;
  port.posted = [];
  port.postMessage = (message: unknown): void => {
    port.posted.push(message as ProductIssueAuthorizationMessage);
  };
  return port;
}

const ASK = {
  requestId: "11111111-2222-4333-8444-555555555555",
  draftIdentity: "a".repeat(64),
  target: "acme/public-issues",
  title: "Tiles freeze after reconnect",
};

test("the private parent reply authorizes only its exact request", async () => {
  const port = fakePort();
  const authorization = parentPortProductIssueAuthorization(
    port as unknown as NodeJS.Process["parentPort"],
  );
  const pending = authorization.authorize(ASK);
  assert.deepEqual(
    { ...port.posted[0], id: undefined },
    { type: "mission:product-issue-authorization", ...ASK, id: undefined },
  );

  port.emit("message", {
    data: {
      type: "mission:product-issue-authorization-reply",
      id: "another-request",
      granted: true,
    },
  });
  const unsettled = await Promise.race([
    pending,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
  ]);
  assert.equal(unsettled, "pending");

  port.emit("message", {
    data: {
      type: "mission:product-issue-authorization-reply",
      id: port.posted[0]!.id,
      granted: true,
    },
  });
  assert.equal(await pending, true);
});

test("a daemon with no private parent fails closed", async () => {
  const authorization = noProductIssueAuthorization();
  assert.equal(authorization.unavailable, PRODUCT_ISSUE_AUTHORIZATION_UNAVAILABLE);
  assert.equal(await authorization.authorize(ASK), false);
});
