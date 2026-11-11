import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { WorktreeClaimSchema, type WorktreeClaim } from "../src/shared/protocol.ts";
import type { WorktreeOperationView } from "../src/shared/worktrees.ts";
import { openDb } from "../src/server/db.ts";
import {
  WorktreeManager,
  type NativeWorktreeLease,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import { RedactedOutput, buildClaimEnvironment, runClaimStep, runClaimSteps } from "../src/server/worktrees/claim.ts";
import { WarmLogFile, WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import type { WorktreeOccupancy, WorktreeOccupant } from "../src/server/worktrees/occupancy.ts";
import type { CloneTree } from "../src/server/worktrees/seed.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// Warm, through the real operations service, the real manager, real Git and real claim steps.
// Only the copy-on-write clone is faked (a plain copy), as in the seed suite, so the suite
// behaves the same on a disk that can clone and one that cannot. A crash is a second manager
// opened on the same database while the first one's Warm is still in flight: it has none of
// the first one's memory, which is exactly what a restarted daemon has.

const db = openDb();

afterEach(() => {
  db.exec(
    "DELETE FROM worktree_slots; DELETE FROM worktree_pools; " +
      "DELETE FROM app_config WHERE key = 'worktrees';",
  );
});

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])));
}

/** The install step: print, install `deps/marker` unless a seed placed one, count every run. */
const INSTALL = [
  process.execPath,
  "-e",
  `const fs=require("fs");console.log("installing fixture packages");` +
    `fs.mkdirSync("deps",{recursive:true});fs.mkdirSync("logs",{recursive:true});` +
    `if(!fs.existsSync("deps/marker"))fs.writeFileSync("deps/marker",process.cwd());` +
    `fs.mkdirSync("more",{recursive:true});fs.writeFileSync("more/marker",process.cwd());` +
    `fs.appendFileSync("logs/runs","run\\n");`,
];

/**
 * A step that records its pid, prints a line, and waits for its gate file, then exits with the
 * code the gate holds. Without the gate it runs until it is killed.
 */
