import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETUP_DEPENDENCY_IDS } from "../src/shared/setup-catalog.ts";

const home = mkdtempSync(join(tmpdir(), "mission-setup-route-"));
process.env.MISSION_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { stubRun } = await import("../src/server/util/exec.ts");
type SetupDeps = import("../src/server/setup/types.ts").SetupDeps;
type SetupBannerDismissal = import("../src/shared/setup-catalog.ts").SetupBannerDismissal;
const LOOPBACK = { host: "127.0.0.1:7317" };

after(() => rmSync(home, { recursive: true, force: true }));

interface BannerStore {
  value: SetupBannerDismissal;
  writes: number;
}

function bannerStore(value: SetupBannerDismissal = {
  firstLaunchAcknowledged: false,
  acknowledged: [],
}): BannerStore {
  return { value, writes: 0 };
}

function deps(
  warning: string | null,
  detail: string | null,
  banner = bannerStore(),
): SetupDeps {
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
    readBannerDismissal: () => banner.value,
    writeBannerDismissal: (value) => {
      banner.value = value;
      banner.writes += 1;
    },
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
  const body = await response.json() as {
    rows: Array<Record<string, unknown>>;
    banner: { visible: boolean; attentionRowIds: unknown[]; attentionCount: number };
  };
  assert.equal(body.rows.length, SETUP_DEPENDENCY_IDS.length + 2);
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
  assert.deepEqual(body.banner, {
    visible: true,
    attentionRowIds: [],
    attentionCount: 0,
  });
});

test("null detail remains null and a silent environment check contributes no row", async () => {
  const withNull = await (await appFor(deps("Finish setup.", null)).request("/api/setup/checks", { headers: LOOPBACK })).json() as { rows: Array<{ rowId: { source: string }; status: { evidence?: unknown } }> };
  assert.equal(withNull.rows.find((row) => row.rowId.source === "environment-check")?.status.evidence, null);
  const silent = await (await appFor(deps(null, "ignored")).request("/api/setup/checks", { headers: LOOPBACK })).json() as { rows: Array<{ rowId: { source: string } }> };
  assert.equal(silent.rows.some((row) => row.rowId.source === "environment-check"), false);
});

test("the read prunes repaired acknowledgements before composing its banner", async () => {
  const store = bannerStore({
    firstLaunchAcknowledged: true,
    acknowledged: [{ source: "dependency", id: "gh-cli" }],
  });
  const response = await appFor(deps(null, null, store)).request(
    "/api/setup/checks",
    { headers: LOOPBACK },
  );
  const body = await response.json() as {
    rows: unknown[];
    banner: { visible: boolean; attentionCount: number };
  };

  assert.equal(response.status, 200);
  assert.equal(body.rows.length, SETUP_DEPENDENCY_IDS.length + 1, "every dependency and the derived terminal row remain present");
  assert.deepEqual(store.value, { firstLaunchAcknowledged: true, acknowledged: [] });
  assert.equal(store.writes, 1);
  assert.deepEqual(body.banner, { visible: false, attentionRowIds: [], attentionCount: 0 });
});

test("an unchanged acknowledgement performs no write", async () => {
  const store = bannerStore({
    firstLaunchAcknowledged: true,
    acknowledged: [{ source: "derived", id: "terminal-pair" }],
  });
  const setupDeps = deps(null, null, store);
  setupDeps.terminalTargets = () => [{
    id: "tmux",
    label: "tmux",
    glyph: "",
    blurb: "",
    detail: null,
    unavailable: "No emulator can raise this session.",
  }];
  const response = await appFor(setupDeps).request("/api/setup/checks", { headers: LOOPBACK });
  const body = await response.json() as { banner: { visible: boolean; attentionCount: number } };

  assert.equal(response.status, 200);
  assert.equal(store.writes, 0);
  assert.deepEqual(body.banner, {
    visible: false,
    attentionRowIds: [{ source: "derived", id: "terminal-pair" }],
    attentionCount: 1,
  });
});

test("one dismissal write acknowledges first launch and every supplied broken row", async () => {
  const store = bannerStore({
    firstLaunchAcknowledged: false,
    acknowledged: [],
  });
  const setupDeps = deps(null, null, store);
  setupDeps.resolveBinPath = async (bin) => bin === "/fake/gh" ? null : bin;
  const app = appFor(setupDeps);
  const snapshot = await (await app.request("/api/setup/checks", { headers: LOOPBACK })).json() as {
    snapshotToken: string;
    banner: { attentionRowIds: Array<{ source: "dependency"; id: "gh-cli" | "gh-auth" }> };
  };
  const response = await app.request("/api/setup/checks", {
    method: "PUT",
    headers: { ...LOOPBACK, "content-type": "application/json" },
    body: JSON.stringify({
      snapshotToken: snapshot.snapshotToken,
      acknowledged: snapshot.banner.attentionRowIds,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(store.writes, 1);
  assert.deepEqual(store.value, {
    firstLaunchAcknowledged: true,
    acknowledged: snapshot.banner.attentionRowIds,
  });
});

test("a stale snapshot cannot acknowledge a row after repair and regression", async () => {
  const store = bannerStore({ firstLaunchAcknowledged: true, acknowledged: [] });
  const setupDeps = deps(null, null, store);
  let broken = true;
  setupDeps.terminalTargets = () => broken
    ? [{ id: "tmux", label: "tmux", glyph: "", blurb: "", detail: null, unavailable: "No emulator can raise this session." }]
    : [{ id: "cmux", label: "cmux", glyph: "", blurb: "", detail: null, unavailable: null }];
  const app = appFor(setupDeps);

  const stale = await (await app.request("/api/setup/checks", { headers: LOOPBACK })).json() as {
    snapshotToken: string;
    banner: { attentionRowIds: Array<{ source: "derived"; id: "terminal-pair" }> };
  };
  broken = false;
  await app.request("/api/setup/checks", { headers: LOOPBACK });
  broken = true;
  const regressed = await (await app.request("/api/setup/checks", { headers: LOOPBACK })).json() as {
    banner: { visible: boolean; attentionCount: number };
  };
  assert.deepEqual(regressed.banner, {
    visible: true,
    attentionRowIds: [{ source: "derived", id: "terminal-pair" }],
    attentionCount: 1,
  });

  const response = await app.request("/api/setup/checks", {
    method: "PUT",
    headers: { ...LOOPBACK, "content-type": "application/json" },
    body: JSON.stringify({
      snapshotToken: stale.snapshotToken,
      acknowledged: stale.banner.attentionRowIds,
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Setup checks changed. Re-check before dismissing.",
  });
  assert.equal(store.writes, 0);
  assert.deepEqual(store.value, { firstLaunchAcknowledged: true, acknowledged: [] });
});
