import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-legacy-treehouse-")));
process.env.HARNESS_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { teardownWorktree } = await import("../src/server/dispatcher.ts");
const { CheckLeaseManager, CheckLeaseStore } = await import("../src/server/workflows/check-lease.ts");
const { stubRun } = await import("../src/server/util/exec.ts");
const {
  LegacyTreehouseAdapter,
  LegacyTreehouseService,
  legacyCheckHolder,
  parseLegacyTreehouseJson,
  warnRetiredTreehouseCadence,
} = await import("../src/server/worktrees/legacy-treehouse.ts");

type Run = typeof import("../src/server/util/exec.ts").run;
type LegacyTreehouseTree = import("../src/server/worktrees/legacy-treehouse.ts").LegacyTreehouseTree;

const db = openDb();
const registry = new Registry();
const checks = new CheckLeaseStore(db);

afterEach(() => {
  db.exec("DELETE FROM workflow_check_leases; DELETE FROM task_repos; DELETE FROM tasks;");
});
after(() => rmSync(home, { recursive: true, force: true }));

function jsonTree(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "1",
    path: join(home, "pool", "1", "repo"),
    status: "leased",
    lease_id: "lease-1",
    lease_holder: "mission-control",
    leased_at: "2026-08-16T12:00:00Z",
    processes: [{ pid: 42, command: "node check.js" }],
    ...over,
  };
}

function runnerFor(
  tree: Record<string, unknown>,
  over: {
    version?: string;
    statusCode?: number;
    malformed?: boolean;
    statusTrees?: Record<string, unknown>[];
  } = {},
) {
  const calls: Array<{ bin: string; args: string[]; cwd?: string }> = [];
  let returned = false;
  const execute: Run = async (bin, args, opts = {}) => {
    calls.push({ bin, args: [...args], cwd: opts.cwd });
    if (args[0] === "--version") {
      return stubRun({ stdout: `${over.version ?? "v2.1.1"}\n`, stderr: "", code: 0 });
    }
    if (args[0] === "status" && args[1] === "--json") {
      if (over.statusCode) {
        return stubRun({ stdout: "", stderr: "x".repeat(900), code: over.statusCode });
      }
      return stubRun({
        stdout: over.malformed
          ? "{broken"
          : JSON.stringify(returned ? [] : (over.statusTrees ?? [tree])),
        stderr: "",
        code: 0,
      });
    }
    if (args[0] === "status") {
      return stubRun({
        stdout: `1 leased ${String(tree.path)} (held by ${String(tree.lease_holder)})\n`,
        stderr: "",
        code: 0,
      });
    }
    if (args[0] === "return") {
      returned = true;
      return stubRun({ stdout: "", stderr: "", code: 0 });
    }
    assert.fail(`unexpected legacy command: ${args.join(" ")}`);
  };
  return { execute, calls, returned: () => returned };
}

function adapterFor(model: ReturnType<typeof runnerFor>): InstanceType<typeof LegacyTreehouseAdapter> {
  return new LegacyTreehouseAdapter({ execute: model.execute, present: () => true });
}

const emptyOccupancy = async (paths: readonly string[]) =>
  new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }]));
const cleanGit = { inspect: async (path: string) => ({
  ok: true as const,
  value: { path, head: "a".repeat(40), dirty: false, commonDirectory: home, detached: true },
}) };

test("v2.1.1 JSON parsing keeps stable identity, time, and bounded process hints", () => {
  const trees = parseLegacyTreehouseJson(JSON.stringify([jsonTree()]));
  assert.equal(trees?.length, 1);
  assert.deepEqual(trees?.[0], {
    name: "1",
    path: join(home, "pool", "1", "repo"),
    status: "leased",
    leaseId: "lease-1",
    holder: "mission-control",
    acquiredAt: "2026-08-16T12:00:00Z",
    processes: [{ pid: 42, command: "node check.js" }],
    identity: "exact",
  } satisfies LegacyTreehouseTree);
  assert.deepEqual(parseLegacyTreehouseJson("[]"), []);
});

