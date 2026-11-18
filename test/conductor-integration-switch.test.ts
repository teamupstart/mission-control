import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The ai-conductor integration is hidden behind one switch. These pin the shipped state - off -
// at every boundary it is applied, and pin that the same helpers restore everything when the
// switch is on, so flipping it back is the whole of the change.

const home = mkdtempSync(join(tmpdir(), "mission-conductor-switch-"));
process.env.HARNESS_HOME = join(home, "state");
process.env.MISSION_CONDUCTOR_BIN = join(home, "no-such-conductor");
process.env.AI_CONDUCTOR_REGISTRY = join(home, "no-such-registry.json");

const {
  CONDUCTOR_INTEGRATION_ENABLED,
  CONDUCTOR_UNAVAILABLE_DETAIL,
  availableSetupDependencyIds,
  setupDependencyAvailable,
  setupFamilyAvailable,
  visibleSetupFamilyIds,
} = await import("../src/shared/conductor-integration.ts");
const { SETUP_DEPENDENCY_IDS, SETUP_DEPENDENCY_INFO, SETUP_FAMILY_IDS } = await import(
  "../src/shared/setup-catalog.ts"
);
const {
  SETTINGS_CATEGORIES,
  VISIBLE_SETTINGS_CATEGORIES,
  settingsCategoriesIn,
  settingsCategoryAvailable,
} = await import("../src/web/lib/settings-registry.ts");
const { SETTINGS_CONTROLS } = await import("../src/web/lib/settings-search.ts");
const { parseMissionRoute } = await import("../src/web/workflows/useWorkflowRoute.ts");
const { familyForAnchor } = await import("../src/web/components/SetupPanel.tsx");
const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setPipelinesConfig } = await import("../src/server/pipelines/config.ts");
const { conductorIntegrationEnabled, overrideConductorIntegrationForTests } = await import(
  "../src/server/pipelines/availability.ts"
);
const { pipelineTaskLaunch, startPipelineWatcher } = await import(
  "../src/server/pipelines/index.ts"
);
const { restorePipelineProjection } = await import("../src/server/pipelines/index.ts");
const { PIPELINE_PROVIDERS } = await import("../src/server/pipelines/providers.ts");
const { loadPipelineRuns, upsertPipelineRunRow } = await import("../src/server/db.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");
const { settingsStatus } = await import("../src/server/settings-status.ts");
const { setupChecksView } = await import("../src/server/setup/index.ts");
const { executeSetupInstall } = await import("../src/server/setup/install.ts");
type SetupDeps = import("../src/server/setup/types.ts").SetupDeps;

openDb();
// These tests describe the HIDDEN state, so they must pass whichever way the switch is set:
// flipping `CONDUCTOR_INTEGRATION_ENABLED` is meant to be the whole of restoring the
// integration. The daemon reads the switch through an accessor, so it is held off here. The
// dashboard reads the constant at module load, which a test cannot override, so the few
// assertions about the SHIPPED dashboard state run only while the constant is off; the
// helpers behind them are also exercised with an explicit `false` either way.
overrideConductorIntegrationForTests(false);
const SHIPPED_HIDDEN = {
  skip: CONDUCTOR_INTEGRATION_ENABLED && "asserts the shipped dashboard state, and the switch is on",
};
after(() => {
  overrideConductorIntegrationForTests(null);
  rmSync(home, { recursive: true, force: true });
});

test("the daemon reads the shared switch, and only a test can override it", () => {
  overrideConductorIntegrationForTests(null);
  assert.equal(conductorIntegrationEnabled(), CONDUCTOR_INTEGRATION_ENABLED);
  overrideConductorIntegrationForTests(true);
  assert.equal(conductorIntegrationEnabled(), true);
  overrideConductorIntegrationForTests(false);
  assert.equal(conductorIntegrationEnabled(), false);
});

