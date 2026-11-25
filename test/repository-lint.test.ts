import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../", import.meta.url));

test("Oxlint rejects seeded repository policy violations and accepts the owned paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-repository-lint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  function write(path: string, source: string) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source + "\n");
  }
  mkdirSync(join(root, "scripts"));
  for (const path of [".oxlintrc.json", "scripts/oxlint-repository.mjs"]) {
    copyFileSync(join(checkout, path), join(root, path));
  }

  // These statements belong in the exact owning paths in the real configuration.
  write("src/server/http-body.ts", "export const read = (c) => c.req.json();");
  write("src/server/harness/pi/identity.ts", 'export const isPi = (id) => id === "pi";');
  write("src/server/registry.ts", 'export const evict = (sessions, id, emit) => { sessions.delete(id); emit({ type: "session_remove" as const, id }); };');
  write("test/allowed.ts", 'import "node:test"; import "node:assert/strict";');
  write("e2e/allowed.ts", 'import "@playwright/test";');

  const testIdAttributes = "data-" + "testid";
  const testIdSeeds = {
    "e2e/direct-locator.ts": 'export const locate = (getByTestId) => getByTestId("view");',
    "src/web/quoted-key.ts": 'export const props = { "' + testIdAttributes + '": "view" };',
    "e2e/css-selector.ts": 'export const locate = (page) => page.locator("[' + testIdAttributes + '=view]");',
    "e2e/template-selector.ts": 'export const locate = (page, id) => page.locator(`[' + testIdAttributes + '="${id}"]`);',
  };
  const seed = {
    ...testIdSeeds,
    "src/shared/unowned.ts": 'import "node:fs";',
    "src/shared/nested/unowned.mjs": 'export const builtin = import("node:path");',
    "src/server/route.ts": 'export const read = (context) => context["req"]?.json();',
    "src/server/agent.ts": 'export const isPi = (id) => "pi" === id; export const branch = (id) => { switch (id) { case "codex": return true; default: return false; } };',
    "src/server/eviction.ts": 'export const evict = (registry, id, emit) => { registry.sessions["delete"](id); emit({ ["type"]: "session_remove", id }); };',
    "src/server/asserted-event.ts": 'export const evict = (id, emit) => emit({ type: "session_remove" as const, id });',
    "src/server/satisfies-event.ts": 'export const evict = (id, emit) => emit({ type: "session_remove" satisfies string, id });',
    "src/web/view.tsx": 'export const view = <div data-testid="view" />;',
    "test/blocked.ts": 'import "node:assert"; import "@testing-library/react"; void import("jsdom");',
    "e2e/blocked.cjs": 'require("jest"); require("vitest/config");',
    "e2e/locator.ts": 'export const locate = (page) => page["getByTestId"]("view");',
  };
  const run = () => spawnSync(process.execPath, [
    join(checkout, "node_modules/oxlint/bin/oxlint"), "--quiet", "src", "test", "e2e",
  ], { cwd: root, encoding: "utf8" });

  const allowed = run();
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  for (const [path, source] of Object.entries(seed)) write(path, source);
  const blocked = run();
  const output = blocked.stdout + blocked.stderr;
  assert.equal(blocked.status, 1, output);
  for (const [rule, count] of Object.entries({
    "no-restricted-imports": 2,
    "test-imports": 5,
    "no-test-ids": 6,
    "parse-request-body": 1,
    "agent-comparison": 2,
    "registry-eviction": 4,
  })) {
    assert.equal(output.split(`(${rule})`).length - 1, count, output);
    t.diagnostic(`Rejected ${count} seeded violations of ${rule}.`);
  }
  const testIdDiagnostics = output.split("\n").filter((line) => line.includes("error repository(no-test-ids):"));
  assert.match(output, /src\/server\/satisfies-event\.ts:\d+:\d+: error repository\(registry-eviction\):/);
  t.diagnostic("Rejected the session removal event wrapped in satisfies.");
  for (const path of Object.keys(testIdSeeds)) {
    assert.ok(testIdDiagnostics.some((line) => line.startsWith(`${path}:`)), output);
    t.diagnostic(`Rejected test ID syntax in ${path}.`);
  }
});