test("capabilities distinguish missing, diagnostic-only, and conditional JSON binaries", async () => {
  let spawned = 0;
  const missing = new LegacyTreehouseAdapter({
    present: () => false,
    execute: (async () => { spawned += 1; return stubRun({ stdout: "", stderr: "", code: 0 }); }) as Run,
  });
  assert.equal((await missing.capabilities()).kind, "missing");
  assert.equal(spawned, 0, "a missing compatibility binary is never spawned");

  const old = runnerFor(jsonTree(), { version: "v2.0.9" });
  assert.equal((await adapterFor(old).capabilities()).kind, "diagnostic-only");
  const modern = runnerFor(jsonTree(), { version: "treehouse version v2.1.1" });
  assert.equal((await adapterFor(modern).capabilities()).kind, "conditional-json");
});

test("default detection and execution share the configured absolute Treehouse binary", async () => {
  const binary = join(home, "custom-treehouse");
  const marker = join(home, "custom-treehouse-invoked");
  writeFileSync(binary, `#!/bin/sh\nprintf 'invoked' > '${marker}'\nprintf 'treehouse version v2.1.1\\n'\n`);
  chmodSync(binary, 0o755);
  const previous = process.env.MISSION_TREEHOUSE_BIN;
  process.env.MISSION_TREEHOUSE_BIN = binary;
  try {
    assert.equal((await new LegacyTreehouseAdapter().capabilities()).kind, "conditional-json");
    assert.equal(existsSync(marker), true, "capability detection executes the configured binary");
  } finally {
    if (previous === undefined) delete process.env.MISSION_TREEHOUSE_BIN;
    else process.env.MISSION_TREEHOUSE_BIN = previous;
  }
});

test("missing and old binaries remain read-only and identity-unverifiable", async () => {
  let spawned = 0;
  const missing = new LegacyTreehouseAdapter({
    present: () => false,
    execute: (async () => {
      spawned += 1;
      return stubRun({ stdout: "", stderr: "", code: 0 });
    }) as Run,
  });
  const missingStatus = await missing.status(home);
  assert.equal(missingStatus.state, "unreadable");
  assert.equal(spawned, 0);

  const path = join(home, "pool", "old", "repo");
  const oldModel = runnerFor(jsonTree({ path }), { version: "v2.0.9" });
  const old = adapterFor(oldModel);
  const oldStatus = await old.status(home);
  assert.equal(oldStatus.state, "readable");
  if (oldStatus.state === "readable") {
    assert.equal(oldStatus.trees[0]?.identity, "unverifiable");
  }
  const returned = await old.conditionalReturn({
    repoRoot: home,
    path,
    leaseId: "lease-1",
    expectedHolder: "mission-control",
  });
  assert.equal(returned.outcome, "blocked");
  assert.equal(oldModel.calls.some((entry) => entry.args[0] === "return"), false);
});

test("malformed and failed status are unreadable, bounded, and never become an empty pool", async () => {
  const malformed = await adapterFor(runnerFor(jsonTree(), { malformed: true })).status(home);
  assert.equal(malformed.state, "unreadable");
  assert.match(malformed.diagnostic, /malformed or incomplete/);

  const failed = await adapterFor(runnerFor(jsonTree(), { statusCode: 7 })).status(home);
  assert.equal(failed.state, "unreadable");
  assert.match(failed.diagnostic, /exited 7/);
  assert.ok(failed.diagnostic.length < 600, "stderr must be bounded in operator diagnostics");
});

