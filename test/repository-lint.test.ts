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

  write("src/shared/non-agent-values.ts", 'export const model = (provider) => provider === "codex"; export const wire = (form) => form === "claude";');
  write("src/server/independent-map.ts", 'export function prune(id) { const sessions = new Map(); sessions.delete(id); }');
  write("src/server/branch-overwrite.ts", "export function prune(registry, condition, id) { let sessions = registry.sessions; if (condition) { sessions = new Map(); sessions.delete(id); } }");
  write("src/server/independent-destructured-map.ts", 'export function prune(cache, id) { const { sessions } = cache; sessions.delete(id); }');
  write("src/server/independent-json.ts", "export function read({ req }) { return ((req) => req.json())(req); }");
  write("src/server/reassigned.ts", "export function use(c, registry, other, id) { let request = c.req; request = other; request.json(); let sessions = registry.sessions; sessions = new Map(); sessions.delete(id); }");
  write("src/server/overwritten-event.ts", 'export function use(emit) { let type = "session_remove"; type = "other"; emit({ type }); }');
  write("src/server/typed-independent-map.ts", "export function prune({ sessions }: Cache, id) { sessions.delete(id); }");
  write("src/server/picked-independent-map.ts", 'export function prune({ sessions }: Pick<Cache, "sessions">, id) { sessions.delete(id); }');

  const testIdAttributes = "data-" + "testid";
  const testIdSeeds = {
    "e2e/direct-locator.ts": 'export const locate = (getByTestId) => getByTestId("view");',
    "src/web/quoted-key.ts": 'export const props = { "' + testIdAttributes + '": "view" };',
    "e2e/css-selector.ts": 'export const locate = (page) => page.locator("[' + testIdAttributes + '=view]");',
    "e2e/template-selector.ts": 'export const locate = (page, id) => page.locator(`[' + testIdAttributes + '="${id}"]`);',
  };
  const seed = {
    ...testIdSeeds,
    "src/server/reassigned-typed-agent.ts": 'export function choose(initial, next) { let selected: AgentType = initial; selected = next(); return selected === "claude"; }',
    "src/server/reassigned-typed-registry.ts": "export function evict(initial, next, id) { let owner: Registry = initial; owner = next(); owner.sessions.delete(id); }",
    "src/server/destructured-agent.ts": 'export function choose(session) { const { agent: selected } = session; return selected === "claude"; }',
    "src/server/non-null-event.ts": 'export const evict = (emit, id) => emit({ type: ("session_remove" as const)!, id });',
    "src/server/request-alias.ts": 'export function read(c) { const request = c.req; return request.json(); }',
    "src/server/agent-alias.ts": 'export function choose(session) { const selected = session.agent; return selected === "claude"; }',
    "src/server/registry-alias.ts": 'export function evict(registry, id) { const sessions = registry.sessions; return sessions.delete(id); }',
    "src/server/mutable-request-alias.ts": 'export function read(c) { let request = c.req; return request.json(); }',
    "src/server/mutable-registry-alias.ts": 'export function evict(registry, id) { let sessions = registry.sessions; return sessions.delete(id); }',
    "src/server/event-alias.ts": 'export function evict(emit, id) { const type = "session_remove" as const; emit({ type, id }); }',
    "src/server/registry-owner-alias.ts": 'export function evict(registry, id) { const owner = registry; owner.sessions.delete(id); }',
    "src/server/destructured-sessions.ts": 'export function evict(registry, id) { const { sessions } = registry; sessions.delete(id); }',
    "src/server/request-before-write.ts": 'export function read(c, other) { let request = c.req; request.json(); request = other; }',
    "src/server/sessions-before-write.ts": 'export function evict(registry, id) { let sessions = registry.sessions; sessions.delete(id); sessions = new Map(); }',
    "src/server/sessions-before-nested-write.ts": 'export function evict(registry, id, condition) { let sessions = registry.sessions; sessions.delete(id); if (condition) { sessions = new Map(); } }',
    "src/server/sessions-inside-nested-block.ts": 'export function evict(registry, id, condition) { let sessions = registry.sessions; if (condition) { sessions.delete(id); sessions = new Map(); } }',
    "src/server/conditional-session-write.ts": 'export function evict(registry, id, condition) { let sessions = registry.sessions; if (condition) { sessions = new Map(); } sessions.delete(id); }',
    "src/server/conditional-registry-alias.ts": 'export function evict(registry, id, condition) { let sessions = new Map(); if (condition) { sessions = registry.sessions; } sessions.delete(id); }',
    "src/server/request-before-nested-write.ts": 'export function read(c, other, condition) { let request = c.req; request.json(); if (condition) { request = other; } }',
    "src/server/agent-before-nested-write.ts": 'export function choose(session, condition) { let selected = session.agent; const match = selected === "claude"; if (condition) { selected = "other"; } return match; }',
    "src/server/agent-name-alias.ts": 'export function choose(agent) { const target = "claude" as const; return agent === target || target === agent; }',
    "src/server/assigned-sessions.ts": 'export function evict(registry, id) { let sessions = new Map(); sessions = registry.sessions; sessions.delete(id); }',
    "src/server/assigned-event.ts": 'export function evict(emit, id) { let type = "other"; type = "session_remove"; emit({ type, id }); }',
    "src/server/typed-sessions.ts": 'export function evict({ sessions }: Registry, id) { sessions.delete(id); }',
    "src/server/picked-sessions.ts": 'export function evict({ sessions }: Pick<Registry, "sessions">, id) { sessions.delete(id); }',
    "src/shared/unowned.ts": 'import "node:fs";',
    "src/shared/nested/unowned.mjs": 'export const builtin = import("node:path");',
    "src/shared/subpath.ts": 'import "node:fs/promises";',
    "src/server/destructured-request.ts": 'export const read = ({ req: request }) => request.json(); export function readLocal(c) { const { req } = c; return req.json(); }',
    "src/server/route.ts": 'export const read = (context) => context["req"]?.json();',
    "src/server/agent.ts": 'export const isPi = (agent) => "pi" === agent; export const branch = (agent) => { switch (agent) { case "codex": return true; default: return false; } };',
    "src/server/eviction.ts": 'export const evict = (registry, id, emit) => { registry.sessions["delete"](id); emit({ ["type"]: "session_remove", id }); };',
    "src/server/asserted-event.ts": 'export const evict = (id, emit) => emit({ type: "session_remove" as const, id });',
    "src/server/satisfies-event.ts": 'export const evict = (id, emit) => emit({ type: "session_remove" satisfies string, id });',
    "src/web/view.tsx": 'export const view = <div data-testid="view" />;',
    "test/blocked.ts": 'import "node:assert"; import "@testing-library/react"; void import("jsdom");',
    "e2e/blocked.cjs": 'require("jest"); require("vitest/config");',
    "e2e/locator.ts": 'export const locate = (page) => page["getByTestId"]("view");',
  };
  const run = () => spawnSync(process.execPath, [
    join(checkout, "node_modules/oxlint/bin/oxlint"), "--format", "unix", "--quiet", "src", "test", "e2e",
  ], { cwd: root, encoding: "utf8" });

  const allowed = run();
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  for (const [path, source] of Object.entries(seed)) write(path, source);
  const blocked = run();
  const output = blocked.stdout + blocked.stderr;
  assert.equal(blocked.status, 1, output);
  for (const [rule, count] of Object.entries({
    "no-restricted-imports": 3,
    "test-imports": 5,
    "no-test-ids": 6,
    "parse-request-body": 7,
    "agent-comparison": 8,
    "registry-eviction": 20,
  })) {
    assert.equal(output.split(`(${rule})`).length - 1, count, output);
    t.diagnostic(`Rejected ${count} seeded violations of ${rule}.`);
  }
  const testIdDiagnostics = output.split("\n").filter((line) => line.endsWith("[Error/repository(no-test-ids)]"));
  assert.match(output, /src\/server\/satisfies-event\.ts:\d+:\d+: [^\n]*\[Error\/repository\(registry-eviction\)\]/);
  t.diagnostic("Rejected the session removal event wrapped in satisfies.");
  for (const [file, rule] of [
    ["request-alias", "parse-request-body"],
    ["destructured-agent", "agent-comparison"],
    ["non-null-event", "registry-eviction"],
    ["agent-alias", "agent-comparison"],
    ["reassigned-typed-agent", "agent-comparison"],
    ["reassigned-typed-registry", "registry-eviction"],
    ["registry-alias", "registry-eviction"],
    ["mutable-request-alias", "parse-request-body"],
    ["mutable-registry-alias", "registry-eviction"],
    ["event-alias", "registry-eviction"],
    ["registry-owner-alias", "registry-eviction"],
    ["destructured-sessions", "registry-eviction"],
    ["request-before-write", "parse-request-body"],
    ["sessions-before-write", "registry-eviction"],
    ["sessions-before-nested-write", "registry-eviction"],
    ["sessions-inside-nested-block", "registry-eviction"],
    ["conditional-session-write", "registry-eviction"],
    ["conditional-registry-alias", "registry-eviction"],
    ["request-before-nested-write", "parse-request-body"],
    ["agent-before-nested-write", "agent-comparison"],
    ["agent-name-alias", "agent-comparison"],
    ["assigned-sessions", "registry-eviction"],
    ["assigned-event", "registry-eviction"],
    ["typed-sessions", "registry-eviction"],
    ["picked-sessions", "registry-eviction"],
  ]) {
    assert.ok(output.split("\n").some((line) =>
      line.startsWith(`src/server/${file}.ts:`) && line.endsWith(`[Error/repository(${rule})]`)), output);
    t.diagnostic(`Rejected ${file} with ${rule}.`);
  }
  for (const path of Object.keys(testIdSeeds)) {
    assert.ok(testIdDiagnostics.some((line) => line.startsWith(`${path}:`)), output);
    t.diagnostic(`Rejected test ID syntax in ${path}.`);
  }
});