test("Setup hides the ai-conductor row and the Pipelines family it empties, and only those", () => {
  // The append-only catalog keeps the id; only what Setup reports changes.
  assert.ok(SETUP_DEPENDENCY_IDS.includes("ai-conductor"));
  assert.equal(SETUP_DEPENDENCY_INFO["ai-conductor"].family, "pipelines");

  assert.equal(setupDependencyAvailable("ai-conductor", false), false);
  assert.deepEqual(
    availableSetupDependencyIds(false),
    SETUP_DEPENDENCY_IDS.filter((id) => id !== "ai-conductor"),
  );
  assert.equal(setupFamilyAvailable("pipelines", false), false);
  assert.deepEqual(
    visibleSetupFamilyIds([], false),
    SETUP_FAMILY_IDS.filter((family) => family !== "pipelines"),
  );
  // Repositories has no catalog dependency at all; hiding must not take it with it.
  assert.ok(visibleSetupFamilyIds([], false).includes("repositories"));
  // A family is never withheld while a row names it.
  assert.ok(visibleSetupFamilyIds([{ family: "pipelines" }], false).includes("pipelines"));
  // The defaults are the shipped switch.
  assert.deepEqual(availableSetupDependencyIds(), availableSetupDependencyIds(CONDUCTOR_INTEGRATION_ENABLED));

  // Flipped back on, everything returns.
  assert.deepEqual(availableSetupDependencyIds(true), [...SETUP_DEPENDENCY_IDS]);
  assert.deepEqual(visibleSetupFamilyIds([], true), [...SETUP_FAMILY_IDS]);
});

test("the Setup rail cannot be deep-linked into the hidden Pipelines family", SHIPPED_HIDDEN, () => {
  assert.equal(familyForAnchor("setup/family-pipelines", []), null);
  assert.equal(familyForAnchor("setup/family-agents", []), "agents");
});

test("the Settings availability rule withholds only Conductor, and only while hidden", () => {
  assert.ok(SETTINGS_CATEGORIES.some((category) => category.id === "conductor"), "kept in the registry");
  assert.equal(settingsCategoryAvailable("conductor", false), false);
  assert.equal(settingsCategoryAvailable("conductor", true), true);
  assert.equal(settingsCategoryAvailable("setup", false), true);
  assert.equal(settingsCategoryAvailable("conductor"), CONDUCTOR_INTEGRATION_ENABLED);
});

test("Settings draws, routes, walks and searches no Conductor category", SHIPPED_HIDDEN, () => {
  assert.ok(!VISIBLE_SETTINGS_CATEGORIES.some((category) => category.id === "conductor"));
  assert.ok(!settingsCategoriesIn("background").some((category) => category.id === "conductor"));
  assert.equal(VISIBLE_SETTINGS_CATEGORIES.length, SETTINGS_CATEGORIES.length - 1);

  const route = parseMissionRoute("#/settings/conductor");
  assert.equal(route.page, "settings");
  assert.notEqual(route.page === "settings" ? route.category : null, "conductor");

  assert.deepEqual(SETTINGS_CONTROLS.filter((control) => control.category === "conductor"), []);
  const setup = SETTINGS_CONTROLS.find((control) => control.id === "setup-checks");
  assert.ok(setup);
  assert.ok(!setup.keywords.includes("ai-conductor"));
  assert.doesNotMatch(setup.description, /conductor/i);
  const setupCategory = SETTINGS_CATEGORIES.find((category) => category.id === "setup");
  assert.ok(setupCategory && !setupCategory.keywords.includes("conductor"));
});

function setupDeps(overrides: Partial<SetupDeps> = {}): { deps: SetupDeps; probes: () => number } {
  let conductorProbes = 0;
  const deps: SetupDeps = {
    mcpTrust: () => ({ state: "satisfied", evidence: "fixture" }),
    environment: {
      homeDir: "/home/operator",
      readText: async () => ({ ok: false, missing: true, reason: "missing" }),
      subdirectories: async () => [],
    },
    agentBin: (agent) => `/tools/${agent}`,
    installedBackend: async (id) => `/tools/${id}`,
    herdrServer: async () => ({ state: "ready", socket: "/run/herdr.sock", version: "0.9.0" }),
    cmuxControl: async () => ({ state: "ready", accessMode: "allowAll" }),
    ghBin: () => "/tools/gh",
    resolveBinPath: async () => null,
    runCommand: async () => ({ stdout: "", stderr: "", code: 1 }) as never,
    installedPlugins: async () => ({ ok: true, plugins: [], recordPath: "/x" }),
    skills: () => ({ enabled: false, readable: true, configured: 0, directories: [], problems: [] }),
    conductorProbe: async () => {
      conductorProbes += 1;
      return {
        provider: "ai-conductor",
        found: false,
        bin: "conduct-ts",
        binPath: null,
        version: null,
        registryPath: join(home, "no-such-registry.json"),
        projects: [],
        error: "missing",
        checkedAt: 1,
      };
    },
    terminalTargets: () => [],
    repositoryIndex: async () => ({ repoCount: 1, directories: [] }),
    environmentChecks: async () => [],
    readBannerDismissal: () => ({ firstLaunchAcknowledged: false, acknowledged: [] }),
    writeBannerDismissal: () => {},
    ...overrides,
  };
  return { deps, probes: () => conductorProbes };
}