test("conditional return passes lease and holder guards and confirms disappearance", async () => {
  const path = join(home, "pool", "conditional", "repo");
  const model = runnerFor(jsonTree({ path, lease_id: "lease-exact" }));
  const result = await adapterFor(model).conditionalReturn({
    repoRoot: home,
    path,
    leaseId: "lease-exact",
    expectedHolder: "mission-control",
  });
  assert.deepEqual(result, { outcome: "returned" });
  const call = model.calls.find((entry) => entry.args[0] === "return");
  assert.deepEqual(call?.args, [
    "return",
    "--force",
    "--if-lease-id",
    "lease-exact",
    "--if-lease-holder",
    "mission-control",
    path,
  ]);
  assert.equal(call?.cwd, home);
  assert.equal(model.calls.some((entry) => entry.args[0] === "get"), false);
});

test("same-holder ABA conflicts before mutation", async () => {
  const path = join(home, "pool", "aba", "repo");
  const model = runnerFor(jsonTree({ path, lease_id: "new-lease", lease_holder: "mission-control" }));
  const result = await adapterFor(model).conditionalReturn({
    repoRoot: home,
    path,
    leaseId: "old-lease",
    expectedHolder: "mission-control",
  });
  assert.equal(result.outcome, "conflict");
  assert.equal(model.calls.some((entry) => entry.args[0] === "return"), false);
});

test("inventory classifies exact, unverifiable, and foreign resources from durable owners", async () => {
  const repoRoot = join(home, "inventory-repo");
  const exactPath = join(home, "pool", "inventory-task", "repo");
  const foreignPath = join(home, "pool", "foreign", "repo");
  registry.upsertTask(mkTask({
    id: "legacy-task",
    repoRoot,
    status: "done",
    provider: "treehouse",
    worktreePath: exactPath,
    worktreeLeaseId: "task-lease",
  }));
  checks.insertHeld({
    attemptId: "legacy-check",
    submissionId: "sub",
    nodeId: "gate",
    repoRoot,
    leasePath: join(home, "pool", "historical-check", "repo"),
    holderToken: legacyCheckHolder("legacy-check"),
    provider: "treehouse",
    leaseId: null,
    now: 1,
  });
  const model = runnerFor(jsonTree());
  model.execute = (async (bin, args, opts = {}) => {
    model.calls.push({ bin, args: [...args], cwd: opts.cwd });
    if (args[0] === "--version") return stubRun({ stdout: "v2.1.1\n", stderr: "", code: 0 });
    return stubRun({
      stdout: JSON.stringify([
        jsonTree({ path: exactPath, lease_id: "task-lease" }),
        jsonTree({ path: foreignPath, lease_id: "foreign-lease", lease_holder: "somebody-else" }),
      ]),
      stderr: "",
      code: 0,
    });
  }) as Run;
  const service = new LegacyTreehouseService(db, {
    adapter: adapterFor(model),
    occupancy: emptyOccupancy,
    git: cleanGit,
  });
  const inventory = await service.inventory();
  assert.equal(inventory.find((item) => item.path === exactPath)?.classification, "ownedExact");
  assert.equal(
    inventory.find((item) => item.owners.some((owner) => owner.id === "legacy-check"))?.classification,
    "identityUnverifiable",
  );
  assert.equal(inventory.find((item) => item.path === foreignPath)?.classification, "foreign");
  assert.equal(model.calls.some((entry) => entry.args[0] === "return"), false);
});

test("task cleanup preserves a null-ID legacy resource and never mutates Treehouse", async () => {
  const repoRoot = join(home, "task-null-repo");
  const path = join(home, "pool", "task-null", "repo");
  const task = mkTask({
    id: "task-null",
    repoRoot,
    status: "done",
    provider: "treehouse",
    worktreePath: path,
    worktreeLeaseId: null,
  });
  registry.upsertTask(task);
  const model = runnerFor(jsonTree({ path, lease_id: "observed-later" }));
  const service = new LegacyTreehouseService(db, {
    adapter: adapterFor(model),
    occupancy: emptyOccupancy,
    git: cleanGit,
  });
  await assert.rejects(teardownWorktree(task, service), /lease missing.*no Treehouse lease ID|no Treehouse lease ID/s);
  const retained = registry.getTask(task.id);
  assert.equal(retained?.provider, "treehouse");
  assert.equal(retained?.worktreePath, path);
  assert.equal(retained?.worktreeLeaseId, null);
  assert.equal(model.calls.some((entry) => entry.args[0] === "return"), false);
});

