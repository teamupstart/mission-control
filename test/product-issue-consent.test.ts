import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  noConsentPort,
  parentPortConsent,
  PRODUCT_ISSUE_CONSENT_UNAVAILABLE,
  type ProductIssueConsentMessage,
} from "../src/server/product-issue-consent.ts";

/**
 * The channel the publish decision actually travels on.
 *
 * Everything else about product reporting is a computation over a request, and every earlier
 * revision of the confirmation was too - which is why each one was defeated by a caller that
 * simply sent the right bytes. This is not one. The daemon posts a question to the process that
 * forked it and waits for a person; the tests here pin the three ways that ends.
 *
 * The port is faked with a plain EventEmitter because the shape is the contract: post a
 * question, get a reply addressed to that question's id, and never resolve true on your own.
 */

interface FakePort extends EventEmitter {
  posted: ProductIssueConsentMessage[];
  postMessage(message: unknown): void;
}

function fakePort(): FakePort {
  const port = new EventEmitter() as FakePort;
  port.posted = [];
  port.postMessage = (message: unknown): void => {
    port.posted.push(message as ProductIssueConsentMessage);
  };
  return port;
}

/** Reply the way `src/main/product-issue-consent.ts` does, over the same port. */
function reply(port: FakePort, id: string, granted: boolean): void {
  port.emit("message", {
    data: { type: "mission:product-issue-consent-reply", id, granted },
  });
}

const ASK = { target: "acme/public-issues", title: "Tiles freeze after reconnect" };

test("a granted dialog is the only thing that returns true", async () => {
  const port = fakePort();
  const consent = parentPortConsent(port as unknown as NodeJS.Process["parentPort"]);
  const pending = consent.ask(ASK);

  // The question carries what the dialog must show. A confirmation that did not name the
  // repository would be a person agreeing to publish somewhere they were never told about.
  assert.equal(port.posted.length, 1);
  const question = port.posted[0]!;
  assert.equal(question.type, "mission:product-issue-consent");
  assert.equal(question.target, "acme/public-issues");
  assert.equal(question.title, "Tiles freeze after reconnect");

  reply(port, question.id, true);
  assert.equal(await pending, true);
});

test("a dismissed dialog is a no", async () => {
  const port = fakePort();
  const consent = parentPortConsent(port as unknown as NodeJS.Process["parentPort"]);
  const pending = consent.ask(ASK);
  reply(port, port.posted[0]!.id, false);
  assert.equal(await pending, false);
});

/**
 * A reply for a different question does not answer this one.
 *
 * Two reports can be confirmed at once - two windows, or one person who opened the form twice -
 * and a yes to the small typo must never publish the other one. The id is what keeps an answer
 * attached to the thing it answered.
 */
test("an answer to another question is ignored", async () => {
  const port = fakePort();
  const consent = parentPortConsent(port as unknown as NodeJS.Process["parentPort"]);
  const pending = consent.ask(ASK);
  reply(port, "some-other-question", true);

  const settled = await Promise.race([
    pending,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
  ]);
  assert.equal(settled, "pending", "a foreign reply must not resolve this ask");

  reply(port, port.posted[0]!.id, false);
  assert.equal(await pending, false);
});

/** Garbage on the channel is not consent either, and must not settle the ask. */
test("a malformed reply is not an answer", async () => {
  const port = fakePort();
  const consent = parentPortConsent(port as unknown as NodeJS.Process["parentPort"]);
  const pending = consent.ask(ASK);
  port.emit("message", { data: null });
  port.emit("message", { data: { type: "something-else", granted: true } });
  port.emit("message", {});

  const settled = await Promise.race([
    pending,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
  ]);
  assert.equal(settled, "pending");
  reply(port, port.posted[0]!.id, true);
  assert.equal(await pending, true);
});

/** A shell that is not there answers no, and says why publishing is unavailable at all. */
test("with nothing to ask, consent is unavailable rather than assumed", async () => {
  const consent = noConsentPort();
  assert.equal(consent.unavailable, PRODUCT_ISSUE_CONSENT_UNAVAILABLE);
  assert.match(consent.unavailable, /desktop app/);
  assert.equal(await consent.ask(ASK), false);
});