test("Setup neither probes nor lists ai-conductor, so it cannot reach the banner counts", async () => {
  const hidden = setupDeps();
  const view = await setupChecksView(hidden.deps);
  assert.equal(hidden.probes(), 0, "the hidden integration is never probed");
  assert.ok(!view.rows.some((row) => row.rowId.source === "dependency" && row.rowId.id === "ai-conductor"));
  assert.ok(!view.rows.some((row) => row.family === "pipelines"));

  const shown = setupDeps({ conductorIntegration: () => true });
  const restored = await setupChecksView(shown.deps);
  assert.equal(shown.probes(), 1);
  const row = restored.rows.find((entry) => entry.rowId.source === "dependency" && entry.rowId.id === "ai-conductor");
  assert.equal(row?.family, "pipelines");
});

test("the Setup installer refuses the hidden provider before touching its installer", async () => {
  let listed = 0;
  const response = await executeSetupInstall(
    { id: "ai-conductor", backend: "tmux" } as never,
    {
      catalog: SETUP_DEPENDENCY_INFO,
      homeDir: home,
      listRepoRoots: async () => {
        listed += 1;
        return [];
      },
      listProviderInstallers: async () => {
        throw new Error("must not be reached");
      },
      prepareProviderInstaller: async () => {
        throw new Error("must not be reached");
      },
      launchTerminal: async () => {
        throw new Error("must not be reached");
      },
      resolveExecutable: async () => null,
    },
  );
  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.detail, CONDUCTOR_UNAVAILABLE_DETAIL);
  assert.equal(listed, 0);
});

test("the daemon runs no watcher and dispatches no Pipeline while hidden", async () => {
  let reads = 0;
  const stop = startPipelineWatcher({
    initializePipelineRuns: () => {},
    initializePipelineCommissions: () => {},
    listPipelineCommissions: () => {
      reads += 1;
      return [];
    },
    upsertPipelineCommission: () => {},
    upsertPipelineRun: () => {},
    removePipelineRun: () => {},
    applyAutomationUsage: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();
  assert.equal(reads, 0, "no tick ran");

  setPipelinesConfig({
    enabled: true,
    foremanMechanicalTriage: true,
    repos: [{ provider: "ai-conductor", repoRoot: home, enabled: true }],
  });
  assert.deepEqual(await pipelineTaskLaunch(home, "intent"), {
    ok: false,
    error: CONDUCTOR_UNAVAILABLE_DETAIL,
  });

  // Consent stays stored, untouched, but nothing is reported as observed.
  const status = settingsStatus().pipelines;
  assert.equal(status.present, false);
  assert.equal(status.observing, 0);
  assert.deepEqual(status.observedRepoKeys, []);
  setPipelinesConfig({ enabled: false, foremanMechanicalTriage: false, repos: [] });
});

test("the pipeline routes answer 'nothing observed' to pollers and 404 to everything else", async () => {
  setPipelinesConfig({
    enabled: true,
    foremanMechanicalTriage: true,
    repos: [{ provider: "ai-conductor", repoRoot: home, enabled: true }],
  });
  const app = buildApp({
    registry: new Registry(),
    reviews: null as never,
    tasks: null as never,
    queues: null as never,
  });
  const request = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
    });

  const repos = await request("/api/pipelines/repos");
  assert.equal(repos.status, 200);
  assert.deepEqual(((await repos.json()) as { repos: unknown[] }).repos, []);

  const foreman = await request("/api/pipelines/foreman");
  assert.equal(foreman.status, 200);
  assert.deepEqual(await foreman.json(), { enabled: false, items: [] });

  for (const [method, path] of [
    ["GET", "/api/pipelines/config"],
    ["GET", "/api/pipelines/installers?provider=ai-conductor"],
    ["POST", "/api/pipelines/register"],
    ["POST", "/api/pipelines/install"],
    ["POST", "/api/pipelines/action"],
    ["POST", "/api/pipelines/console"],
    ["POST", "/ingest/conductor"],
    ["POST", "/mcp/pipelines/adopt"],
    ["POST", "/mcp/pipelines/workspace"],
  ] as const) {
    const res = await request(path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: CONDUCTOR_UNAVAILABLE_DETAIL }, `${method} ${path}`);
  }
  setPipelinesConfig({ enabled: false, foremanMechanicalTriage: false, repos: [] });
});

