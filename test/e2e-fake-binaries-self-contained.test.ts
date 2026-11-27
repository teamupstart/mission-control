import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// `e2e/fixtures/fake-agents.ts` copies each fake agent into the fixture home's `fake-bin/` and
// the daemon runs it from there, so an import that reaches outside `e2e/fixtures/` cannot
// resolve: the fake exits on ERR_MODULE_NOT_FOUND before writing a turn, and every dispatch spec
// sees an exited session. Test helpers such as `test/temp-root.mjs` are the likely import to
// slip in; a copied fake makes its temp files under the inherited TMPDIR instead, which already
// points inside the run's temp root (docs/test-temp-dirs.md).

const FIXTURES = new URL("../e2e/fixtures/", import.meta.url);

test("every fake agent binary the e2e fixtures copy imports nothing outside its own directory", () => {
  const installer = readFileSync(new URL("fake-agents.ts", FIXTURES), "utf8");
  const copied = [...installer.matchAll(/copyFileSync\(fileURLToPath\(new URL\("\.\/([^"]+\.mjs)", import\.meta\.url\)\)/g)].map((match) => match[1]!);
  assert.ok(copied.includes("fake-claude.mjs"), `no copied fakes found in fake-agents.ts: ${copied.join(", ")}`);
  for (const name of copied) {
    const source = readFileSync(fileURLToPath(new URL(name, FIXTURES)), "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)]
      .map((match) => match[1] ?? match[2]!);
    const escaping = specifiers.filter((specifier) => specifier.startsWith("../") || specifier.startsWith("/"));
    assert.deepEqual(escaping, [], `${name} is run from a copy in fake-bin/ and cannot import ${escaping.join(", ")}`);
  }
});