function gatedStep(gate: string, pidFile: string): string[] {
  return [
    process.execPath,
    "-e",
    `const fs=require("fs");fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      `console.log("waiting for the gate");` +
      `const wait=()=>{if(!fs.existsSync(${JSON.stringify(gate)}))return setTimeout(wait,25);` +
      `process.exit(Number(fs.readFileSync(${JSON.stringify(gate)},"utf8")))};wait();`,
  ];
}

const SEED = { paths: ["deps", "more"], exclude: [] as string[] };

function claimOf(argv: string[], seed: WorktreeClaim["seed"] | null = null): WorktreeClaim {
  return WorktreeClaimSchema.parse({
    steps: [{ argv }],
    fingerprintPaths: ["lock.txt"],
    ...(seed ? { seed } : {}),
  });
}

function repository(prefix: string): { origin: string; clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, ".gitignore"), "deps/\nmore/\nlogs/\n");
  writeFileSync(join(origin, "lock.txt"), "v1\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "lockfile");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

function advance(fixture: { origin: string }, content: string): string {
  writeFileSync(join(fixture.origin, "lock.txt"), content);
  gitIn(fixture.origin, "add", "-A");
  gitIn(fixture.origin, "commit", "-qm", "move the lockfile");
  return gitIn(fixture.origin, "rev-parse", "HEAD");
}

const copyClone: CloneTree = async (request) => {
  await cp(request.source, request.destination, { recursive: true, verbatimSymlinks: true });
  return { outcome: "cloned" };
};

/** A policy whose claim a test can change between operations. */
interface Policy {
  claim: WorktreeClaim | null;
}

function manager(policy: Policy, deps: Partial<WorktreeManagerDeps> = {}, maxSlots = 4): WorktreeManager {
  return new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots, setupArgv: null, claim: policy.claim }),
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: process.env, daemonToken: "warm-daemon-token", loginShell: {} }),
    cloneTree: copyClone,
    ...deps,
  });
}

function service(
  m: WorktreeManager,
  logs: string,
  extra: Partial<ConstructorParameters<typeof WorktreeOperationsService>[1]> = {},
): WorktreeOperationsService {
  return new WorktreeOperationsService(m, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(db, { manager: m, legacy: new LegacyTreehouseService(db) }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    claimVariablePresence: async () => [],
    warmLogsDirectory: logs,
    ...extra,
  });
}

function logsDirectory(): string {
  return join(mkdtempSync(join(tmpdir(), "mission-warm-logs-")), "logs", "worktree-warm");
}

/** `count` slots at `sha`, made without any claim and returned to the pool: available, never claimed. */
async function idleSlots(m: WorktreeManager, clone: string, sha: string, count: number): Promise<NativeWorktreeLease[]> {
  const held: NativeWorktreeLease[] = [];
  for (let index = 0; index < count; index += 1) {
    const acquired = await m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "manual", key: `setup-${index}` } });
    assert.equal(acquired.outcome, "acquired", JSON.stringify(acquired));
    if (acquired.outcome === "acquired") held.push(acquired.lease);
  }
  for (const lease of held) assert.equal((await m.release(lease, { ownerAuthorized: true })).outcome, "released");
  return held;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function operation(ops: WorktreeOperationsService, id: string): Promise<WorktreeOperationView> {
  const found = (await ops.inventory()).operations.find((entry) => entry.id === id);
  assert.ok(found, `operation ${id} is listed`);
  return found;
}

async function warm(
  ops: WorktreeOperationsService,
  target: { kind: "slot"; slotId: string } | { kind: "pool"; poolId: string },
): Promise<string> {
  const preview = await ops.preview({ action: "warm", target });
  assert.equal(preview.allowed, true, preview.blockers.join("; "));
  assert.deepEqual(preview.requiredAcknowledgements, [], "nothing in a Warm needs an acknowledgement");
  return ops.submit(preview.token, []).operation.id;
}

/** A served Warm log's whole text, read through the stream the route sends. */
async function logText(ops: WorktreeOperationsService, id: string): Promise<string | null> {
  const log = await ops.warmLog(id);
  if (!log) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of log.stream) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks);
  assert.equal(text.length, log.size, "the stream carries exactly the size it was served with");
  return text.toString("utf8");
}

function runCount(path: string): number {
  const file = join(path, "logs", "runs");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
}

/** A claim step's process that outlived the daemon that started it, still inside the slot. */
function orphan(cwd: string): WorktreeOccupant {
  return { pid: 4242, ppid: 1, startRaw: "", startMs: 0, command: "node install.js", cwd, knownOwner: null };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- targeting ----

test("Warm targets only idle slots, says what a pool Warm leaves alone, and needs a claim", async () => {
  const fixture = repository("mission-warm-target-");
  const policy: Policy = { claim: claimOf(INSTALL) };
  const m = manager(policy);
  const [first, quarantined, idle] = await idleSlots(m, fixture.clone, fixture.sha, 3);
  db.prepare("UPDATE worktree_slots SET state = 'quarantined', quarantine_reason = 'test' WHERE id = ?").run(quarantined!.slotId);
  // Acquisition takes the lowest idle slot, so this leaves the third one idle.
  const busy = await m.acquire({ repositoryPath: fixture.clone, baseSha: fixture.sha, owner: { kind: "manual", key: "busy" } });
  assert.equal(busy.outcome, "acquired");
  if (busy.outcome !== "acquired") return;
  assert.equal(busy.lease.slotId, first!.slotId);
  const ops = service(m, logsDirectory());

  const pool = await ops.preview({ action: "warm", target: { kind: "pool", poolId: idle!.poolId } });
  assert.equal(pool.allowed, true, pool.blockers.join("; "));
  assert.deepEqual(pool.affected.map((target) => target.id), [idle!.slotId]);
  assert.match(pool.consequences.join(" "), /2 slots are left alone: .*is quarantined.*is leased/);
  assert.match(pool.consequences.join(" "), /A slot leased before its turn comes is skipped and listed as skipped/);

  for (const target of [busy.lease, quarantined!]) {
    const refused = await ops.preview({ action: "warm", target: { kind: "slot", slotId: target.slotId } });
    assert.equal(refused.allowed, false);
    assert.match(refused.blockers.join(" "), /Warm never touches a slot that is leased, quarantined or changing/);
  }

  const cards = (await ops.inventory()).repositories.flatMap((repo) => repo.slots);
  assert.ok(cards.find((card) => card.id === idle!.slotId)?.actions.includes("warm"));
  assert.ok(!cards.find((card) => card.id === busy.lease.slotId)?.actions.includes("warm"));
  assert.ok(!cards.find((card) => card.id === quarantined!.slotId)?.actions.includes("warm"));

  // With no claim there is nothing to warm, and no card offers it.
  policy.claim = null;
  const unclaimed = await ops.preview({ action: "warm", target: { kind: "slot", slotId: idle!.slotId } });
  assert.equal(unclaimed.allowed, false);
  assert.match(unclaimed.blockers.join(" "), /no dependency claim configured/);
  const plain = (await ops.inventory()).repositories.flatMap((repo) => repo.slots);
  assert.ok(!plain.some((card) => card.actions.includes("warm")));
  await m.release(busy.lease, { ownerAuthorized: true });
});

// ---- the happy path ----

test("Warm holds the slot, resets it to origin's default, claims, returns it, and keeps its log", async () => {
  const fixture = repository("mission-warm-run-");
  const m = manager({ claim: claimOf(INSTALL) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  const moved = advance(fixture, "v2\n");
  const logs = logsDirectory();
  const ops = service(m, logs);

  const first = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  assert.equal((await operation(ops, first)).state === "queued" || (await operation(ops, first)).state === "running", true);
  await ops.idle();

  const row = m.store.slot(slot!.slotId)!;
  assert.equal(row.state, "available");
  assert.equal(row.currentHeadSha, moved, "reset to origin's current default branch");
  assert.equal(row.depsState, "current");
  assert.equal(row.depsFingerprintSha, moved);
  assert.equal(row.lastReleasedOwnerKind, "warm");
  assert.equal(row.lastReleasedOwnerKey, first);
  assert.equal(runCount(row.path), 1);
  assert.equal(m.warmOwnerLive(first), false, "the warm owner is referenced only while its operation runs");

  const view = await operation(ops, first);
  assert.equal(view.state, "finished");
  assert.equal(view.warm?.targets[0]?.outcome, "warmed");
  assert.match(view.warm?.tail ?? "", /^installing fixture packages$/m);
  const logPath = join(logs, `${first}.log`);
  assert.deepEqual(view.warm?.log, { id: first, path: logPath });
  assert.equal(row.depsLogPath, logPath);
  const text = readFileSync(logPath, "utf8");
  assert.match(text, /Warming slot 1 at /);
  assert.match(text, /Fetching origin's default branch/);
  assert.match(text, /^installing fixture packages$/m);
  assert.match(text, /Returning the slot to the pool/);
  assert.match(text, /Slot 1: warmed/);
  assert.equal(await logText(ops, first), text);

  const card = (await ops.inventory()).repositories.flatMap((repo) => repo.slots).find((entry) => entry.id === slot!.slotId);
  assert.deepEqual(card?.warmLog, { id: first, path: logPath });
  assert.equal(card?.dependencies?.state, "current");

  // A second Warm finds the fingerprint current and runs no step. Its log replaces the first.
  const second = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  await ops.idle();
  assert.equal(runCount(row.path), 1, "a slot that already matches pays nothing");
  assert.match((await operation(ops, second)).warm?.targets[0]?.detail ?? "", /already matched; no step ran/);
  assert.equal(m.store.slot(slot!.slotId)!.depsLogPath, join(logs, `${second}.log`));
  assert.equal(ops.dismiss(first), true, "a finished Warm can be dismissed");
  await ops.sweepWarmLogs();
  assert.equal(existsSync(logPath), false, "a log no operation and no slot names is removed");
  assert.equal(existsSync(join(logs, `${second}.log`)), true);
  assert.equal(await ops.warmLog(first), null);
});

test("a slot leased while Warm idle slots is queued is skipped and listed as skipped", async () => {
  const fixture = repository("mission-warm-skip-");
  const dir = mkdtempSync(join(tmpdir(), "mission-warm-gate-"));
  const gate = join(dir, "gate");
  const m = manager({ claim: claimOf(gatedStep(gate, join(dir, "pid"))) });
  const [first] = await idleSlots(m, fixture.clone, fixture.sha, 3);
  const logs = logsDirectory();
  const ops = service(m, logs);

  // The first Warm holds its slot on the gate, so the pool Warm queues behind it.
  const holding = await warm(ops, { kind: "slot", slotId: first!.slotId });
  await waitFor(async () => /^waiting for the gate$/m.test((await operation(ops, holding)).warm?.tail ?? ""), "the first Warm's step");
  const labels = (await ops.inventory()).repositories.flatMap((repo) => repo.slots).find((slot) => slot.id === first!.slotId);
  assert.equal(labels?.owner?.label, "Warming this slot ahead of time");
  assert.equal(m.warmOwnerLive(holding), true);

  const pool = await warm(ops, { kind: "pool", poolId: first!.poolId });
  const queued = await operation(ops, pool);
  assert.equal(queued.state, "queued");
  assert.equal(queued.warm?.targets.length, 2, "the slot the first Warm holds is not a target");

  // Something else leases one of them before the pool Warm's turn comes.
  const taken = await m.acquire({ repositoryPath: fixture.clone, baseSha: fixture.sha, owner: { kind: "manual", key: "late" } });
  assert.equal(taken.outcome, "acquired");
  if (taken.outcome !== "acquired") return;
  writeFileSync(gate, "0");
  await ops.idle();

  const done = await operation(ops, pool);
  assert.equal(done.state, "finished");
  const skipped = done.warm!.targets.find((target) => target.slotId === taken.lease.slotId);
  const warmed = done.warm!.targets.find((target) => target.slotId !== taken.lease.slotId);
  assert.equal(skipped?.outcome, "skipped");
  assert.match(skipped?.detail ?? "", /leased/);
  assert.equal(warmed?.outcome, "warmed");
  const row = m.store.slot(taken.lease.slotId)!;
  assert.equal(row.state, "leased");
  assert.equal(row.activeOwnerKey, "late", "Warm never touched the leased slot");
  assert.equal(row.depsState, null);

  // Acquisition took the lowest idle slot, the pool Warm's first target, so that slot was
  // skipped before the Warm held anything and its log opened. The log still records it, first.
  assert.equal(done.warm!.targets[0]!.slotId, taken.lease.slotId);
  const text = readFileSync(join(logs, `${pool}.log`), "utf8");
  const skippedLine = text.indexOf(`Slot ${skipped!.ordinal}: skipped.`);
  const warmedLine = text.indexOf(`Warming slot ${warmed!.ordinal} at `);
  assert.ok(skippedLine > 0, "the skipped slot's result reaches the log");
  assert.ok(warmedLine > skippedLine, "in the order it happened, after the header");
  assert.match(text, new RegExp(`^Slot ${warmed!.ordinal}: warmed$`, "m"));
  await m.release(taken.lease, { ownerAuthorized: true });
});

test("a pool Warm cancelled mid-step logs the slot it never reached", async () => {
  const fixture = repository("mission-warm-cancel-log-");
  const dir = mkdtempSync(join(tmpdir(), "mission-warm-gate-"));
  const m = manager({ claim: claimOf(gatedStep(join(dir, "never"), join(dir, "pid"))) });
  const [first, second] = await idleSlots(m, fixture.clone, fixture.sha, 2);
  const logs = logsDirectory();
  const ops = service(m, logs);
  const id = await warm(ops, { kind: "pool", poolId: first!.poolId });
  await waitFor(async () => /^waiting for the gate$/m.test((await operation(ops, id)).warm?.tail ?? ""), "the first slot's step");
  assert.equal(ops.cancel(id), true);
  await ops.idle();

  const view = await operation(ops, id);
  assert.deepEqual(view.warm?.targets.map((target) => target.outcome), ["cancelled", "cancelled"]);
  const text = readFileSync(join(logs, `${id}.log`), "utf8");
  const ordinal = m.store.slot(second!.slotId)!.ordinal;
  assert.match(text, new RegExp(`^Slot ${ordinal}: cancelled\\. cancelled before its turn$`, "m"));
  assert.match(view.warm?.tail ?? "", new RegExp(`Slot ${ordinal}: cancelled\\. cancelled before its turn`));
});

// ---- Cancel ----

test("Cancel during a step kills its process group and returns the slot with a failed claim", async () => {
  const fixture = repository("mission-warm-cancel-step-");
  const dir = mkdtempSync(join(tmpdir(), "mission-warm-gate-"));
  const pidFile = join(dir, "pid");
  const m = manager({ claim: claimOf(gatedStep(join(dir, "never"), pidFile)) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  const ops = service(m, logsDirectory());
  const id = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  await waitFor(async () => /^waiting for the gate$/m.test((await operation(ops, id)).warm?.tail ?? ""), "the step")
    .catch(async (error: unknown) => {
      throw new Error(`${String(error)}: ${JSON.stringify(await operation(ops, id))}`);
    });
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.equal(alive(pid), true);

  assert.equal(ops.cancel(id), true);
  assert.equal((await operation(ops, id)).warm?.cancelRequested, true);
  await ops.idle();

  assert.equal(alive(pid), false, "the step's process group was killed");
  const row = m.store.slot(slot!.slotId)!;
  assert.equal(row.state, "available", "the slot is back in the pool");
  assert.equal(row.depsState, "failed", "a Cancel during a step is a failed claim, the Stop rule");
  assert.equal(row.depsFingerprint, null);
  const view = await operation(ops, id);
  assert.equal(view.state, "finished");
  assert.equal(view.warm?.targets[0]?.outcome, "cancelled");
  assert.match(view.warm?.tail ?? "", /Step 1 of 1 was stopped/);
  assert.equal(ops.cancel(id), false, "a finished Warm cannot be cancelled");
});

test("Cancel during a seed returns the slot interrupted, so its next claim starts cold", async () => {
  const fixture = repository("mission-warm-cancel-seed-");
  const policy: Policy = { claim: claimOf(INSTALL, SEED) };
  let ops!: WorktreeOperationsService;
  let opId = "";
  const m = manager(policy, {
    // Cancelled once `deps` is renamed into the target, before `more`.
    afterSeedRename: (path) => {
      if (path === "deps" && opId) ops.cancel(opId);
    },
  });
  // Two slots claimed for real, so each is an idle sibling with a current fingerprint.
  const held = [];
  for (const key of ["a", "b"]) {
    const acquired = await m.acquire({ repositoryPath: fixture.clone, baseSha: fixture.sha, owner: { kind: "task", key: `${key}:0` }, runClaim: true });
    assert.equal(acquired.outcome, "acquired");
    if (acquired.outcome === "acquired") held.push(acquired.lease);
  }
  for (const lease of held) await m.release(lease, { ownerAuthorized: true });
  const target = held[0]!;
  db.prepare("UPDATE worktree_slots SET deps_state = 'failed', deps_fingerprint = NULL WHERE id = ?").run(target.slotId);
  ops = service(m, logsDirectory());

  opId = await warm(ops, { kind: "slot", slotId: target.slotId });
  await ops.idle();

  const row = m.store.slot(target.slotId)!;
  assert.equal(row.state, "available");
  assert.equal(row.depsState, "interrupted", "a Cancel during a seed leaves the seed paths untrusted");
  assert.equal(row.depsFingerprint, null);
  const view = await operation(ops, opId);
  assert.equal(view.warm?.targets[0]?.outcome, "cancelled");
  assert.match(view.warm?.tail ?? "", /Seeding copy-on-write from the idle sibling/);
  assert.equal(m.store.slot(held[1]!.slotId)!.state, "available", "the source went back to the pool");
  assert.equal(m.store.slot(held[1]!.slotId)!.depsState, "current");
});

/**
 * A step that rewrites the tracked `lock.txt` and leaves an untracked, unignored file before it
 * waits on its gate, as a misbehaving install might.
 */
function dirtyingStep(gate: string, pidFile: string): string[] {
  return [
    process.execPath,
    "-e",
    `const fs=require("fs");fs.writeFileSync("lock.txt","rewritten by the step\\n");` +
      `fs.writeFileSync("stray.txt","left by the step\\n");` +
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log("waiting for the gate");` +
      `const wait=()=>{if(!fs.existsSync(${JSON.stringify(gate)}))return setTimeout(wait,25);` +
      `process.exit(Number(fs.readFileSync(${JSON.stringify(gate)},"utf8")))};wait();`,
  ];
}