test("stored pipeline runs still load, and stay stored, while the integration is hidden", async () => {
  // Consent is kept untouched by the switch, so a run projected before it was flipped is still
  // a run for a consented repository - exactly the row an upgraded installation carries.
  setPipelinesConfig({
    enabled: true,
    foremanMechanicalTriage: false,
    repos: [{ provider: "ai-conductor", repoRoot: home, enabled: true }],
  });
  const run = {
    provider: "ai-conductor" as const,
    repoRoot: home,
    slug: "stored-before-the-switch",
    worktree: join(home, ".worktrees", "stored-before-the-switch"),
    tier: "M" as const,
    track: null,
    steps: [],
    lastStep: null,
    halt: null,
    group: "building" as const,
    prUrl: "https://github.com/example/repo/pull/7",
    costTokens: 1234,
    updatedAt: 1_000,
  };
  upsertPipelineRunRow({ run, eventsOffset: 42, eventsIdentity: "ledger-1" });

  // The daemon's own boot order: restore, then start the (now inert) watcher.
  const registry = new Registry();
  assert.doesNotThrow(() => restorePipelineProjection(registry));
  const stop = startPipelineWatcher(registry);
  await new Promise((resolve) => setTimeout(resolve, 20));
  stop();

  assert.deepEqual(
    registry.listPipelineRuns().find((entry) => entry.slug === run.slug),
    run,
    "the stored run is in the live catalog exactly as it was stored",
  );
  const durable = loadPipelineRuns().find((row) => row.run.slug === run.slug);
  assert.deepEqual(durable, { run, eventsOffset: 42, eventsIdentity: "ledger-1" }, "nothing retired or rewrote it");
  setPipelinesConfig({ enabled: false, foremanMechanicalTriage: false, repos: [] });
});

test("every operator action on a stored Pipeline task refuses before reaching the provider", async (t) => {
  const original = PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle;
  t.after(() => {
    PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = original;
  });
  // Any provider call here is the bug: the switch has to refuse before commissioning,
  // replaying, adopting or cancelling anything.
  const reached = (what: string) => async (): Promise<never> =>
    assert.fail(`the hidden integration reached the provider: ${what}`);
  PIPELINE_PROVIDERS["ai-conductor"].engineerLifecycle = {
    capability: reached("capability"),
    readinessProbe: reached("readinessProbe"),
    readiness: reached("readiness"),
    create: reached("create"),
    inspectCorrelation: reached("inspectCorrelation"),
    replay: reached("replay"),
    cancel: reached("cancel"),
  } as never;

  const registry = new Registry();
  const task = mkTask({
    id: "hidden-pipeline-task",
    kind: "pipeline",
    status: "running",
    repoRoot: home,
    sessionId: null,
    pipelineCommissionId: "hidden-commission",
  });
  registry.upsertTask(task);
  const before = registry.getTask(task.id);
  const manager = new TaskManager(registry);
  const guard = {
    commissionId: "hidden-commission",
    activeAttempt: 1,
    engineerRunId: "engineer-run-1",
    providerRevision: 1,
  };

  for (const [name, outcome] of [
    ["recheckPipelineReadiness", await manager.recheckPipelineReadiness(task.id)],
    ["startPipelineAfterReadiness", await manager.startPipelineAfterReadiness(task.id)],
  ] as const) {
    assert.equal(outcome.ok, false, name);
    assert.equal(!outcome.ok && outcome.error, CONDUCTOR_UNAVAILABLE_DETAIL, name);
  }
  for (const [name, outcome] of [
    ["retryPipelineAttempt", await manager.retryPipelineAttempt(task.id, { guard } as never)],
    ["refreshPipelineSuccessor", await manager.refreshPipelineSuccessor(task.id, { guard } as never)],
    ["adoptPipelineSuccessor", await manager.adoptPipelineSuccessor(task.id, { guard } as never)],
  ] as const) {
    assert.equal(outcome.ok, false, name);
    assert.equal(!outcome.ok && outcome.code, "unsupported_provider", name);
    assert.equal(!outcome.ok && outcome.error, CONDUCTOR_UNAVAILABLE_DETAIL, name);
  }

  // Nothing was commissioned, adopted or launched on the task's behalf.
  assert.deepEqual(registry.listPipelineCommissions(), []);
  assert.deepEqual(registry.getTask(task.id), before);
});

