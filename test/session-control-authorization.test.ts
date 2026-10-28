import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { armSessionControlAuthorization, serveSessionControlAuthorization } from "../src/main/session-control-authorization.ts";
import { sessionControlAuthorization } from "../src/server/session-control-authorization.ts";
import type { SessionControlAuthorizationMessage } from "../src/shared/session-control-authorization.ts";

function channel() {
  const child = Object.assign(new EventEmitter(), { postMessage: (data: unknown) => port.emit("message", { data }) });
  const port = Object.assign(new EventEmitter(), {
    postMessage: (data: unknown) => { posted.push(data as SessionControlAuthorizationMessage); child.emit("message", data); },
  });
  const posted: SessionControlAuthorizationMessage[] = [];
  serveSessionControlAuthorization(child as never);
  return { child, port, posted, authorize: sessionControlAuthorization(port as never) };
}

test("the private channel requires an exact, unexpired click and consumes it once", async () => {
  const c = channel();
  const input = { requestId: randomUUID(), sessionId: "sdk:controller", enabled: true };
  assert.equal(await c.authorize(input), false, "no operator click");
  for (const mismatch of [{ sessionId: "sdk:other" }, { enabled: false }]) {
    assert.equal(armSessionControlAuthorization(input), true);
    assert.equal(await c.authorize({ ...input, ...mismatch }), false);
    assert.equal(await c.authorize(input), false, "a refused use also consumes the click");
  }
  assert.equal(armSessionControlAuthorization(input, Date.now() - 15_001), true);
  assert.equal(await c.authorize(input), false, "expired click");
  assert.equal(armSessionControlAuthorization(input), true);
  assert.equal(await c.authorize(input), true);
  assert.equal(await c.authorize(input), false, "replayed click");
  assert.equal(c.port.listenerCount("message"), 0);
});

test("desktop input is validated and daemon replacement clears pending clicks", async () => {
  const input = { requestId: randomUUID(), sessionId: "sdk:controller", enabled: true };
  for (const invalid of [null, { ...input, requestId: "forged" }, { ...input, sessionId: "" }, { ...input, enabled: "true" }, { ...input, extra: true }]) {
    assert.equal(armSessionControlAuthorization(invalid), false);
  }
  assert.equal(armSessionControlAuthorization(input), true);
  const replacement = channel();
  assert.equal(await replacement.authorize(input), false);
});

test("no desktop parent, a broken port or a missing correlated reply fails closed", async (t) => {
  const input = { requestId: randomUUID(), sessionId: "sdk:controller", enabled: true };
  assert.equal(await sessionControlAuthorization(undefined)(input), false);
  const port = Object.assign(new EventEmitter(), { postMessage: (_message: unknown) => {} });
  const authorize = sessionControlAuthorization(port as never);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = authorize(input);
  port.emit("message", { data: { type: "mission:session-control-authorization-reply", id: "another-request", granted: true } });
  t.mock.timers.tick(15_000);
  assert.equal(await pending, false);
  assert.equal(port.listenerCount("message"), 0);
  port.postMessage = () => { throw new Error("closed"); };
  assert.equal(await authorize(input), false);
  assert.equal(port.listenerCount("message"), 0);
});