test("task cleanup retains resource fields across unreadable and conflicting legacy states", async () => {
  const repoRoot = join(home, "task-refusals-repo");
  const path = join(home, "pool", "task-refusals", "repo");
  const task = mkTask({
    id: "task-refusals",
    repoRoot,
    status: "done",
    provider: "treehouse",
    worktreePath: path,
    worktreeLeaseId: "persisted-lease",
  });
  const cases = [
    {
      name: "missing binary",
      model: null,
      adapter: new LegacyTreehouseAdapter({ present: () => false }),
    },
    (() => {
      const model = runnerFor(jsonTree({ path, lease_id: "persisted-lease" }), { version: "v2.0.9" });
      return { name: "old binary", model, adapter: adapterFor(model) };
    })(),
    (() => {
      const model = runnerFor(jsonTree({ path }), { malformed: true });
      return { name: "malformed status", model, adapter: adapterFor(model) };
    })(),
    (() => {
      const model = runnerFor(jsonTree({ path, lease_id: "replacement-lease" }));
      return { name: "same-path replacement", model, adapter: adapterFor(model) };
    })(),
    (() => {
      const model = runnerFor(jsonTree({ path: join(home, "pool", "foreign-only", "repo") }));
      return { name: "foreign-only status", model, adapter: adapterFor(model) };
    })(),
    (() => {
      const exact = jsonTree({ path, lease_id: "persisted-lease" });
      const model = runnerFor(exact, {
        statusTrees: [exact, jsonTree({ path, lease_id: "duplicate-lease" })],
      });
      return { name: "duplicate canonical path", model, adapter: adapterFor(model) };
    })(),
  ];

  for (const entry of cases) {
    registry.upsertTask(task);
    const service = new LegacyTreehouseService(db, {
      adapter: entry.adapter,
      occupancy: emptyOccupancy,
      git: cleanGit,
    });

    await assert.rejects(
      teardownWorktree(task, service),
      /legacy Treehouse cleanup refused/,
      entry.name,
    );

    const retained = registry.getTask(task.id);
    assert.equal(retained?.provider, "treehouse", entry.name);
    assert.equal(retained?.worktreePath, path, entry.name);
    assert.equal(retained?.worktreeLeaseId, "persisted-lease", entry.name);
    assert.equal(entry.model?.calls.some((call) => call.args[0] === "return") ?? false, false);
  }
});

test("task cleanup reaches conditional return only for its exact durable owner", async () => {
  const repoRoot = join(home, "task-exact-repo");
  const path = join(home, "pool", "task-exact", "repo");
  const task = mkTask({
    id: "task-exact",
    repoRoot,
    status: "done",
    provider: "treehouse",
    worktreePath: path,
    worktreeLeaseId: "task-lease",
  });
  registry.upsertTask(task);
  const model = runnerFor(jsonTree({ path, lease_id: "task-lease" }));
  const service = new LegacyTreehouseService(db, {
    adapter: adapterFor(model),
    occupancy: emptyOccupancy,
    git: cleanGit,
  });
  await teardownWorktree(task, service);
  assert.equal(model.calls.filter((entry) => entry.args[0] === "return").length, 1);
  assert.equal(registry.getTask(task.id)?.provider, "treehouse", "the domain owner clears only after teardown reports success");
});

