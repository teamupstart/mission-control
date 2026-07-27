import { test } from "node:test";
import assert from "node:assert/strict";
import { sdkDeliveryConfirmation } from "../src/web/lib/sdk-delivery.ts";

test("SDK delivery acknowledgements explain where a busy-session message went", () => {
  assert.equal(
    sdkDeliveryConfirmation("queued"),
    "Accepted — queued behind the agent’s current turn.",
  );
  assert.equal(
    sdkDeliveryConfirmation("steered"),
    "Sent — added to the agent’s current turn.",
  );
  assert.equal(sdkDeliveryConfirmation("started"), "Sent — the agent started a new turn.");
  assert.equal(sdkDeliveryConfirmation(undefined), null, "terminal sends keep their old UI");
});
