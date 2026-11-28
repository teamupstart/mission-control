import assert from "node:assert/strict";
import test from "node:test";
import {
  MESSAGE_INTERRUPT_AFTER_MS, MESSAGE_STEER_AFTER_MS, canSteerRunningTurn, deliverySchedule, deliveryStage,
} from "../src/shared/message-delivery.ts";
import type { PendingTurn } from "../src/shared/types.ts";

const turn = { id: "operator", createdAt: 0, deliveryMode: "after-turn", deadlineAt: null } as PendingTurn;
const free = { agent: "claude", runtime: "sdk", pendingReviews: 0 } as const;
const asking = { ...free, pendingReviews: 1 } as const;

test("a running turn steers at one minute and interrupts at three", () => {
  assert.deepEqual(deliverySchedule(free, turn), [
    { at: MESSAGE_STEER_AFTER_MS, action: "steer" },
    { at: MESSAGE_INTERRUPT_AFTER_MS, action: "interrupt" },
  ]);
  assert.equal(canSteerRunningTurn(free), true);
});

test("a turn stopped on a question is never steered, only interrupted", () => {
  assert.equal(canSteerRunningTurn(asking), false);
  assert.deepEqual(deliverySchedule(asking, turn), [{ at: MESSAGE_INTERRUPT_AFTER_MS, action: "interrupt" }]);
  assert.deepEqual(deliveryStage(asking, turn, MESSAGE_STEER_AFTER_MS + 1), { at: MESSAGE_INTERRUPT_AFTER_MS, action: "interrupt" });
});

test("a hand-expedited steer falls back to the standard interruption once the turn stops on a question", () => {
  const expedited = { ...turn, deliveryMode: "steer", deadlineAt: 5 } as PendingTurn;
  assert.deepEqual(deliverySchedule(free, expedited), [{ at: 5, action: "steer" }]);
  assert.deepEqual(deliverySchedule(asking, expedited), [{ at: MESSAGE_INTERRUPT_AFTER_MS, action: "interrupt" }]);
  const interrupt = { ...turn, deliveryMode: "interrupt-after-wait", deadlineAt: 5 } as PendingTurn;
  assert.deepEqual(deliverySchedule(asking, interrupt), [{ at: 5, action: "interrupt" }]);
});