test("check cleanup retains its row and pin when legacy identity is unverifiable", async () => {
  const repoRoot = join(home, "check-null-repo");
  const path = join(home, "pool", "check-null", "repo");
  checks.insertHeld({
    attemptId: "check-null",
    submissionId: "sub-null",
    nodeId: "gate",
    repoRoot,
    leasePath: path,
    holderToken: legacyCheckHolder("check-null"),
    provider: "treehouse",
    leaseId: null,
    now: 1,
  });
  const model = runnerFor(jsonTree({ path, lease_holder: legacyCheckHolder("check-null") }));
  const service = new LegacyTreehouseService(db, {
    adapter: adapterFor(model),
    occupancy: emptyOccupancy,
    git: cleanGit,
  });
  const manager = new CheckLeaseManager(db, { legacy: service });
  const result = await manager.releaseForAttempt("check-null");
  assert.equal(result.outcome, "retry");
  assert.equal(checks.get("check-null")?.cleanupState, "held");
  assert.deepEqual(manager.pinnedPaths(), [path]);
  assert.equal(model.calls.some((entry) => entry.args[0] === "return"), false);
});

test("check cleanup conditionally returns an exact legacy ID before clearing its row", async () => {
  const repoRoot = join(home, "check-exact-repo");
  const path = join(home, "pool", "check-exact", "repo");
  checks.insertHeld({
    attemptId: "check-exact",
    submissionId: "sub-exact",
    nodeId: "gate",
    repoRoot,
    leasePath: path,
    holderToken: legacyCheckHolder("check-exact"),
    provider: "treehouse",
    leaseId: "check-lease",
    now: 1,
  });
  const model = runnerFor(jsonTree({
    path,
    lease_id: "check-lease",
    lease_holder: legacyCheckHolder("check-exact"),
  }));
  const service = new LegacyTreehouseService(db, {
    adapter: adapterFor(model),
    occupancy: emptyOccupancy,
    git: cleanGit,
  });
  const manager = new CheckLeaseManager(db, { legacy: service });
  assert.deepEqual(await manager.releaseForAttempt("check-exact"), { outcome: "returned" });
  assert.equal(checks.get("check-exact")?.cleanupState, "returned");
  assert.deepEqual(manager.pinnedPaths(), []);
  assert.equal(model.calls.filter((entry) => entry.args[0] === "return").length, 1);
});

test("check cleanup retains its row and pin across a same-holder ABA conflict", async () => {
  const repoRoot = join(home, "check-aba-repo");
  const path = join(home, "pool", "check-aba", "repo");
  checks.insertHeld({
    attemptId: "check-aba",
    submissionId: "sub-aba",
    nodeId: "gate",
    repoRoot,
    leasePath: path,
    holderToken: legacyCheckHolder("check-aba"),
    provider: "treehouse",
    leaseId: "old-check-lease",
    now: 1,
  });
  const model = runnerFor(jsonTree({
    path,
    lease_id: "new-check-lease",
    lease_holder: legacyCheckHolder("check-aba"),
  }));
  const service = new LegacyTreehouseService(db, {
    adapter: adapterFor(model),
    occupancy: emptyOccupancy,
    git: cleanGit,
  });
  const manager = new CheckLeaseManager(db, { legacy: service });

  const result = await manager.releaseForAttempt("check-aba");

  assert.equal(result.outcome, "retry");
  assert.equal(checks.get("check-aba")?.cleanupState, "held");
  assert.deepEqual(manager.pinnedPaths(), [path]);
  assert.equal(model.calls.some((entry) => entry.args[0] === "return"), false);
});

