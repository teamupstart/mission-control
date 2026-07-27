import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

test("each message composer replaces and cleans up its delivery timer", () => {
  for (const file of ["ActionBar.tsx", "TranscriptPanel.tsx"]) {
    const source = readFileSync(
      fileURLToPath(new URL(`../src/web/components/${file}`, import.meta.url)),
      "utf8",
    );
    const helper = source.slice(
      source.indexOf("function showFlash"),
      source.indexOf("useEffect(", source.indexOf("function showFlash")),
    );
    assert.match(helper, /clearTimeout\(flashTimer\.current\)/, file);
    assert.match(helper, /flashTimer\.current = setTimeout/, file);
    assert.match(
      source,
      /useEffect\(\s*\(\) => \(\) => \{\s*if \(flashTimer\.current\) clearTimeout\(flashTimer\.current\)/,
      file,
    );
  }
});
