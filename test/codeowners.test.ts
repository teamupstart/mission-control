import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the catch-all lists Delivery Squad and Developer Platform together while retaining the existing owner", () => {
  const rules = readFileSync(new URL("../.github/CODEOWNERS", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((line) => line.split("#")[0]!.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/));

  // Separate matching rules would override owners instead of offering alternatives.
  assert.equal(rules.length, 1, "all paths must share one ownership rule");
  const [pattern, ...owners] = rules[0]!;
  assert.equal(pattern, "*");
  assert.deepEqual(new Set(owners), new Set([
    "@teamupstart/delivery-squad",
    "@teamupstart/developer-platform",
    "@mancej",
  ]));
});