test("dirty, occupied, and unknown occupancy all block exact return", async () => {
  const repoRoot = join(home, "gated-repo");
  const path = join(home, "pool", "gated", "repo");
  registry.upsertTask(mkTask({
    id: "gated-task",
    repoRoot,
    status: "done",
    provider: "treehouse",
    worktreePath: path,
    worktreeLeaseId: "gated-lease",
  }));
  const cases = [
    {
      name: "dirty",
      occupancy: emptyOccupancy,
      git: { inspect: async () => ({ ok: true as const, value: { path, head: "a".repeat(40), dirty: true, commonDirectory: home, detached: true } }) },
    },
    {
      name: "occupied",
      occupancy: async (paths: readonly string[]) => new Map(paths.map((entry) => [entry, {
        status: "known" as const,
        occupants: [{ pid: 9, ppid: 1, startRaw: "1", startMs: 1, command: "node", cwd: entry, knownOwner: null }],
      }])),
      git: cleanGit,
    },
    {
      name: "unknown",
      occupancy: async (paths: readonly string[]) => new Map(paths.map((entry) => [entry, {
        status: "unknown" as const,
        reason: "process evidence unavailable",
      }])),
      git: cleanGit,
    },
  ];
  for (const entry of cases) {
    const model = runnerFor(jsonTree({ path, lease_id: "gated-lease" }));
    const service = new LegacyTreehouseService(db, {
      adapter: adapterFor(model),
      occupancy: entry.occupancy,
      git: entry.git,
    });
    const result = await service.executeReturn({ kind: "task", id: "gated-task", position: 0 });
    assert.equal(result.outcome, "blocked", entry.name);
    assert.equal(model.calls.some((call) => call.args[0] === "return"), false, entry.name);
    const retained = registry.getTask("gated-task");
    assert.equal(retained?.provider, "treehouse", entry.name);
    assert.equal(retained?.worktreePath, path, entry.name);
    assert.equal(retained?.worktreeLeaseId, "gated-lease", entry.name);
  }
});

test("execute rechecks process and dirty safety after preview before forced return", async () => {
  const repoRoot = join(home, "safety-race-repo");
  const path = join(home, "pool", "safety-race", "repo");
  registry.upsertTask(mkTask({
    id: "safety-race-task",
    repoRoot,
    status: "done",
    provider: "treehouse",
    worktreePath: path,
    worktreeLeaseId: "safety-race-lease",
  }));

  for (const kind of ["occupied", "dirty"] as const) {
    let occupancyReads = 0;
    let dirtyReads = 0;
    const model = runnerFor(jsonTree({ path, lease_id: "safety-race-lease" }));
    const service = new LegacyTreehouseService(db, {
      adapter: adapterFor(model),
      occupancy: async (paths: readonly string[]) => {
        occupancyReads += 1;
        return new Map(paths.map((entry) => [entry, kind === "occupied" && occupancyReads > 1
          ? {
              status: "known" as const,
              occupants: [{ pid: 19, ppid: 1, startRaw: "1", startMs: 1, command: "node", cwd: entry, knownOwner: null }],
            }
          : { status: "known" as const, occupants: [] }]));
      },
      git: {
        inspect: async () => {
          dirtyReads += 1;
          return {
            ok: true as const,
            value: {
              path,
              head: "a".repeat(40),
              dirty: kind === "dirty" && dirtyReads > 1,
              commonDirectory: home,
              detached: true,
            },
          };
        },
      },
    });

    const result = await service.executeReturn({ kind: "task", id: "safety-race-task", position: 0 });

    assert.equal(result.outcome, "blocked", kind);
    assert.equal(model.calls.some((call) => call.args[0] === "return"), false, kind);
    assert.ok(occupancyReads >= 2, `${kind}: occupancy must be sampled again after preview`);
    assert.ok(dirtyReads >= 2, `${kind}: cleanliness must be sampled again after preview`);
  }
});

test("the retired reaper cadence warns once and is not treated as an alias", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
  try {
    warnRetiredTreehouseCadence({ MISSION_POOL_REAP_MS: "1000" });
    warnRetiredTreehouseCadence({ MISSION_POOL_REAP_MS: "2000" });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /MISSION_POOL_REAP_MS is retired and ignored/);
  assert.match(warnings[0] ?? "", /MISSION_WORKTREE_SWEEP_MS/);
});
