import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-setup-route-"));
process.env.MISSION_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { stubRun } = await import("../src/server/util/exec.ts");
type SetupDeps = import("../src/server/setup/types.ts").SetupDeps;
const LOOPBACK = { host: "127.0.0.1:7317" };

after(() => rmSync(home, { recursive: true, force: true }));

function deps(warning: string | null, detail: string | null): SetupDeps {
  return {
    environment: { homeDir: home, readText: async () => ({ ok: false, missing: true, reason: "missing" }), subdirectories: async () => [] },
    agentBin: (agent) => `/fake/${agent}`,
    installedBackend: async (id) => `/fake/${id}`,
    ghBin: () => "/fake/gh",
    resolveBinPath: async (bin) => bin,
    runCommand: async () => stubRun({ stdout: "Logged in to github.com account fake", stderr: "", code: 0 }),
    installedPlugins: async () => ({ ok: true, plugins: [], recordPath: "/fake/record" }),
    skills: () => ({ enabled: false, readable: true, configured: 0, directories: ["/fake/skills"], problems: [] }),
    conductorProbe: async () => { throw new Error("isolated failure"); },
    terminalTargets: () => [{ id: "cmux", label: "cmux", glyph: "", blurb: "New workspace.", detail: null, unavailable: null }],
    environmentChecks: async () => [{ id: "upstartclaw-core-setup", label: "UpstartClaw", warning, detail }],
  };
}

function appFor(setupDeps: SetupDeps) {
  const registry = new Registry();
  return buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    setupDeps,
  );
}

test("the route returns every row and folds an environment warning field by field", async () => {
  const response = await appFor(deps("Finish setup.", "State file says pending.")).request("/api/setup/checks", { headers: LOOPBACK });
  assert.equal(response.status, 200);
  const body = await response.json() as { rows: Array<Record<string, unknown>> };
  assert.equal(body.rows.length, 14);
  const folded = body.rows.find((row) => JSON.stringify(row.rowId) === JSON.stringify({ source: "environment-check", id: "upstartclaw-core-setup" }));
  assert.deepEqual(folded, {
    rowId: { source: "environment-check", id: "upstartclaw-core-setup" },
    label: "UpstartClaw",
    family: "extensions",
    requirement: "optional",
    enables: "Until setup finishes, UpstartClaw tools cannot authenticate reliably in dispatched sessions.",
    remedy: { kind: "skill", command: "/upstartclaw-core:setup" },
    status: { state: "needs-setup", why: "Finish setup.", evidence: "State file says pending." },
  });
  const anchors = body.rows.map((row) => JSON.stringify(row.rowId));
  assert.equal(new Set(anchors).size, anchors.length);
  assert.ok(body.rows.some((row) => (row.status as { state?: string }).state === "unknown"));
});

test("null detail remains null and a silent environment check contributes no row", async () => {
  const withNull = await (await appFor(deps("Finish setup.", null)).request("/api/setup/checks", { headers: LOOPBACK })).json() as { rows: Array<{ rowId: { source: string }; status: { evidence?: unknown } }> };
  assert.equal(withNull.rows.find((row) => row.rowId.source === "environment-check")?.status.evidence, null);
  const silent = await (await appFor(deps(null, "ignored")).request("/api/setup/checks", { headers: LOOPBACK })).json() as { rows: Array<{ rowId: { source: string } }> };
  assert.equal(silent.rows.some((row) => row.rowId.source === "environment-check"), false);
});
