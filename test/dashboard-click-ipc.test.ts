import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { serveDashboardClick } from "../src/main/dashboard-click-ipc.ts";

const dashboard = { id: 1 };

/** Electron's sync event: assigning `returnValue` sends the reply, and only the first one counts. */
function send(ipc: EventEmitter, sender: unknown, input: unknown = {}): unknown[] {
  const replies: unknown[] = [];
  const event = { sender };
  Object.defineProperty(event, "returnValue", { set: (value: unknown) => { replies.push(value); }, get: () => undefined });
  ipc.emit("click", event, input);
  return replies;
}

test("the dashboard's armed click is the one and only reply", () => {
  const ipc = new EventEmitter();
  const armed: unknown[] = [];
  serveDashboardClick(ipc as never, "click", () => dashboard as never, (input) => { armed.push(input); return true; });
  assert.deepEqual(send(ipc, dashboard, { requestId: "r" }), [true]);
  assert.deepEqual(armed, [{ requestId: "r" }]);
});

test("another sender, no window, a refused arm or a throw each reply false exactly once", () => {
  const cases: Array<{ sender: unknown; window: () => unknown; arm: () => boolean; arms: boolean }> = [
    { sender: { id: 2 }, window: () => dashboard, arm: () => true, arms: false },
    { sender: dashboard, window: () => undefined, arm: () => true, arms: false },
    { sender: dashboard, window: () => { throw new Error("destroyed window"); }, arm: () => true, arms: false },
    { sender: dashboard, window: () => dashboard, arm: () => false, arms: true },
    { sender: dashboard, window: () => dashboard, arm: () => { throw new Error("broken arm"); }, arms: true },
  ];
  for (const { sender, window, arm, arms } of cases) {
    const ipc = new EventEmitter();
    let calls = 0;
    serveDashboardClick(ipc as never, "click", window as never, () => { calls++; return arm(); });
    assert.deepEqual(send(ipc, sender), [false]);
    assert.equal(calls, arms ? 1 : 0, "only the dashboard's own click reaches the arm");
  }
});