test("Cancel returns the slot available even when the stopped step changed tracked files", async () => {
  const fixture = repository("mission-warm-cancel-dirty-");
  const dir = mkdtempSync(join(tmpdir(), "mission-warm-gate-"));
  const pidFile = join(dir, "pid");
  const m = manager({ claim: claimOf(dirtyingStep(join(dir, "never"), pidFile)) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  const ops = service(m, logsDirectory());
  const id = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  await waitFor(async () => /^waiting for the gate$/m.test((await operation(ops, id)).warm?.tail ?? ""), "the step");
  assert.equal(readFileSync(join(slot!.path, "lock.txt"), "utf8"), "rewritten by the step\n");
  const pid = Number(readFileSync(pidFile, "utf8"));

  assert.equal(ops.cancel(id), true);
  await ops.idle();

  assert.equal(alive(pid), false, "the step's process group was killed");
  const row = m.store.slot(slot!.slotId)!;
  assert.equal(row.state, "available", "Cancel returns the slot, not a quarantine");
  assert.equal(row.depsState, "failed", "a Cancel during a step follows the Stop rule");
  assert.equal(readFileSync(join(slot!.path, "lock.txt"), "utf8"), "v1\n", "the return's reset discarded the tracked change");
  assert.equal(existsSync(join(slot!.path, "stray.txt")), false, "and the untracked file");
  assert.equal(gitIn(slot!.path, "status", "--porcelain=v1", "--untracked-files=all"), "", "the returned tree is clean");
  const view = await operation(ops, id);
  assert.equal(view.warm?.targets[0]?.outcome, "cancelled");
  assert.match(view.warm?.tail ?? "", /^Returning the slot to the pool, discarding what the stopped step changed$/m);
});

test("a claim that dirties tracked files and finishes on its own is still quarantined, as at acquisition", async () => {
  const fixture = repository("mission-warm-dirty-claim-");
  const dir = mkdtempSync(join(tmpdir(), "mission-warm-gate-"));
  const gate = join(dir, "gate");
  writeFileSync(gate, "0");
  const m = manager({ claim: claimOf(dirtyingStep(gate, join(dir, "pid"))) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  const ops = service(m, logsDirectory());
  const id = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  await ops.idle();
  const row = m.store.slot(slot!.slotId)!;
  assert.equal(row.state, "quarantined", "nothing stopped this claim, so its tracked changes fail the proof");
  assert.equal(row.quarantineReason, "warmed slot verification failed");
  assert.equal((await operation(ops, id)).warm?.targets[0]?.outcome, "failed");
});

test("Cancel on a queued Warm finishes it with every target cancelled and touches nothing", async () => {
  const fixture = repository("mission-warm-cancel-queued-");
  const dir = mkdtempSync(join(tmpdir(), "mission-warm-gate-"));
  const gate = join(dir, "gate");
  const m = manager({ claim: claimOf(gatedStep(gate, join(dir, "pid"))) });
  const [first, second] = await idleSlots(m, fixture.clone, fixture.sha, 2);
  const ops = service(m, logsDirectory());
  const running = await warm(ops, { kind: "slot", slotId: first!.slotId });
  await waitFor(async () => (await operation(ops, running)).state === "running", "the first Warm to start");
  const queued = await warm(ops, { kind: "slot", slotId: second!.slotId });
  assert.equal(ops.cancel(queued), true);
  const cancelled = await operation(ops, queued);
  assert.equal(cancelled.state, "finished");
  assert.deepEqual(cancelled.warm?.targets.map((target) => target.outcome), ["cancelled"]);
  assert.equal(cancelled.warm?.log, null, "a Warm that never held a slot writes no log");
  writeFileSync(gate, "0");
  await ops.idle();
  const row = m.store.slot(second!.slotId)!;
  assert.equal(row.state, "available");
  assert.equal(row.depsState, null);
  assert.notEqual(row.lastReleasedOwnerKind, "warm");
});

// ---- crash and restart ----

test("startup returns a slot a crashed Warm held mid-step as interrupted, and quarantines it on doubt", async () => {
  for (const doubt of [false, true]) {
    const fixture = repository(`mission-warm-crash-step-${doubt}-`);
    const policy: Policy = { claim: claimOf(INSTALL) };
    // The step never settles: the daemon that runs it is about to "crash".
    const crashed = manager(policy, { runClaimStep: () => new Promise(() => {}) });
    const [slot] = await idleSlots(crashed, fixture.clone, fixture.sha, 1);
    const ops = service(crashed, logsDirectory());
    void warm(ops, { kind: "slot", slotId: slot!.slotId });
    await waitFor(() => {
      const row = crashed.store.slot(slot!.slotId);
      return row?.state === "leased" && row.depsState === "claiming";
    }, "the Warm's write-ahead");
    assert.equal(crashed.store.slot(slot!.slotId)!.activeOwnerKind, "warm");

    const restarted = manager(policy, doubt
      ? { occupancy: async (paths) => new Map(paths.map((path) => [path, { status: "known" as const, occupants: [orphan(path)] }])) }
      : {});
    await restarted.reconcile();
    const row = restarted.store.slot(slot!.slotId)!;
    assert.equal(row.depsState, "interrupted", "the write-ahead is recorded as interrupted either way");
    assert.equal(row.depsFingerprint, null);
    if (doubt) {
      assert.equal(row.state, "quarantined", "an orphaned process still in the slot is doubt");
    } else {
      assert.equal(row.state, "available", "the ordinary return path returned it");
      assert.equal(row.lastReleasedOwnerKind, "warm");
      assert.equal(row.currentHeadSha, fixture.sha);
    }
    // The "crashed" daemon is still this process: let its claim go, as a shutdown would.
    crashed.stopClaims();
    db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools;");
  }
});

test("startup returns a crashed seed's target as interrupted and its held source with its fingerprint", async () => {
  for (const phase of ["between renames", "mid-copy"] as const) {
    const fixture = repository(`mission-warm-crash-seed-${phase.replace(" ", "-")}-`);
    const policy: Policy = { claim: claimOf(INSTALL, SEED) };
    const setup = manager(policy);
    const held = [];
    for (const key of ["a", "b"]) {
      const acquired = await setup.acquire({ repositoryPath: fixture.clone, baseSha: fixture.sha, owner: { kind: "task", key: `${key}:0` }, runClaim: true });
      assert.equal(acquired.outcome, "acquired");
      if (acquired.outcome === "acquired") held.push(acquired.lease);
    }
    for (const lease of held) await setup.release(lease, { ownerAuthorized: true });
    const [target, source] = held;
    db.prepare("UPDATE worktree_slots SET deps_state = 'failed', deps_fingerprint = NULL WHERE id = ?").run(target!.slotId);
    const sourceFingerprint = setup.store.slot(source!.slotId)!.depsFingerprint;
    assert.ok(sourceFingerprint);

    // The crash point is reached, and nothing after it ever runs.
    let reached = false;
    const hang = (): Promise<never> => {
      reached = true;
      return new Promise(() => {});
    };
    const crashed = manager(policy, phase === "mid-copy" ? { cloneTree: hang } : { afterSeedRename: hang });
    const ops = service(crashed, logsDirectory());
    void warm(ops, { kind: "slot", slotId: target!.slotId });
    await waitFor(() => reached, `the crash point ${phase}`);
    assert.equal(crashed.store.slot(target!.slotId)?.depsState, "seeding");
    assert.equal(crashed.store.slot(target!.slotId)?.activeOwnerKind, "warm");
    if (phase === "mid-copy") assert.equal(crashed.store.slot(source!.slotId)?.activeOwnerKind, "warm", "the source is held");

    const restarted = manager(policy);
    await restarted.reconcile();
    const targetRow = restarted.store.slot(target!.slotId)!;
    assert.equal(targetRow.state, "available", `${phase}: the target is returned`);
    assert.equal(targetRow.depsState, "interrupted", `${phase}: and its next claim starts cold`);
    const sourceRow = restarted.store.slot(source!.slotId)!;
    assert.equal(sourceRow.state, "available", `${phase}: the source is returned`);
    assert.equal(sourceRow.depsState, "current", `${phase}: a source was only read`);
    assert.equal(sourceRow.depsFingerprint, sourceFingerprint);
    // The "crashed" daemon is still this process. A hung clone races the claim's deadline, and
    // that timer would hold the test open for the claim's whole limit: stop it, as a shutdown would.
    crashed.stopClaims();
    db.exec("DELETE FROM worktree_slots; DELETE FROM worktree_pools;");
  }
});

test("the Warm log sweep keeps only the logs a listed operation or a slot row names", async () => {
  const fixture = repository("mission-warm-logs-");
  const m = manager({ claim: claimOf(INSTALL) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  const logs = logsDirectory();
  mkdirSync(logs, { recursive: true });
  const named = join(logs, "named-op.log");
  const orphan = join(logs, "orphan-op.log");
  const other = join(logs, "notes.txt");
  for (const path of [named, orphan, other]) writeFileSync(path, "left by an earlier daemon\n");
  db.prepare("UPDATE worktree_slots SET deps_log_path = ? WHERE id = ?").run(named, slot!.slotId);

  // A restarted daemon: no operation is listed, so only what a slot row names survives.
  const ops = service(m, logs);
  await ops.sweepWarmLogs();
  assert.equal(existsSync(named), true);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(other), true, "only Warm logs are this sweep's to remove");
  assert.equal(await logText(ops, "named-op"), "left by an earlier daemon\n");
  assert.equal(await ops.warmLog("orphan-op"), null);
  assert.equal(await ops.warmLog("../named-op"), null, "an id never names a path outside the log directory");
  const card = (await ops.inventory()).repositories.flatMap((repo) => repo.slots).find((entry) => entry.id === slot!.slotId);
  assert.deepEqual(card?.warmLog, { id: "named-op", path: named }, "the slot card reaches its log after a restart");
});

test("destroying the last slot that names a dismissed Warm's log removes the log", async () => {
  const fixture = repository("mission-warm-destroy-log-");
  const m = manager({ claim: claimOf(INSTALL) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  const logs = logsDirectory();
  const ops = service(m, logs);
  const id = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  await ops.idle();
  const logPath = join(logs, `${id}.log`);

  // Dismissed while the slot still names it: kept, and still reachable from the slot card.
  assert.equal(ops.dismiss(id), true);
  await ops.sweepWarmLogs();
  assert.equal(existsSync(logPath), true);
  assert.equal(m.store.slot(slot!.slotId)!.depsLogPath, logPath);

  // Destroying that slot removes the last row naming the log, and the destroy itself sweeps it.
  const destroy = await ops.preview({ action: "destroy", target: { kind: "slot", slotId: slot!.slotId } });
  assert.equal(destroy.allowed, true, destroy.blockers.join("; "));
  ops.submit(destroy.token, destroy.requiredAcknowledgements);
  await ops.idle();
  assert.equal(m.store.slot(slot!.slotId), null);
  assert.equal(existsSync(logPath), false, "a log no operation and no slot names is removed");
});

test("a running Warm's output bumps the worktrees revision at most once per interval", async () => {
  const fixture = repository("mission-warm-throttle-");
  // About a hundred separate writes over half a second.
  const chatty = [
    process.execPath,
    "-e",
    `let n=0;const t=setInterval(()=>{process.stdout.write("line "+(n++)+"\\n");if(n>=100){clearInterval(t)}},5);`,
  ];
  const m = manager({ claim: claimOf(chatty) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  let bumps = 0;
  const ops = service(m, logsDirectory(), { notifyChanged: () => { bumps += 1; }, warmTailIntervalMs: 1_000 });
  const id = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  await ops.idle();
  const view = await operation(ops, id);
  assert.match(view.warm?.tail ?? "", /line 99/);
  assert.ok(bumps <= 10, `${bumps} bumps for about a hundred writes`);
});

test("a Warm's tail bumps the revision once at each interval boundary and never sooner", async (t) => {
  const fixture = repository("mission-warm-boundary-");
  const m = manager({ claim: claimOf(INSTALL) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  // The Warm itself is held open, so the only bumps from here on are the tail's.
  let output!: (text: string) => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    m.warmSlot = async (input: Parameters<WorktreeManager["warmSlot"]>[0]) => {
      output = input.output;
      resolve();
      await new Promise<void>((done) => {
        finish = done;
      });
      return { outcome: "warmed", stepsSkipped: false };
    };
  });
  let bumps = 0;
  const ops = service(m, logsDirectory(), { notifyChanged: () => { bumps += 1; } });
  const id = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  await entered;

  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const before = bumps;
    output("one\n");
    output("two\n");
    t.mock.timers.tick(999);
    output("three\n");
    assert.equal(bumps, before, "writes before the interval ends bump nothing");
    t.mock.timers.tick(1);
    assert.equal(bumps, before + 1, "exactly one bump at the 1,000 ms boundary, for all three writes");

    output("four\n");
    t.mock.timers.tick(500);
    output("five\n");
    output("six\n");
    t.mock.timers.tick(499);
    assert.equal(bumps, before + 1, "the next interval's writes wait for its own boundary");
    t.mock.timers.tick(1);
    assert.equal(bumps, before + 2, "and then bump once");

    t.mock.timers.tick(10_000);
    assert.equal(bumps, before + 2, "with no output there is no bump");
  } finally {
    t.mock.timers.reset();
  }
  finish();
  await ops.idle();
  assert.match((await operation(ops, id)).warm?.tail ?? "", /one\ntwo\nthree\nfour\nfive\nsix\n/);
});

test("an ordinary claim failure returns the slot available with failed dependencies, and keeps the failure", async () => {
  const fixture = repository("mission-warm-claim-failed-");
  const failing = [
    process.execPath,
    "-e",
    `console.log("resolving fixture packages");console.error("E401 fixture registry refused the token");process.exit(3);`,
  ];
  const m = manager({ claim: claimOf(failing) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  const logs = logsDirectory();
  const ops = service(m, logs);
  const id = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  await ops.idle();

  const row = m.store.slot(slot!.slotId)!;
  assert.equal(row.state, "available", "a failed claim never keeps or quarantines the slot");
  assert.equal(row.depsState, "failed");
  assert.equal(row.depsFingerprint, null, "so the next lease runs the claim again");
  assert.equal(row.lastReleasedOwnerKind, "warm");
  assert.match(row.depsLastError ?? "", /exited with code 3/);
  assert.match(row.depsLastError ?? "", /E401 fixture registry refused the token/);

  const view = await operation(ops, id);
  assert.equal(view.state, "finished", "a claim failure is the Warm's result, not the operation failing");
  assert.equal(view.warm?.cancelRequested, false);
  assert.equal(view.warm?.targets[0]?.outcome, "claimFailed");
  assert.equal(view.warm?.targets[0]?.detail, "Step 1 of 1 exited with code 3.");
  assert.match(view.warm?.tail ?? "", /^E401 fixture registry refused the token$/m);

  const logPath = join(logs, `${id}.log`);
  const text = readFileSync(logPath, "utf8");
  assert.match(text, /^E401 fixture registry refused the token$/m);
  assert.match(text, /^Step 1 of 1 exited with code 3\.$/m);
  assert.match(text, /^Returning the slot to the pool$/m);
  assert.match(text, /^Slot 1: claimFailed\. Step 1 of 1 exited with code 3\.$/m);

  const card = (await ops.inventory()).repositories.flatMap((repo) => repo.slots).find((entry) => entry.id === slot!.slotId);
  assert.equal(card?.dependencies?.state, "failed");
  if (card?.dependencies?.state === "failed") {
    assert.equal(card.dependencies.failure.reason, "exited with code 3");
    assert.match(card.dependencies.failure.tail, /E401 fixture registry refused the token/);
  }
  assert.deepEqual(card?.warmLog, { id, path: logPath });
});

// ---- one idle rule ----

test("the Warm preview, the slot card and acquisition judge idleness by the same rule", async () => {
  const fixture = repository("mission-warm-idle-rule-");
  const m = manager({ claim: claimOf(INSTALL) });
  const [dirty, referenced] = await idleSlots(m, fixture.clone, fixture.sha, 2);
  // An untracked, unignored file: acquisition quarantines such a slot.
  writeFileSync(join(dirty!.path, "stray.txt"), "left behind\n");
  // A slot whose last owner still references it: acquisition leaves it alone, unquarantined.
  const stillReferenced = manager({ claim: claimOf(INSTALL) }, {
    ownerReferenced: async (reference) => reference.slotId === referenced!.slotId,
  });
  const ops = service(stillReferenced, logsDirectory());

  const cards = (await ops.inventory()).repositories.flatMap((repo) => repo.slots);
  for (const card of cards) assert.ok(!card.actions.includes("warm"), `slot ${card.ordinal} is not idle, so no card offers Warm`);
  const dirtyPreview = await ops.preview({ action: "warm", target: { kind: "slot", slotId: dirty!.slotId } });
  assert.equal(dirtyPreview.allowed, false);
  assert.deepEqual(dirtyPreview.blockers, ["Slot 1 is not idle: available slot has dirty or untracked work."]);
  const referencedPreview = await ops.preview({ action: "warm", target: { kind: "slot", slotId: referenced!.slotId } });
  assert.deepEqual(referencedPreview.blockers, ["Slot 2 is not idle: its last owner still references it."]);

  // Acquisition, under the same rule, quarantines the dirty slot with the reason the preview
  // gave, leaves the referenced one available, and makes a new slot instead.
  const acquired = await stillReferenced.acquire({ repositoryPath: fixture.clone, baseSha: fixture.sha, owner: { kind: "manual", key: "after" } });
  assert.equal(acquired.outcome, "acquired");
  if (acquired.outcome !== "acquired") return;
  assert.notEqual(acquired.lease.slotId, dirty!.slotId);
  assert.notEqual(acquired.lease.slotId, referenced!.slotId);
  const dirtyRow = stillReferenced.store.slot(dirty!.slotId)!;
  assert.equal(dirtyRow.state, "quarantined");
  assert.equal(dirtyRow.quarantineReason, "available slot has dirty or untracked work");
  assert.equal(stillReferenced.store.slot(referenced!.slotId)!.state, "available");
  await stillReferenced.release(acquired.lease, { ownerAuthorized: true });
});

// ---- backpressure and bounded reads of the full log ----

test("a claim step's output pauses its pipes while the reader asks it to wait, and loses nothing", async () => {
  const lines = 4_000;
  // Far more than a pipe holds, so the child really blocks while its reader waits.
  const argv = [
    process.execPath,
    "-e",
    `const line="x".repeat(1023)+"\\n";for(let i=0;i<${lines};i+=1)process.stdout.write(line);`,
  ];
  let calls = 0;
  let received = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = runClaimStep({
    argv,
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onOutput: (text) => {
      calls += 1;
      received += Buffer.byteLength(text, "utf8");
      // The first piece holds the step until the gate opens.
      return calls === 1 ? gate : undefined;
    },
  });
  await waitFor(() => calls >= 1, "the first piece of output");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(calls, 1, "nothing more is read while the reader is waiting");
  release();
  const result = await running;
  assert.equal(result.outcome, "exited");
  if (result.outcome === "exited") assert.equal(result.code, 0);
  assert.equal(received, lines * 1024, "every byte arrived once the reader caught up");
});

test("a full Warm log asks the writer to wait until it drains, and keeps every byte", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-warm-log-file-"));
  const log = new WarmLogFile("op", join(dir, "logs", "op.log"), () => "header\n");
  log.open();
  assert.equal(log.write("small\n"), undefined, "a write the buffer takes needs no wait");
  const big = "y".repeat(4 * 1024 * 1024);
  const wait = log.write(big);
  assert.ok(wait instanceof Promise, "a write past the buffer returns backpressure");
  await wait;
  await log.close();
  assert.equal(readFileSync(join(dir, "logs", "op.log"), "utf8"), `header\nsmall\n${big}`);
});

test("a Warm log keeps what was recorded before it opened, and a log that never opens writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-warm-log-early-"));
  const log = new WarmLogFile("op", join(dir, "logs", "op.log"), () => "header\n");
  assert.equal(log.write("Slot 1: skipped. the slot was leased by something else first\n"), undefined);
  assert.equal(existsSync(join(dir, "logs", "op.log")), false, "nothing is written before the log opens");
  log.open();
  log.write("Warming slot 2\n");
  await log.close();
  assert.equal(
    readFileSync(join(dir, "logs", "op.log"), "utf8"),
    "header\nSlot 1: skipped. the slot was leased by something else first\nWarming slot 2\n",
    "the early result follows the header, ahead of what came after",
  );

  const never = new WarmLogFile("none", join(dir, "logs", "none.log"), () => "header\n");
  never.write("Slot 1: skipped. the slot is leased\n");
  await never.close();
  assert.equal(existsSync(join(dir, "logs", "none.log")), false, "a Warm that held no slot writes no log");
});

test("a Warm with a lot of output keeps it all in its log, and a download streams a fixed length", async () => {
  const fixture = repository("mission-warm-big-log-");
  const lines = 20_000;
  const chatty = [
    process.execPath,
    "-e",
    `for(let i=0;i<${lines};i+=1)process.stdout.write("package line "+i+" "+"z".repeat(200)+"\\n");`,
  ];
  const m = manager({ claim: claimOf(chatty) });
  const [slot] = await idleSlots(m, fixture.clone, fixture.sha, 1);
  const logs = logsDirectory();
  const ops = service(m, logs);
  const id = await warm(ops, { kind: "slot", slotId: slot!.slotId });
  await ops.idle();
  const text = readFileSync(join(logs, `${id}.log`), "utf8");
  const logged = text.split("\n").filter((line) => line.startsWith("package line ")).length;
  assert.equal(logged, lines, "the full log is complete");
  assert.equal(m.store.slot(slot!.slotId)!.depsState, "current");

  // A download streams exactly the bytes the log held when it was opened, even while it grows.
  const served = await ops.warmLog(id);
  assert.ok(served);
  writeFileSync(join(logs, `${id}.log`), "appended after the download began\n", { flag: "a" });
  const chunks: Buffer[] = [];
  for await (const chunk of served.stream) chunks.push(Buffer.from(chunk as Buffer));
  assert.ok(chunks.length > 1, "the log arrives in bounded chunks, never as one buffer");
  assert.equal(Buffer.concat(chunks).toString("utf8"), text);
});

// ---- redaction of streamed output ----

test("a value split across two stdout writes is redacted even when stderr lands between its halves", async () => {
  const value = "s3cr3t-token-value-0123456789";
  const half = Math.floor(value.length / 2);
  let streamed = "";
  const outcome = await runClaimSteps({
    claim: WorktreeClaimSchema.parse({ steps: [{ argv: ["install"], env: ["A_TOKEN"] }], fingerprintPaths: [] }),
    cwd: process.cwd(),
    signal: new AbortController().signal,
    environment: async () => ({ env: { A_TOKEN: value }, received: ["A_TOKEN"], missing: [] }),
    // The pipes interleave as they arrive: stdout's first half, a stderr line, stdout's second half.
    runStep: async (request) => {
      await request.onOutput?.(`token=${value.slice(0, half)}`, "stdout");
      await request.onOutput?.("warning: progress from stderr\n", "stderr");
      await request.onOutput?.(`${value.slice(half)}\ndone\n`, "stdout");
      return { outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 };
    },
    now: Date.now,
    onOutput: (text) => {
      streamed += text;
    },
  });
  assert.equal(outcome.ok, true);
  assert.match(streamed, /token=\[A_TOKEN redacted\]/, "stdout's value is redacted as one value");
  assert.match(streamed, /warning: progress from stderr/, "stderr's output still arrives");
  assert.match(streamed, /done/);
  assert.ok(!streamed.includes(value.slice(0, half)), "the first half never reaches the view");
  assert.ok(!streamed.includes(value.slice(half)), "nor the second");
});

test("streamed claim output never carries a value, however the pipe splits it", () => {
  const secrets = [{ name: "A_TOKEN", value: "s3cr3t-value-123" }, { name: "B_TOKEN", value: "other-secret" }];
  const text = "start s3cr3t-value-123 middle other-secret end s3cr3t-value-123\n";
  for (let size = 1; size <= text.length; size += 1) {
    let out = "";
    const stream = new RedactedOutput(secrets, (chunk) => {
      out += chunk;
    });
    for (let at = 0; at < text.length; at += size) stream.push(text.slice(at, at + size));
    stream.flush();
    assert.equal(out, "start [A_TOKEN redacted] middle [B_TOKEN redacted] end [A_TOKEN redacted]\n", `chunks of ${size}`);
  }
  // Output that only starts like a value is released whole, unredacted, at the end.
  let tail = "";
  const plain = new RedactedOutput(secrets, (chunk) => {
    tail += chunk;
  });
  plain.push("s3cr3t-val");
  assert.equal(tail, "", "a possible value is held back");
  plain.flush();
  assert.equal(tail, "s3cr3t-val");
  // No values: nothing is held.
  let direct = "";
  new RedactedOutput([], (chunk) => {
    direct += chunk;
  }).push("abc");
  assert.equal(direct, "abc");
});
