import assert from "node:assert/strict";
import type { IdleSdkSender } from "../../src/server/pending-turns.ts";

/** Complete the transport contract for fixtures that exercise only idle delivery. */
export const unexpectedActiveSdkDelivery: Pick<IdleSdkSender, "send" | "interruptForDelivery"> = {
  async send() {
    assert.fail("This fixture does not expect SDK steering");
  },
  async interruptForDelivery() {
    assert.fail("This fixture does not expect queue-preserving SDK interruption");
  },
};