test("with consent and an active commission already stored, the hidden watcher never probes, tails or replays", async (t) => {
  // The state an upgraded installation boots into: a consented repository and an Engineer
  // commission mid-run, both stored before the watcher starts.
  setPipelinesConfig({
    enabled: true,
    foremanMechanicalTriage: true,
    repos: [{ provider: "ai-conductor", repoRoot: home, enabled: true }],
  });
  const commission = {
    id: "hidden-active-commission",
    provider: "ai-conductor",
    repoRoot: home,
    activeAttempt: 1,
    attempts: [{ attempt: 1, engineerRunId: "engineer-run-1", state: "running", providerRevision: 0 }],
    // Ends the switch-on pass right after the capability read, so the control below writes
    // nothing: a retiring commission is not replayed.
    retirement: { requestedAt: 1 },
    successorCandidate: null,
    recovery: null,
  } as never;

  // Every provider door the watcher could reach, counted. Each stub answers inertly so the
  // switch-on control below can run a real tick without touching a filesystem or a CLI.
  const provider = PIPELINE_PROVIDERS["ai-conductor"];
  const original = {
    probe: provider.probe,
    readRepo: provider.readRepo,
    knownRunSlugs: provider.knownRunSlugs,
    engineerLifecycle: provider.engineerLifecycle,
  };
  t.after(() => Object.assign(provider, original));
  const calls = { probe: 0, readRepo: 0, knownRunSlugs: 0, lifecycle: 0 };
  provider.probe = async () => {
    calls.probe += 1;
    return original.probe();
  };
  provider.readRepo = async (_repoRoot, cursors) => {
    calls.readRepo += 1;
    return {
      runs: [],
      cursors,
      usage: new Map(),
      restarted: new Set(),
      events: new Map(),
      daemon: "stopped",
      error: null,
    };
  };
  provider.knownRunSlugs = () => {
    calls.knownRunSlugs += 1;
    return new Set();
  };
  const lifecycleCall = async () => {
    calls.lifecycle += 1;
    return { ok: true, value: { supported: true } };
  };
  provider.engineerLifecycle = new Proxy({}, { get: () => lifecycleCall }) as never;

  const runWatcher = async (until: () => boolean, forMs: number): Promise<void> => {
    const registry = new Registry();
    registry.initializePipelineCommissions([commission]);
    const stop = startPipelineWatcher(registry);
    const deadline = Date.now() + forMs;
    while (!until() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    stop();
  };

  // Shipped state. A live watcher ticks the moment it starts, so this window is several times
  // what the control below needs to reach both doors.
  await runWatcher(() => false, 300);
  assert.deepEqual(calls, { probe: 0, readRepo: 0, knownRunSlugs: 0, lifecycle: 0 });

  // Control: the same stored state with the switch on does reach the tail and the Engineer
  // lifecycle, so the zeroes above are the switch and not an unobservable setup.
  overrideConductorIntegrationForTests(true);
  try {
    await runWatcher(() => calls.readRepo > 0 && calls.lifecycle > 0, 2_000);
  } finally {
    overrideConductorIntegrationForTests(false);
  }
  assert.ok(calls.readRepo > 0, "a live watcher tails the consented repository");
  assert.ok(calls.lifecycle > 0, "a live watcher reads the active commission's Engineer lifecycle");
  setPipelinesConfig({ enabled: false, foremanMechanicalTriage: false, repos: [] });
});
