import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rules = readFileSync(new URL("../.github/CODEOWNERS", import.meta.url), "utf8")
  .split(/\r?\n/)
  .map((line) => line.split("#")[0]!.trim())
  .filter(Boolean)
  .map((line) => line.split(/\s+/));

// The dependency manifests and lockfiles Infosec owns, in the block shared across teamupstart
// repositories plus this repository's `package-lock.json`.
const INFOSEC_PATHS = [
  "Gemfile",
  "Gemfile.lock",
  "yarn.lock",
  "package.json",
  "requirements.in",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "versions.properties",
  "package-lock.json",
  "**/.yarn/cache/**",
];

test("the catch-all lists Delivery Squad and Developer Platform together while retaining the existing owner", () => {
  const [pattern, ...owners] = rules[0]!;
  assert.equal(pattern, "*");
  assert.deepEqual(new Set(owners), new Set([
    "@teamupstart/delivery-squad",
    "@teamupstart/developer-platform",
    "@mancej",
  ]));
});

test("only Infosec's dependency rules override the catch-all", () => {
  // CODEOWNERS is last-match-wins, so a later rule replaces the catch-all's owners rather than
  // offering alternatives. That is deliberate for dependency files - Infosec review is what
  // lets its auto-approver merge dependency PRs - and an accident anywhere else.
  const overrides = rules.slice(1);
  assert.deepEqual(overrides.map(([path]) => path), INFOSEC_PATHS);
  for (const [path, ...owners] of overrides) {
    assert.deepEqual(owners, ["@teamupstart/infosec"], `${path} must be owned by Infosec alone`);
  }
});
