import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cp, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { WorktreeClaimSchema, WorktreesConfigPatchSchema, type WorktreeClaim } from "../src/shared/protocol.ts";
import { openDb } from "../src/server/db.ts";
import {
  WorktreeManager,
  type WorktreeAcquireResult,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import { buildClaimEnvironment, claimFingerprint, readTreeBlobs } from "../src/server/worktrees/claim.ts";
import { nativeWorktreeOwnerReferenced } from "../src/server/worktrees/owners.ts";
import { WorktreeOperationsService } from "../src/server/worktrees/operations.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import {
  copyOnWriteArgv,
  copyOnWriteClone,
  expandSeedPaths,
  placeSeed,
  removeLeftoverStaging,
  seedStagingRoot,
  stageSeed,
  wipeSeedPaths,
  type CloneTree,
} from "../src/server/worktrees/seed.ts";
import { WORKTREE_POOL_MARKER } from "../src/server/worktrees/marker.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// Seeding through the real manager, real Git and real files. Only the clone itself is faked:
// the test copies a tree where production asks `cp` for copy-on-write, so the suite behaves the
// same on a disk that can clone and on one that cannot. The fake that refuses to clone is a real
// `cp`-shaped executable driven through the production clone.

const db = openDb();
const ROOT_SKIP = process.getuid?.() === 0 ? "root bypasses directory permissions" : false;

afterEach(() => {
  db.exec(
    "DELETE FROM worktree_slots; DELETE FROM worktree_pools; " +
      "DELETE FROM app_config WHERE key = 'worktrees';",
  );
});

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known" as const, occupants: [] }])));
}

/**
 * The claim's one step: install `deps/marker` naming the slot it ran in, unless a seed already
 * put one there, and count every run in `logs/runs`. `deps/cache` and `deps/x.tmp` are what the
 * seed's exclusions must keep out of a clone.
 */
const INSTALL = [
  process.execPath,
  "-e",
  `const fs=require("fs");fs.mkdirSync("deps/cache",{recursive:true});fs.mkdirSync("logs",{recursive:true});` +
    `if(!fs.existsSync("deps/marker"))fs.writeFileSync("deps/marker",process.cwd());` +
    `fs.writeFileSync("deps/cache/blob","cache");fs.writeFileSync("deps/x.tmp","tmp");` +
    `fs.mkdirSync("more",{recursive:true});fs.writeFileSync("more/marker",process.cwd());` +
    `fs.appendFileSync("logs/runs","run\\n");`,
];

function claimWith(seed: WorktreeClaim["seed"] | null): WorktreeClaim {
  return WorktreeClaimSchema.parse({
    steps: [{ argv: INSTALL }],
    fingerprintPaths: ["lock.txt"],
    ...(seed ? { seed } : {}),
  });
}

const SEED = { paths: ["deps", "more"], exclude: ["deps/cache", "**/*.tmp"] };

/** A repository whose `deps/`, `more/` and `logs/` are ignored, with a tracked `tracked/`. */
function repository(prefix: string): { origin: string; clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, ".gitignore"), "deps/\nmore/\nlogs/\n");
  writeFileSync(join(origin, "lock.txt"), "v1\n");
  mkdirSync(join(origin, "tracked"));
  writeFileSync(join(origin, "tracked", "file"), "tracked\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "lockfile");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

function advance(fixture: { origin: string; clone: string }, file: string, content: string): string {
  writeFileSync(join(fixture.origin, file), content);
  gitIn(fixture.origin, "add", "-A");
  gitIn(fixture.origin, "commit", "-qm", `change ${file}`);
  gitIn(fixture.clone, "fetch", "-q", "origin");
  return gitIn(fixture.clone, "rev-parse", "origin/main");
}

/** A clone that copies the tree and records each source, as copy-on-write would place it. */
function recordingClone(sources: string[]): CloneTree {
  return async (request) => {
    sources.push(request.source);
    await cp(request.source, request.destination, { recursive: true, verbatimSymlinks: true });
    return { outcome: "cloned" };
  };
}

function manager(claim: WorktreeClaim | null, deps: Partial<WorktreeManagerDeps> = {}, maxSlots = 3): WorktreeManager {
  return new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots, setupArgv: null, claim }),
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: process.env, daemonToken: "seed-daemon-token", loginShell: {} }),
    ...deps,
  });
}

function acquire(m: WorktreeManager, clone: string, sha: string, key: string) {
  return m.acquire({ repositoryPath: clone, baseSha: sha, owner: { kind: "task", key }, runClaim: true });
}

function leased(result: WorktreeAcquireResult): Extract<WorktreeAcquireResult, { outcome: "acquired" }> {
  assert.equal(result.outcome, "acquired", JSON.stringify(result));
  return result as Extract<WorktreeAcquireResult, { outcome: "acquired" }>;
}

async function waitFor(predicate: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runCount(path: string): number {
  const file = join(path, "logs", "runs");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
}

function slotAt(m: WorktreeManager, ordinal: number) {
  const slot = m.store.slots().find((candidate) => candidate.ordinal === ordinal);
  assert.ok(slot, `slot ${ordinal} exists`);
  return slot;
}

/**
 * `count` slots, each claimed for real at `sha` and returned to the pool, so every one is an
 * idle sibling with a current fingerprint. Leased together, so each lease makes a new slot.
 */
async function warmPool(m: WorktreeManager, clone: string, sha: string, count: number, prefix: string): Promise<void> {
  const held = [];
  for (let index = 0; index < count; index += 1) {
    held.push(leased(await acquire(m, clone, sha, `${prefix}:${index}`)));
  }
  for (const lease of held) assert.equal((await m.release(lease.lease)).outcome, "released");
  for (let ordinal = 1; ordinal <= count; ordinal += 1) assert.equal(slotAt(m, ordinal).depsState, "current");
}

/** Make a slot cold, the way a failed claim leaves it: no fingerprint to trust. */
function makeCold(slotId: string, state: "failed" | null = "failed"): void {
  db.prepare("UPDATE worktree_slots SET deps_state = ?, deps_fingerprint = NULL, deps_fingerprint_sha = NULL WHERE id = ?")
    .run(state, slotId);
}

function setDeps(slotId: string, fingerprint: string, claimedAt: number): void {
  db.prepare("UPDATE worktree_slots SET deps_state = 'current', deps_fingerprint = ?, deps_claimed_at = ? WHERE id = ?")
    .run(fingerprint, claimedAt, slotId);
}

async function fingerprintAt(clone: string, claim: WorktreeClaim, sha: string): Promise<string> {
  const blobs = await readTreeBlobs(clone, sha);
  assert.ok(blobs.ok);
  return claimFingerprint(claim, blobs.value)!;
}

// ---- settings ----

test("the claim's seed is strict, bounded, and refuses ** in a seed path but not in an exclusion", () => {
  const parsed = WorktreeClaimSchema.parse({
    steps: [{ argv: ["yarn", "install"] }],
    seed: { paths: ["node_modules", "apps/*/node_modules", ".yarn/install-state.gz"] },
  });
  assert.deepEqual(parsed.seed, {
    paths: ["node_modules", "apps/*/node_modules", ".yarn/install-state.gz"],
    exclude: [],
  });
  assert.deepEqual(
    WorktreeClaimSchema.parse({ steps: [{ argv: ["x"] }], seed: { paths: ["a"], exclude: ["**/node_modules/.cache"] } }).seed?.exclude,
    ["**/node_modules/.cache"],
  );
  for (const seed of [
    { paths: [] },
    { paths: ["**/node_modules"] },
    { paths: ["apps/**"] },
    { paths: ["/abs"] },
    { paths: ["../up"] },
    { paths: ["a//b"] },
    { paths: ["a\\b"] },
    { paths: ["a"], exclude: ["/abs"] },
    { paths: ["a"], extra: true },
    { paths: Array.from({ length: 65 }, (_, index) => `p${index}`) },
    { paths: ["a"], exclude: Array.from({ length: 65 }, (_, index) => `e${index}`) },
    // The checkout's Git administrative path, in any letter case and at any depth.
    { paths: [".git"] },
    { paths: [".Git"] },
    { paths: ["apps/web/.GIT"] },
  ]) {
    assert.throws(() => WorktreeClaimSchema.parse({ steps: [{ argv: ["x"] }], seed }), JSON.stringify(seed).slice(0, 60));
  }
  // Exactly the documented maximum is accepted on each list, one past it (above) is refused.
  const atMost = WorktreeClaimSchema.parse({
    steps: [{ argv: ["x"] }],
    seed: {
      paths: Array.from({ length: 64 }, (_, index) => `p${index}`),
      exclude: Array.from({ length: 64 }, (_, index) => `e${index}`),
    },
  });
  assert.equal(atMost.seed?.paths.length, 64);
  assert.equal(atMost.seed?.exclude.length, 64);
  // The patch route takes the seed with the rest of the claim, and backups carry it with no new domain.
  assert.equal(
    WorktreesConfigPatchSchema.safeParse({
      repositories: { "/repo/.git": { claim: { steps: [{ argv: ["x"] }], seed: { paths: ["node_modules"] } } } },
    }).success,
    true,
  );
});

test("a seed is not a fingerprint input", () => {
  const plain = claimWith(null);
  const seeded = claimWith(SEED);
  const blobs = [{ path: "lock.txt", object: "a".repeat(40) }];
  assert.equal(claimFingerprint(plain, blobs), claimFingerprint(seeded, blobs));
});

// ---- the pieces ----

test("seed globs expand level by level, keep the outermost match, and never name .git", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-seed-expand-"));
  for (const directory of ["node_modules/a", "apps/web/node_modules", "apps/api/node_modules", "apps/.hidden/node_modules", ".git/x", "packages/p"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  mkdirSync(join(root, ".yarn"));
  writeFileSync(join(root, ".yarn", "install-state.gz"), "state");
  const entries = await expandSeedPaths(root, [
    "node_modules",
    "node_modules/a",
    "apps/*/node_modules",
    "packages/*/node_modules",
    ".yarn/install-state.gz",
    ".git",
  ]);
  assert.deepEqual(entries, [
    { path: ".yarn/install-state.gz", directory: false },
    { path: "apps/api/node_modules", directory: true },
    { path: "apps/web/node_modules", directory: true },
    { path: "node_modules", directory: true },
  ]);
});

test("expansion never yields .git, whatever its letter case or however it is matched", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-seed-dotgit-"));
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, ".github"));
  mkdirSync(join(root, "apps", "web", ".git"), { recursive: true });
  // Expansion is also handed globs the schema refuses, because an older or hand-edited setting
  // never went through it. On a case-insensitive disk `.Git` names the real `.git`; the name
  // is refused before the disk is asked, so this holds on every platform.
  const entries = await expandSeedPaths(root, [".Git", ".GIT/objects", ".g*", ".[gG][iI][tT]", "apps/*/.git", "apps/web/.Git"]);
  assert.deepEqual(entries, [{ path: ".github", directory: true }]);
});

/** A source with `deps/{keep,x.tmp}` beside a target clone that ignores `deps/`. */
function stagingFixture(prefix: string) {
  const { clone } = repository(prefix);
  const source = mkdtempSync(join(tmpdir(), `${prefix}source-`));
  mkdirSync(join(source, "deps"));
  writeFileSync(join(source, "deps", "keep"), "keep");
  writeFileSync(join(source, "deps", "x.tmp"), "excluded");
  const staging = mkdtempSync(join(tmpdir(), `${prefix}staging-`));
  return { source, target: clone, staging };
}

test("an exclusion walk that cannot read a directory abandons the seed instead of passing it", { skip: ROOT_SKIP }, async () => {
  const { source, target, staging } = stagingFixture("mission-seed-exclude-unreadable-");
  let locked = "";
  const result = await stageSeed({
    sourceRoot: source,
    targetRoot: target,
    seed: { paths: ["deps"], exclude: ["**/*.tmp"] },
    stagingDirectory: staging,
    // The clone succeeds, but a directory inside it cannot be listed, so the walk cannot tell
    // what excluded content it holds.
    clone: async (request) => {
      await cp(request.source, request.destination, { recursive: true });
      locked = join(request.destination, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      return { outcome: "cloned" };
    },
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    now: Date.now,
  });
  chmodSync(locked, 0o700);
  assert.equal(result.kind, "abandoned");
  assert.match(result.kind === "abandoned" ? result.reason : "", /staging failed: .*(EACCES|permission denied)/i);
});

test("a staged root whose lookup fails before the exclusion walk abandons the seed, never places it", async () => {
  const { source, target, staging } = stagingFixture("mission-seed-exclude-root-lookup-");
  const looked: string[] = [];
  let failed = false;
  const result = await stageSeed({
    sourceRoot: source,
    targetRoot: target,
    seed: { paths: ["deps"], exclude: ["**/*.tmp"] },
    stagingDirectory: staging,
    clone: async (request) => {
      await cp(request.source, request.destination, { recursive: true });
      return { outcome: "cloned" };
    },
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    now: Date.now,
    // The staged root's first lookup fails the way a disk can, transiently; every later
    // lookup of it succeeds. Skipping the walk on that failure would place `deps/x.tmp`, which
    // the operator excluded, in a seed the next lookup then finds whole.
    lstat: async (path) => {
      looked.push(path);
      if (!failed && path.endsWith(join("0", "deps"))) {
        failed = true;
        throw Object.assign(new Error(`EIO: i/o error, lstat '${path}'`), { code: "EIO" });
      }
      return lstat(path);
    },
  });
  assert.ok(failed, "the staged root was looked up through the injected seam");
  assert.equal(result.kind, "abandoned");
  assert.match(result.kind === "abandoned" ? result.reason : "", /staging failed: EIO/);
});

test("a Stop or the deadline landing during exclusion work ends the seed, not the next clone", async () => {
  for (const ending of ["stopped", "timedOut"] as const) {
    const { source, target, staging } = stagingFixture(`mission-seed-exclude-${ending}-`);
    const control = new AbortController();
    let offset = 0;
    const result = await stageSeed({
      sourceRoot: source,
      targetRoot: target,
      seed: { paths: ["deps"], exclude: ["**/*.tmp"] },
      stagingDirectory: staging,
      // The only path's clone finishes just as the Stop or the deadline lands, so only the
      // exclusion work that follows it can notice.
      clone: async (request) => {
        await cp(request.source, request.destination, { recursive: true });
        if (ending === "stopped") control.abort("stopped");
        else offset += 11 * 60_000;
        return { outcome: "cloned" };
      },
      signal: control.signal,
      deadline: Date.now() + 10 * 60_000,
      now: () => Date.now() + offset,
    });
    assert.deepEqual(result, { kind: ending }, `a seed ${ending} after its last clone is never staged`);
  }
});

test("expansion fails closed when it cannot inspect the tree, and only real absence is no match", { skip: ROOT_SKIP }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-seed-expand-unreadable-"));
  mkdirSync(join(root, "pkgs", "a", "node_modules"), { recursive: true });
  mkdirSync(join(root, "locked"));
  writeFileSync(join(root, "locked", "x"), "x");
  writeFileSync(join(root, "plain-file"), "not a directory");
  // Genuinely absent, or under a file rather than a directory: simply no match.
  assert.deepEqual(await expandSeedPaths(root, ["absent/*/node_modules", "plain-file/x", "absent"]), []);
  chmodSync(join(root, "pkgs"), 0o000); // cannot be listed
  chmodSync(join(root, "locked"), 0o600); // can be listed, but nothing inside can be looked up
  try {
    await assert.rejects(expandSeedPaths(root, ["pkgs/*/node_modules"]), /EACCES|permission denied/i);
    await assert.rejects(expandSeedPaths(root, ["locked/x"]), /EACCES|permission denied/i);
  } finally {
    chmodSync(join(root, "pkgs"), 0o700);
    chmodSync(join(root, "locked"), 0o700);
  }
});

test("a source branch that cannot be read abandons the seed before any clone", { skip: ROOT_SKIP }, async () => {
  const { source, target, staging } = stagingFixture("mission-seed-source-unreadable-");
  mkdirSync(join(source, "pkgs", "a", "node_modules"), { recursive: true });
  chmodSync(join(source, "pkgs"), 0o000);
  let cloned = 0;
  let result;
  try {
    result = await stageSeed({
      sourceRoot: source,
      targetRoot: target,
      seed: { paths: ["deps", "pkgs/*/node_modules"], exclude: [] },
      stagingDirectory: staging,
      clone: async () => {
        cloned += 1;
        return { outcome: "cloned" };
      },
      signal: new AbortController().signal,
      deadline: Date.now() + 60_000,
      now: Date.now,
    });
  } finally {
    chmodSync(join(source, "pkgs"), 0o700);
  }
  // Not a seed of `deps` alone that the target could inherit a fingerprint from.
  assert.equal(result.kind, "abandoned");
  assert.match(result.kind === "abandoned" ? result.reason : "", /staging failed: .*(EACCES|permission denied)/i);
  assert.equal(cloned, 0);
});

test("a Stop before preparation clones nothing", async () => {
  const { source, target, staging } = stagingFixture("mission-seed-prepare-stopped-");
  const control = new AbortController();
  control.abort("stopped");
  let cloned = 0;
  const result = await stageSeed({
    sourceRoot: source,
    targetRoot: target,
    seed: { paths: ["deps"], exclude: [] },
    stagingDirectory: staging,
    clone: async () => {
      cloned += 1;
      return { outcome: "cloned" };
    },
    signal: control.signal,
    deadline: Date.now() + 60_000,
    now: Date.now,
  });
  assert.deepEqual(result, { kind: "stopped" });
  assert.equal(cloned, 0);
});

test("copy-on-write is the only copy: the argv clones or refuses, and a refusal is never a byte copy", async () => {
  assert.deepEqual(copyOnWriteArgv("darwin", "/s", "/d"), ["-c", "-R", "/s", "/d"]);
  assert.equal(copyOnWriteArgv("linux", "/s", "/d"), null);
  assert.equal(copyOnWriteArgv("win32", "/s", "/d"), null);

  // A `cp` that, like macOS cp on a volume without clonefile, refuses -c rather than falling back.
  const bin = mkdtempSync(join(tmpdir(), "mission-seed-fake-cp-"));
  const fakeCp = join(bin, "cp");
  writeFileSync(
    fakeCp,
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = "-c" ] && { echo "cp: failed to clone: Operation not supported" >&2; exit 1; }; done\nexit 0\n`,
  );
  chmodSync(fakeCp, 0o755);
  const source = mkdtempSync(join(tmpdir(), "mission-seed-source-"));
  writeFileSync(join(source, "file"), "data");
  const destination = join(mkdtempSync(join(tmpdir(), "mission-seed-dest-")), "copy");
  const refused = await copyOnWriteClone({ platform: "darwin", cp: fakeCp })({
    source,
    destination,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  });
  assert.equal(refused.outcome, "failed");
  assert.match(refused.outcome === "failed" ? refused.reason : "", /Operation not supported/);
  assert.equal(existsSync(destination), false, "nothing was copied byte by byte instead");
  const unsupported = await copyOnWriteClone({ platform: "win32" })({
    source,
    destination,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
  });
  assert.equal(unsupported.outcome, "failed");
});

test("the interrupted wipe removes only paths Git confirms are ignored, and refuses anything else whole", async () => {
  const { clone } = repository("mission-seed-wipe-");
  mkdirSync(join(clone, "deps"), { recursive: true });
  writeFileSync(join(clone, "deps", "half"), "half-renamed");
  // Ignored and untracked: removed.
  const removed = await wipeSeedPaths(clone, { paths: ["deps", "absent"], exclude: [] });
  assert.deepEqual(removed, { ok: true, removed: ["deps"] });
  assert.equal(existsSync(join(clone, "deps")), false);

  // A tracked match refuses, and nothing at all is removed, the ignored path included.
  mkdirSync(join(clone, "deps"));
  writeFileSync(join(clone, "deps", "half"), "half-renamed");
  const tracked = await wipeSeedPaths(clone, { paths: ["deps", "tracked"], exclude: [] });
  assert.equal(tracked.ok, false);
  assert.match("reason" in tracked ? tracked.reason : "", /tracked holds tracked files/);
  assert.equal(existsSync(join(clone, "deps", "half")), true);
  assert.equal(existsSync(join(clone, "tracked", "file")), true);

  // An untracked path Git does not ignore refuses the same way.
  mkdirSync(join(clone, "loose"));
  writeFileSync(join(clone, "loose", "work"), "somebody's work");
  const loose = await wipeSeedPaths(clone, { paths: ["deps", "loose"], exclude: [] });
  assert.equal(loose.ok, false);
  assert.match("reason" in loose ? loose.reason : "", /loose is not ignored by Git/);
  assert.equal(existsSync(join(clone, "loose", "work")), true);
  assert.equal(existsSync(join(clone, "deps", "half")), true);
});

test("leftover staging is removed unless a live seed owns it", async () => {
  const pool = mkdtempSync(join(tmpdir(), "mission-seed-staging-"));
  for (const name of ["dead", "live"]) mkdirSync(join(seedStagingRoot(pool), name, "0"), { recursive: true });
  assert.deepEqual(await removeLeftoverStaging(pool, new Set(["live"])), ["dead"]);
  assert.deepEqual(readdirSync(seedStagingRoot(pool)), ["live"]);
});

// ---- seeding in a claim ----

test("a cold slot seeds from an exact-match sibling before the most recently claimed one, and skips its steps", async () => {
  const fixture = repository("mission-seed-order-");
  const claim = claimWith(SEED);
  const sources: string[] = [];
  const m = manager(claim, { cloneTree: recordingClone(sources) });
  await warmPool(m, fixture.clone, fixture.sha, 3, "order");
  assert.equal(sources.length, 0, "a claim with no idle sibling seeds nothing: every slot installed itself");
  const exactFingerprint = slotAt(m, 3).depsFingerprint!;
  // Slot 2 was claimed most recently, but at other inputs; slot 3 matches this commit exactly.
  setDeps(slotAt(m, 2).id, "f".repeat(64), Date.now() + 60_000);
  setDeps(slotAt(m, 3).id, exactFingerprint, 1);
  makeCold(slotAt(m, 1).id);
  const runsBefore = runCount(slotAt(m, 1).path);

  const seeded = leased(await acquire(m, fixture.clone, fixture.sha, "order:seeded"));
  assert.equal(seeded.lease.path, slotAt(m, 1).path, "acquisition takes the lowest available slot");
  assert.equal(seeded.claimWarning, undefined);
  assert.deepEqual(sources, [join(slotAt(m, 3).path, "deps"), join(slotAt(m, 3).path, "more")]);
  for (const source of sources) assert.ok(source.startsWith(m.store.pools()[0]!.poolPath), "only slots are sources");
  const target = slotAt(m, 1);
  assert.equal(target.depsState, "current");
  assert.equal(target.depsFingerprint, exactFingerprint, "the target inherits the source's fingerprint");
  assert.equal(target.depsFingerprintSha, fixture.sha);
  assert.equal(runCount(target.path), runsBefore, "the inherited fingerprint matched, so no step ran");
  assert.equal(readFileSync(join(target.path, "deps", "marker"), "utf8"), slotAt(m, 3).path);
  // Exclusions were removed from the clone before it was placed.
  assert.equal(existsSync(join(target.path, "deps", "cache")), false);
  assert.equal(existsSync(join(target.path, "deps", "x.tmp")), false);
  // The source went back to the pool through the ordinary release, its fingerprint untouched.
  const source = slotAt(m, 3);
  assert.equal(source.state, "available");
  assert.equal(source.lastReleasedOwnerKind, "warm");
  assert.equal(source.depsFingerprint, exactFingerprint);
  assert.deepEqual(readdirSync(seedStagingRoot(m.store.pools()[0]!.poolPath)), [], "staging is gone");
  assert.equal(gitIn(target.path, "status", "--porcelain"), "", "the seed changed nothing the final proof sees");
  await m.release(seeded.lease);

  // With no exact match, the most recently claimed idle sibling is the source, and the steps
  // then run on top of the seeded tree because its fingerprint is not this commit's.
  sources.length = 0;
  makeCold(slotAt(m, 1).id);
  setDeps(slotAt(m, 3).id, "e".repeat(64), 1);
  const fallback = leased(await acquire(m, fixture.clone, fixture.sha, "order:recent"));
  assert.equal(fallback.lease.path, slotAt(m, 1).path);
  assert.deepEqual(sources, [join(slotAt(m, 2).path, "deps"), join(slotAt(m, 2).path, "more")]);
  assert.equal(slotAt(m, 1).depsState, "current");
  assert.equal(slotAt(m, 1).depsFingerprint, exactFingerprint, "the steps recorded this commit's own fingerprint");
  assert.equal(runCount(slotAt(m, 1).path), runsBefore + 1);
  await m.release(fallback.lease);
});

test("a stale slot seeds only from a sibling that matches its commit exactly", async () => {
  const fixture = repository("mission-seed-stale-");
  const claim = claimWith(SEED);
  const sources: string[] = [];
  const m = manager(claim, { cloneTree: recordingClone(sources) }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "stale");
  const next = advance(fixture, "lock.txt", "v2\n");
  const nextFingerprint = await fingerprintAt(fixture.clone, claim, next);

  // Both slots hold the old commit's fingerprint, so no sibling matches the new one: slot 1
  // claims in place, which keeps a small lockfile change an incremental install.
  const before = runCount(slotAt(m, 1).path);
  const inPlace = leased(await acquire(m, fixture.clone, next, "stale:in-place"));
  assert.equal(inPlace.lease.path, slotAt(m, 1).path);
  assert.deepEqual(sources, []);
  assert.equal(runCount(inPlace.lease.path), before + 1);
  assert.equal(slotAt(m, 1).depsFingerprint, nextFingerprint);
  await m.release(inPlace.lease);

  // Now slot 1 is stale and slot 2 matches the new commit exactly: slot 1 seeds from slot 2
  // and inherits its fingerprint, so the steps are skipped.
  setDeps(slotAt(m, 1).id, "c".repeat(64), 1);
  setDeps(slotAt(m, 2).id, nextFingerprint, 1);
  const runs = runCount(slotAt(m, 1).path);
  const seeded = leased(await acquire(m, fixture.clone, next, "stale:seeded"));
  assert.equal(seeded.lease.path, slotAt(m, 1).path);
  assert.deepEqual(sources, [join(slotAt(m, 2).path, "deps"), join(slotAt(m, 2).path, "more")]);
  assert.equal(slotAt(m, 1).depsFingerprint, nextFingerprint);
  assert.equal(runCount(seeded.lease.path), runs, "no step ran");
  await m.release(seeded.lease);
});

test("with no idle sibling, or where the disk cannot clone, there is no seed and the steps run", async () => {
  const fixture = repository("mission-seed-none-");
  const claim = claimWith(SEED);
  const bin = mkdtempSync(join(tmpdir(), "mission-seed-fake-cp-"));
  const fakeCp = join(bin, "cp");
  writeFileSync(fakeCp, `#!/bin/sh\necho "cp: failed to clone: Operation not supported" >&2\nexit 1\n`);
  chmodSync(fakeCp, 0o755);
  const m = manager(claim, { cloneTree: copyOnWriteClone({ platform: "darwin", cp: fakeCp }) }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "none");
  makeCold(slotAt(m, 1).id);
  rmrf(join(slotAt(m, 1).path, "deps"));
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "none:refused"));
  assert.equal(result.claimWarning, undefined, "an abandoned seed is not a failed claim");
  assert.equal(runCount(slotAt(m, 1).path), before + 1, "the steps ran instead");
  assert.equal(readFileSync(join(slotAt(m, 1).path, "deps", "marker"), "utf8"), slotAt(m, 1).path, "nothing came from the sibling");
  assert.equal(slotAt(m, 2).state, "available", "the source went back to the pool");
  assert.deepEqual(readdirSync(seedStagingRoot(m.store.pools()[0]!.poolPath)), []);
  await m.release(result.lease);
});

function rmrf(path: string): void {
  execFileSync("rm", ["-rf", path]);
}

test("the warm lease keeps an occupied source from quarantine, and its owner is referenced exactly while it runs", async () => {
  const fixture = repository("mission-seed-warm-");
  const claim = claimWith(SEED);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let copying = false;
  const occupied = new Set<string>();
  const m = manager(claim, {
    // Only the concurrent task lease is still referenced by its task; every other owner is gone.
    ownerReferenced: async (reference) => reference.owner.key === "warm:other",
    occupancy: async (paths) => new Map(paths.map((path) => [path, {
      status: "known" as const,
      occupants: occupied.has(path) ? [{ pid: 4242, command: "cp" }] : [],
    } as WorktreeOccupancy])),
    cloneTree: async (request) => {
      copying = true;
      await gate;
      await cp(request.source, request.destination, { recursive: true, verbatimSymlinks: true });
      return { outcome: "cloned" };
    },
  }, 3);
  await warmPool(m, fixture.clone, fixture.sha, 2, "warm");
  makeCold(slotAt(m, 1).id);
  const pending = acquire(m, fixture.clone, fixture.sha, "warm:target");
  await waitFor(() => copying, "the seed to start copying");
  const source = slotAt(m, 2);
  assert.equal(source.state, "leased");
  assert.equal(source.activeOwnerKind, "warm");
  assert.equal(m.warmOwnerLive(source.activeOwnerKey!), true);
  assert.equal(slotAt(m, 1).depsState, "seeding", "the target's seed write-ahead is down");

  // Settings shows the source as held by maintenance, never as a task, and offers nothing to
  // do to it: the seed returns it the moment its copy ends.
  const operations = new WorktreeOperationsService(m, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(db, { manager: m, legacy: new LegacyTreehouseService(db) }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    claimVariablePresence: async () => [],
  });
  const card = (await operations.inventory()).repositories
    .flatMap((repository) => repository.slots)
    .find((slot) => slot.id === source.id);
  assert.equal(card?.owner?.kind, "warm");
  assert.equal(card?.owner?.label, "Seeding another slot's dependencies");
  assert.deepEqual(card?.actions, []);
  // A Destroy that reaches the source, as a pool-wide one does, is refused at preview, before
  // execution could reclaim any other owner and then stop at this one.
  const destroy = await operations.preview({ action: "destroy", target: { kind: "slot", slotId: source.id } });
  assert.equal(destroy.allowed, false);
  assert.ok(destroy.blockers.some((blocker) => /dependency seed holds slot 2/.test(blocker)), JSON.stringify(destroy.blockers));

  // Something now runs inside the source. Neither another acquisition nor maintenance may
  // quarantine it: it is leased to a live warm owner, not available.
  occupied.add(source.path);
  const other = leased(await acquire(m, fixture.clone, fixture.sha, "warm:other"));
  assert.equal(other.lease.path, slotAt(m, 3).path, "a new slot, since the source is not available");
  await m.reconcile();
  assert.equal(slotAt(m, 2).state, "leased");
  assert.equal(slotAt(m, 2).quarantineReason, null);
  occupied.delete(source.path);

  release();
  const seeded = leased(await pending);
  assert.equal(seeded.lease.path, slotAt(m, 1).path);
  assert.equal(slotAt(m, 2).state, "available");
  assert.equal(m.warmOwnerLive(source.activeOwnerKey!), false, "referenced only while its seed ran");
  // The durable resolver never claims a warm owner: no Warm or seed outlives its daemon.
  assert.equal(
    nativeWorktreeOwnerReferenced({ slotId: source.id, leaseId: source.activeLeaseId!, owner: { kind: "warm", key: source.activeOwnerKey! } }, db),
    false,
  );
  await m.release(seeded.lease);
  await m.release(other.lease);
});

test("recovering an interrupted seed runs every step even after the operator narrows the seed paths", async () => {
  const fixture = repository("mission-seed-narrowed-");
  const claim = claimWith(SEED);
  let targetId = "";
  let m!: WorktreeManager;
  m = manager(claim, {
    cloneTree: recordingClone([]),
    // Stopped once both `deps` and `more` were renamed into the target.
    afterSeedRename: (path) => {
      if (path !== "more") return;
      const running = m.claims.get(targetId);
      assert.ok(running);
      m.stopClaim(targetId, running.id);
    },
  }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "narrowed");
  targetId = slotAt(m, 1).id;
  makeCold(targetId);
  const stopped = leased(await acquire(m, fixture.clone, fixture.sha, "narrowed:stopped"));
  assert.equal(slotAt(m, 1).depsState, "interrupted");
  await m.release(stopped.lease);
  // What the cut-off seed left in `more`, which the narrowed configuration no longer names.
  writeFileSync(join(slotAt(m, 1).path, "more", "marker"), "half-renamed by the cut-off seed");

  // The operator narrows the seed to `deps`. The wipe and the seed now cover `deps` alone, and
  // the source matches this commit exactly, yet the steps must still run to repair `more`.
  const sources: string[] = [];
  const narrowed = manager(claimWith({ paths: ["deps"], exclude: [] }), { cloneTree: recordingClone(sources) }, 2);
  const before = runCount(slotAt(narrowed, 1).path);
  const recovered = leased(await acquire(narrowed, fixture.clone, fixture.sha, "narrowed:recovered"));
  assert.equal(recovered.lease.path, slotAt(narrowed, 1).path);
  assert.deepEqual(sources, [join(slotAt(narrowed, 2).path, "deps")], "the recovery still seeds");
  assert.equal(runCount(recovered.lease.path), before + 1, "but never skips the steps on the inherited fingerprint");
  assert.equal(readFileSync(join(recovered.lease.path, "more", "marker"), "utf8"), recovered.lease.path, "the steps repaired `more`");
  assert.equal(slotAt(narrowed, 1).depsState, "current");
  await narrowed.release(recovered.lease);
});

test("a stop during a seed records interrupted, and the next claim wipes the seed paths and starts cold", async () => {
  const fixture = repository("mission-seed-stop-");
  const claim = claimWith(SEED);
  let copying = false;
  const m = manager(claim, {
    cloneTree: (request) => new Promise((resolve) => {
      copying = true;
      request.signal.addEventListener("abort", () => resolve({ outcome: "stopped" }), { once: true });
    }),
  }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "stop");
  makeCold(slotAt(m, 1).id);
  writeFileSync(join(slotAt(m, 1).path, "deps", "stray"), "left by a cut-off seed");
  const pending = acquire(m, fixture.clone, fixture.sha, "stop:target");
  await waitFor(() => copying, "the seed to start copying");
  const running = m.claims.get(slotAt(m, 1).id);
  assert.ok(running);
  assert.ok(m.stopClaim(slotAt(m, 1).id, running.id));
  const stopped = leased(await pending);
  assert.match(stopped.claimWarning?.reason ?? "", /dependency seed was stopped/);
  assert.equal(slotAt(m, 1).depsState, "interrupted", "a stop during a seed is not an ordinary failure");
  assert.equal(slotAt(m, 1).depsFingerprint, null);
  assert.equal(slotAt(m, 2).state, "available", "the source went back to the pool");
  await m.release(stopped.lease);

  // The next claim removes the seed paths, finds no sibling willing to copy, and installs.
  const next = manager(claim, { cloneTree: async () => ({ outcome: "failed", reason: "this disk cannot clone" }) }, 2);
  const before = runCount(slotAt(next, 1).path);
  const again = leased(await acquire(next, fixture.clone, fixture.sha, "stop:again"));
  assert.equal(again.lease.path, slotAt(next, 1).path);
  assert.equal(existsSync(join(again.lease.path, "deps", "stray")), false, "the interrupted seed's paths were removed");
  assert.equal(runCount(again.lease.path), before + 1);
  assert.equal(slotAt(next, 1).depsState, "current");
  await next.release(again.lease);
});

test("an interrupted slot whose seed paths match a tracked file fails its claim with a warning and stays interrupted", async () => {
  const fixture = repository("mission-seed-refuse-");
  const claim = claimWith({ paths: ["deps", "tracked"], exclude: [] });
  const m = manager(claim, { cloneTree: recordingClone([]) }, 1);
  await warmPool(m, fixture.clone, fixture.sha, 1, "refuse");
  db.prepare("UPDATE worktree_slots SET deps_state = 'interrupted', deps_fingerprint = NULL WHERE id = ?").run(slotAt(m, 1).id);
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "refuse:target"));
  assert.match(result.claimWarning?.reason ?? "", /interrupted seed paths could not be removed: tracked holds tracked files/);
  assert.equal(result.claimWarning?.step, 1);
  // Not `failed`: that would let the next claim run its steps over the cut-off seed's paths.
  assert.equal(slotAt(m, 1).depsState, "interrupted");
  assert.equal(slotAt(m, 1).depsFingerprint, null);
  assert.equal(existsSync(join(result.lease.path, "deps", "marker")), true, "nothing was removed");
  assert.equal(runCount(result.lease.path), before, "no step ran");
  await m.release(result.lease);

  // The obligation stays: the next claim tries the wipe again before anything else.
  const again = leased(await acquire(m, fixture.clone, fixture.sha, "refuse:again"));
  assert.match(again.claimWarning?.reason ?? "", /interrupted seed paths could not be removed/);
  assert.equal(slotAt(m, 1).depsState, "interrupted");
  assert.equal(runCount(again.lease.path), before, "still no step ran");
  await m.release(again.lease);
});

test("the interrupted wipe honours its budget: an expired deadline or a Stop removes nothing more", async () => {
  const { clone } = repository("mission-seed-wipe-budget-");
  mkdirSync(join(clone, "deps", "pkg"), { recursive: true });
  writeFileSync(join(clone, "deps", "pkg", "file"), "installed");
  const expired = await wipeSeedPaths(clone, { paths: ["deps"], exclude: [] }, {
    signal: new AbortController().signal,
    deadline: Date.now() - 1,
    now: Date.now,
  });
  assert.deepEqual(expired, { ok: false, ended: "timedOut" });
  const stopped = new AbortController();
  stopped.abort("stopped");
  assert.deepEqual(
    await wipeSeedPaths(clone, { paths: ["deps"], exclude: [] }, { signal: stopped.signal, deadline: Date.now() + 60_000, now: Date.now }),
    { ok: false, ended: "stopped" },
  );
  assert.equal(existsSync(join(clone, "deps", "pkg", "file")), true, "nothing was removed");
});

test("a Stop that lands before an interrupted slot's wipe stops the wipe and keeps the cleanup owed", async () => {
  const fixture = repository("mission-seed-wipe-stopped-");
  const claim = claimWith(SEED);
  const m = manager(claim, { cloneTree: recordingClone([]) }, 1);
  await warmPool(m, fixture.clone, fixture.sha, 1, "wipe-stopped");
  const slot = slotAt(m, 1);
  db.prepare("UPDATE worktree_slots SET deps_state = 'interrupted', deps_fingerprint = NULL WHERE id = ?").run(slot.id);
  writeFileSync(join(slot.path, "deps", "half"), "half-renamed");
  const before = runCount(slot.path);
  const result = leased(await m.acquire({
    repositoryPath: fixture.clone,
    baseSha: fixture.sha,
    owner: { kind: "task", key: "wipe-stopped:target" },
    runClaim: true,
    // The claim's own start: the Stop lands after its deadline is set and before the wipe.
    onClaimStart: () => {
      const running = m.claims.get(slot.id);
      assert.ok(running);
      m.stopClaim(slot.id, running.id);
    },
  }));
  assert.match(result.claimWarning?.reason ?? "", /removing the interrupted seed paths was stopped/);
  assert.equal(existsSync(join(slot.path, "deps", "half")), true, "the wipe saw the Stop before removing anything");
  assert.equal(slotAt(m, 1).depsState, "interrupted", "the cleanup is still owed");
  assert.equal(runCount(slot.path), before, "no step ran");
  await m.release(result.lease);
});

test("an interrupted wipe that cannot inspect a seed path removes nothing and stays interrupted", { skip: ROOT_SKIP }, async () => {
  const fixture = repository("mission-seed-wipe-uninspectable-");
  const claim = claimWith({ paths: ["deps", "more/*/x"], exclude: [] });
  const m = manager(claim, { cloneTree: async () => ({ outcome: "failed", reason: "this disk cannot clone" }) }, 1);
  await warmPool(m, fixture.clone, fixture.sha, 1, "wipe-uninspectable");
  const slot = slotAt(m, 1);
  db.prepare("UPDATE worktree_slots SET deps_state = 'interrupted', deps_fingerprint = NULL WHERE id = ?").run(slot.id);
  mkdirSync(join(slot.path, "more", "pkg", "x"), { recursive: true });
  writeFileSync(join(slot.path, "deps", "half"), "half-renamed");
  chmodSync(join(slot.path, "more"), 0o000);
  const before = runCount(slot.path);
  let result: Extract<WorktreeAcquireResult, { outcome: "acquired" }>;
  try {
    result = leased(await acquire(m, fixture.clone, fixture.sha, "wipe-uninspectable:target"));
  } finally {
    chmodSync(join(slot.path, "more"), 0o700);
  }
  assert.match(result.claimWarning?.reason ?? "", /interrupted seed paths could not be removed: seed paths could not be inspected/);
  assert.equal(existsSync(join(slot.path, "deps", "half")), true, "nothing was removed on a partial view");
  assert.equal(slotAt(m, 1).depsState, "interrupted", "the cleanup is still owed");
  assert.equal(runCount(slot.path), before, "no step ran over the uninspected tree");
  await m.release(result.lease);

  // Readable again: the next claim removes every seed path, then installs cold.
  const again = leased(await acquire(m, fixture.clone, fixture.sha, "wipe-uninspectable:again"));
  assert.equal(again.claimWarning, undefined);
  assert.equal(existsSync(join(slot.path, "deps", "half")), false);
  assert.equal(existsSync(join(slot.path, "more", "pkg", "x")), false);
  assert.equal(runCount(slot.path), before + 1);
  assert.equal(slotAt(m, 1).depsState, "current");
  await m.release(again.lease);
});

test("a wipe that fails after removing some seed paths keeps the slot interrupted, and the next claim finishes it", { skip: ROOT_SKIP }, async () => {
  const fixture = repository("mission-seed-wipe-partial-");
  const claim = claimWith(SEED);
  // No sibling can be cloned from, so every claim here runs its own steps after the wipe.
  const m = manager(claim, { cloneTree: async () => ({ outcome: "failed", reason: "this disk cannot clone" }) }, 1);
  await warmPool(m, fixture.clone, fixture.sha, 1, "wipe-partial");
  const slot = slotAt(m, 1);
  db.prepare("UPDATE worktree_slots SET deps_state = 'interrupted', deps_fingerprint = NULL WHERE id = ?").run(slot.id);
  // `deps` is removed first; `more` cannot be, because a directory inside it refuses writes.
  writeFileSync(join(slot.path, "deps", "half"), "half-renamed");
  const locked = join(slot.path, "more", "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "file"), "cannot be removed");
  chmodSync(locked, 0o500);
  const before = runCount(slot.path);
  let result: Extract<WorktreeAcquireResult, { outcome: "acquired" }>;
  try {
    result = leased(await acquire(m, fixture.clone, fixture.sha, "wipe-partial:target"));
  } finally {
    chmodSync(locked, 0o700);
  }
  assert.match(result.claimWarning?.reason ?? "", /interrupted seed paths could not be removed: seed paths could not be removed/);
  assert.equal(existsSync(join(slot.path, "deps")), false, "the wipe had removed `deps` before it failed");
  assert.equal(existsSync(join(locked, "file")), true);
  assert.equal(slotAt(m, 1).depsState, "interrupted", "the half-finished cleanup is still owed");
  assert.equal(runCount(slot.path), before, "no step ran over the half-wiped tree");
  await m.release(result.lease);

  // With the obstacle gone, the next claim removes what is left and then starts cold.
  const again = leased(await acquire(m, fixture.clone, fixture.sha, "wipe-partial:again"));
  assert.equal(again.claimWarning, undefined);
  assert.equal(existsSync(join(slot.path, "more", "locked")), false, "the rest of the seed paths were removed");
  assert.equal(runCount(slot.path), before + 1);
  assert.equal(readFileSync(join(slot.path, "deps", "marker"), "utf8"), slot.path, "installed by its own step");
  assert.equal(slotAt(m, 1).depsState, "current");
  await m.release(again.lease);
});

test("an interrupted slot with no seed paths configured reruns every step and removes nothing", async () => {
  const fixture = repository("mission-seed-noseed-");
  const claim = claimWith(null);
  const m = manager(claim, {}, 1);
  await warmPool(m, fixture.clone, fixture.sha, 1, "noseed");
  db.prepare("UPDATE worktree_slots SET deps_state = 'interrupted', deps_fingerprint = NULL WHERE id = ?").run(slotAt(m, 1).id);
  writeFileSync(join(slotAt(m, 1).path, "deps", "kept"), "kept");
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "noseed:target"));
  assert.equal(result.claimWarning, undefined);
  assert.equal(runCount(result.lease.path), before + 1);
  assert.equal(existsSync(join(result.lease.path, "deps", "kept")), true);
  await m.release(result.lease);
});

test("each path is staged whole and renamed into place, so the checkout never holds a half tree", async () => {
  const fixture = repository("mission-seed-rename-");
  const claim = claimWith(SEED);
  const observed: Array<{ path: string; deps: string | null; more: string | null; staging: string[] }> = [];
  let poolPath = "";
  let target = "";
  const m = manager(claim, {
    cloneTree: recordingClone([]),
    afterSeedRename: (path) => {
      const read = (file: string) => (existsSync(join(target, file)) ? readFileSync(join(target, file), "utf8") : null);
      observed.push({
        path,
        deps: read("deps/marker"),
        more: read("more/marker"),
        staging: readdirSync(seedStagingRoot(poolPath)),
      });
    },
  }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "rename");
  poolPath = m.store.pools()[0]!.poolPath;
  target = slotAt(m, 1).path;
  makeCold(slotAt(m, 1).id);
  const source = slotAt(m, 2).path;
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "rename:target"));
  assert.deepEqual(observed.map((entry) => entry.path), ["deps", "more"]);
  // After the first rename, `deps` is the source's whole tree and `more` is still the target's.
  assert.equal(observed[0]!.deps, source);
  assert.equal(observed[0]!.more, target);
  assert.equal(observed[1]!.more, source);
  assert.equal(observed[0]!.staging.length, 1, "staging lives in the pool directory, outside the checkout");
  assert.deepEqual(readdirSync(seedStagingRoot(poolPath)), []);
  await m.release(result.lease);
});

test("an exclusion that removes a whole seed path makes the seed incomplete, so the steps still run", async () => {
  const fixture = repository("mission-seed-exclude-whole-");
  const claim = claimWith({ paths: ["deps", "more"], exclude: ["more"] });
  const m = manager(claim, { cloneTree: recordingClone([]) }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "exclude-whole");
  makeCold(slotAt(m, 1).id);
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "exclude-whole:target"));
  assert.equal(result.claimWarning, undefined, "nothing to place is not a failed placement");
  // The source matched this commit exactly, but `more` was not placed, so the target did not get
  // the source's tree and must not inherit its fingerprint: the steps ran on top of the seed.
  assert.equal(runCount(result.lease.path), before + 1);
  assert.equal(slotAt(m, 1).depsState, "current");
  assert.equal(readFileSync(join(result.lease.path, "deps", "marker"), "utf8"), slotAt(m, 2).path);
  assert.equal(readFileSync(join(result.lease.path, "more", "marker"), "utf8"), result.lease.path, "the target's own copy stayed");
  await m.release(result.lease);
});

test("a cold target holding a seed path the exact source lacks is not trusted: the steps run", async () => {
  const fixture = repository("mission-seed-target-extra-");
  const claim = claimWith(SEED);
  const sources: string[] = [];
  const m = manager(claim, { cloneTree: recordingClone(sources) }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "target-extra");
  // The source matches this commit exactly but has no `more`; the cold target keeps a stale one.
  rmrf(join(slotAt(m, 2).path, "more"));
  makeCold(slotAt(m, 1).id);
  writeFileSync(join(slotAt(m, 1).path, "more", "marker"), "stale");
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "target-extra:target"));
  assert.deepEqual(sources, [join(slotAt(m, 2).path, "deps")], "only what the source has was cloned");
  assert.equal(readFileSync(join(result.lease.path, "deps", "marker"), "utf8"), slotAt(m, 2).path);
  assert.equal(runCount(result.lease.path), before + 1, "the stale `more` was not replaced, so the steps ran");
  assert.equal(slotAt(m, 1).depsState, "current");
  await m.release(result.lease);
});

test("a source path left out because the target lacks its parent makes the seed incomplete", async () => {
  const fixture = repository("mission-seed-parent-missing-");
  const claim = claimWith({ paths: ["deps", "more/pkg"], exclude: [] });
  const sources: string[] = [];
  const m = manager(claim, { cloneTree: recordingClone(sources) }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "parent-missing");
  mkdirSync(join(slotAt(m, 2).path, "more", "pkg"), { recursive: true });
  makeCold(slotAt(m, 1).id);
  rmrf(join(slotAt(m, 1).path, "more"));
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "parent-missing:target"));
  assert.deepEqual(sources, [join(slotAt(m, 2).path, "deps")], "`more/pkg` had nowhere to go in the target");
  assert.equal(runCount(result.lease.path), before + 1, "so the target did not inherit the source's fingerprint");
  await m.release(result.lease);
});

test("a seed whose exclusions remove every path is no seed: the cold target installs itself", async () => {
  const fixture = repository("mission-seed-exclude-all-");
  const claim = claimWith({ paths: ["deps"], exclude: ["deps"] });
  const m = manager(claim, { cloneTree: recordingClone([]) }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "exclude-all");
  makeCold(slotAt(m, 1).id);
  rmrf(join(slotAt(m, 1).path, "deps"));
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "exclude-all:target"));
  assert.equal(result.claimWarning, undefined);
  assert.equal(runCount(result.lease.path), before + 1, "never recorded current on the source's fingerprint alone");
  assert.equal(readFileSync(join(result.lease.path, "deps", "marker"), "utf8"), result.lease.path, "installed by its own step");
  assert.equal(slotAt(m, 1).depsState, "current");
  assert.equal(slotAt(m, 2).state, "available");
  await m.release(result.lease);
});

test("a slot claimed before fingerprint paths were configured is stale, and seeds from an exact match", async () => {
  const fixture = repository("mission-seed-fingerprint-added-");
  const unfingerprinted = WorktreeClaimSchema.parse({ steps: [{ argv: INSTALL }], seed: SEED });
  const before = manager(unfingerprinted, { cloneTree: recordingClone([]) }, 2);
  await warmPool(before, fixture.clone, fixture.sha, 2, "fingerprint-added");
  assert.equal(slotAt(before, 1).depsFingerprint, null);

  // The operator adds fingerprint paths. Slot 2 has since been claimed under them; slot 1 still
  // holds its earlier, fingerprint-less claim, which is current but not this commit's.
  const claim = claimWith(SEED);
  const exact = await fingerprintAt(fixture.clone, claim, fixture.sha);
  setDeps(slotAt(before, 2).id, exact, Date.now());
  const sources: string[] = [];
  const m = manager(claim, { cloneTree: recordingClone(sources) }, 2);
  const runs = runCount(slotAt(m, 1).path);
  const seeded = leased(await acquire(m, fixture.clone, fixture.sha, "fingerprint-added:target"));
  assert.equal(seeded.lease.path, slotAt(m, 1).path);
  assert.deepEqual(sources, [join(slotAt(m, 2).path, "deps"), join(slotAt(m, 2).path, "more")]);
  assert.equal(slotAt(m, 1).depsFingerprint, exact, "the target inherited the exact match's fingerprint");
  assert.equal(runCount(seeded.lease.path), runs, "so no step ran");
  await m.release(seeded.lease);
});

test("with no fingerprint paths a settled slot never re-seeds, and a cold one seeds from the most recent sibling", async () => {
  const fixture = repository("mission-seed-no-fingerprint-");
  const claim = WorktreeClaimSchema.parse({ steps: [{ argv: INSTALL }], seed: SEED });
  const sources: string[] = [];
  const m = manager(claim, { cloneTree: recordingClone(sources) }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "no-fingerprint");
  assert.equal(slotAt(m, 2).depsFingerprint, null, "a claim with no fingerprint paths records none");

  // Settled slot: the claim runs in place, as it does on every lease, and nothing is copied over
  // the slot's own fresh install.
  const before = runCount(slotAt(m, 1).path);
  const settled = leased(await acquire(m, fixture.clone, fixture.sha, "no-fingerprint:settled"));
  assert.equal(sources.length, 0);
  assert.equal(runCount(settled.lease.path), before + 1);
  await m.release(settled.lease);

  // Cold slot: the idle sibling is a source even with no fingerprint, and since there is nothing
  // to inherit the steps run on top of the seed.
  makeCold(slotAt(m, 1).id);
  rmrf(join(slotAt(m, 1).path, "deps"));
  const cold = leased(await acquire(m, fixture.clone, fixture.sha, "no-fingerprint:cold"));
  assert.equal(cold.lease.path, slotAt(m, 1).path);
  assert.deepEqual(sources, [join(slotAt(m, 2).path, "deps"), join(slotAt(m, 2).path, "more")]);
  assert.equal(readFileSync(join(cold.lease.path, "deps", "marker"), "utf8"), slotAt(m, 2).path, "the seed placed the sibling's tree");
  assert.equal(runCount(cold.lease.path), before + 2, "and every step still ran");
  assert.equal(slotAt(m, 1).depsState, "current");
  assert.equal(slotAt(m, 1).depsFingerprint, null);
  await m.release(cold.lease);
});

test("a seed that reaches the claim's time limit records interrupted, returns its source and runs no step", async () => {
  const fixture = repository("mission-seed-timeout-");
  const claim = claimWith(SEED);
  // The clock jumps past the claim's 10-minute limit while the first path is cloned. The
  // deadline the seed and the steps share is noticed right after, before the second path is
  // ever handed to a clone.
  let offset = 0;
  const remaining: number[] = [];
  const m = manager(claim, {
    now: () => Date.now() + offset,
    cloneTree: async (request) => {
      remaining.push(request.timeoutMs);
      // The production clone's own guard: no time left is a timeout, never a copy.
      if (request.timeoutMs <= 0) return { outcome: "timedOut" };
      await cp(request.source, request.destination, { recursive: true, verbatimSymlinks: true });
      offset += 11 * 60_000;
      return { outcome: "cloned" };
    },
  }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "timeout");
  makeCold(slotAt(m, 1).id);
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "timeout:target"));
  assert.equal(remaining.length, 1, "no clone started past the limit");
  assert.ok(remaining[0]! > 0 && remaining[0]! <= claim.timeoutMinutes * 60_000, "the seed spends the claim's deadline");
  assert.match(result.claimWarning?.reason ?? "", /dependency seed reached the claim's time limit/);
  assert.equal(result.claimWarning?.step, 1);
  const target = slotAt(m, 1);
  assert.equal(target.depsState, "interrupted", "a timeout during a seed is not an ordinary failure");
  assert.equal(target.depsFingerprint, null);
  assert.equal(runCount(result.lease.path), before, "no step ran after the timed-out seed");
  assert.equal(slotAt(m, 2).state, "available", "the source went back to the pool");
  assert.equal(slotAt(m, 2).activeOwnerKind, null);
  assert.deepEqual(readdirSync(seedStagingRoot(m.store.pools()[0]!.poolPath)), [], "staging is gone");
  await m.release(result.lease);
});

test("a seed whose staged path cannot be placed records interrupted and runs no step", async () => {
  const fixture = repository("mission-seed-unplaced-");
  const claim = claimWith(SEED);
  let poolPath = "";
  const m = manager(claim, {
    cloneTree: recordingClone([]),
    // After `deps` is placed, the staged `more` vanishes, so its rename fails.
    afterSeedRename: (path) => {
      if (path !== "deps") return;
      for (const id of readdirSync(seedStagingRoot(poolPath))) rmrf(join(seedStagingRoot(poolPath), id, "1"));
    },
  }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, "unplaced");
  poolPath = m.store.pools()[0]!.poolPath;
  makeCold(slotAt(m, 1).id);
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, "unplaced:target"));
  assert.match(result.claimWarning?.reason ?? "", /dependency seed failed: more could not be placed/);
  const target = slotAt(m, 1);
  assert.equal(target.depsState, "interrupted", "a half-placed seed is never trusted, nor abandoned");
  assert.equal(target.depsFingerprint, null);
  assert.equal(runCount(result.lease.path), before, "no step ran on the half-placed tree");
  assert.equal(slotAt(m, 2).state, "available", "the source was returned before placement began");
  assert.deepEqual(readdirSync(seedStagingRoot(poolPath)), [], "staging is gone");
  await m.release(result.lease);
});

// ---- a Stop or the deadline while the seed is being placed ----

/**
 * A seed of an exact-match source, interrupted from `afterSeedRename` once `at` is renamed into
 * the target: the moment the checkout is already changing. Placement must notice before the
 * next rename, or after the last one, and the seed must be recorded interrupted, never current.
 */
async function interruptedPlacement(
  prefix: string,
  at: "deps" | "more",
  interrupt: (m: WorktreeManager, targetId: string, clock: { offset: number }) => void,
) {
  const fixture = repository(prefix);
  const claim = claimWith(SEED);
  const clock = { offset: 0 };
  let targetId = "";
  let m!: WorktreeManager;
  const renamed: string[] = [];
  m = manager(claim, {
    now: () => Date.now() + clock.offset,
    cloneTree: recordingClone([]),
    afterSeedRename: (path) => {
      renamed.push(path);
      if (path === at) interrupt(m, targetId, clock);
    },
  }, 2);
  await warmPool(m, fixture.clone, fixture.sha, 2, prefix);
  targetId = slotAt(m, 1).id;
  makeCold(targetId);
  const before = runCount(slotAt(m, 1).path);
  const result = leased(await acquire(m, fixture.clone, fixture.sha, `${prefix}:target`));
  const target = slotAt(m, 1);
  assert.equal(target.depsState, "interrupted", "a seed ended while it was being placed is never trusted");
  assert.equal(target.depsFingerprint, null, "not even when its source matched this commit exactly");
  assert.equal(runCount(result.lease.path), before, "no step ran on the half-placed tree");
  assert.equal(slotAt(m, 2).state, "available", "the source had already gone back to the pool");
  assert.deepEqual(readdirSync(seedStagingRoot(m.store.pools()[0]!.poolPath)), [], "staging is gone");
  await m.release(result.lease);
  return { warning: result.claimWarning, renamed };
}

function stop(m: WorktreeManager, targetId: string): void {
  const running = m.claims.get(targetId);
  assert.ok(running, "the claim is still running while its seed is placed");
  assert.ok(m.stopClaim(targetId, running.id));
}

test("a Stop between seed renames is noticed before the next rename and records interrupted", async () => {
  const { warning, renamed } = await interruptedPlacement("mission-seed-stop-placing-", "deps", (m, id) => stop(m, id));
  assert.deepEqual(renamed, ["deps"], "the second path was never renamed in");
  assert.match(warning?.reason ?? "", /dependency seed was stopped/);
});

test("a Stop after the last seed rename still records interrupted, never current", async () => {
  const { warning, renamed } = await interruptedPlacement("mission-seed-stop-placed-", "more", (m, id) => stop(m, id));
  assert.deepEqual(renamed, ["deps", "more"]);
  assert.match(warning?.reason ?? "", /dependency seed was stopped/);
});

test("the claim's deadline passing between seed renames records interrupted", async () => {
  const { warning, renamed } = await interruptedPlacement("mission-seed-late-placing-", "deps", (_m, _id, clock) => {
    clock.offset += 11 * 60_000;
  });
  assert.deepEqual(renamed, ["deps"]);
  assert.match(warning?.reason ?? "", /dependency seed reached the claim's time limit/);
});

// ---- crash and restart ----

test("a crash mid-copy with the source held: startup returns the source and records the target interrupted", async () => {
  const fixture = repository("mission-seed-crash-copy-");
  const claim = claimWith(SEED);
  let copying = false;
  const crashing = manager(claim, {
    cloneTree: async () => {
      copying = true;
      return new Promise(() => {});
    },
  }, 2);
  await warmPool(crashing, fixture.clone, fixture.sha, 2, "crash-copy");
  const sourceFingerprint = slotAt(crashing, 2).depsFingerprint;
  makeCold(slotAt(crashing, 1).id);
  void acquire(crashing, fixture.clone, fixture.sha, "crash-copy:target");
  await waitFor(() => copying, "the seed to start copying");
  const poolPath = crashing.store.pools()[0]!.poolPath;
  assert.equal(readdirSync(seedStagingRoot(poolPath)).length, 1);
  assert.equal(slotAt(crashing, 2).activeOwnerKind, "warm");

  // The next daemon: no seed runs in it, so the warm owner is definitely gone.
  const restarted = manager(claim, {}, 2);
  assert.equal(restarted.warmOwnerLive(slotAt(restarted, 2).activeOwnerKey!), false);
  await restarted.reconcile();
  const target = slotAt(restarted, 1);
  assert.equal(target.state, "quarantined");
  assert.equal(target.quarantineReason, "startup found an interrupted provisioning intent");
  assert.equal(target.depsState, "interrupted");
  const source = slotAt(restarted, 2);
  assert.equal(source.state, "available", "the source came back through the ordinary return path");
  assert.equal(source.activeOwnerKind, null);
  assert.equal(source.lastReleasedOwnerKind, "warm");
  assert.equal(source.depsState, "current");
  assert.equal(source.depsFingerprint, sourceFingerprint, "a source is only read, so its fingerprint stands");
  assert.deepEqual(readdirSync(seedStagingRoot(poolPath)), [], "leftover staging was removed");
});

test("leftover staging is removed even when a crash is followed by a pool marker that cannot be proven", async () => {
  const fixture = repository("mission-seed-crash-marker-");
  const claim = claimWith(SEED);
  let copying = false;
  const crashing = manager(claim, {
    cloneTree: async () => {
      copying = true;
      return new Promise(() => {});
    },
  }, 2);
  await warmPool(crashing, fixture.clone, fixture.sha, 2, "crash-marker");
  makeCold(slotAt(crashing, 1).id);
  void acquire(crashing, fixture.clone, fixture.sha, "crash-marker:target");
  await waitFor(() => copying, "the seed to start copying");
  const poolPath = crashing.store.pools()[0]!.poolPath;
  assert.equal(readdirSync(seedStagingRoot(poolPath)).length, 1);

  // The marker is gone, so the whole pool fails reconciliation, and staging still goes.
  rmSync(join(poolPath, WORKTREE_POOL_MARKER));
  const restarted = manager(claim, {}, 2);
  await restarted.reconcile();
  assert.deepEqual(readdirSync(seedStagingRoot(poolPath)), []);
  assert.match(restarted.store.pools()[0]!.reconciliationError ?? "", /pool marker/);
  const target = slotAt(restarted, 1);
  assert.equal(target.state, "quarantined");
  assert.equal(target.depsState, "interrupted");
  assert.equal(target.depsFingerprint, null);
});

test("a crash between seed renames leaves the target interrupted, never trusted", async () => {
  const fixture = repository("mission-seed-crash-rename-");
  const claim = claimWith(SEED);
  let renamed = 0;
  const crashing = manager(claim, {
    cloneTree: recordingClone([]),
    afterSeedRename: () => {
      renamed += 1;
      return new Promise(() => {});
    },
  }, 2);
  await warmPool(crashing, fixture.clone, fixture.sha, 2, "crash-rename");
  makeCold(slotAt(crashing, 1).id);
  void acquire(crashing, fixture.clone, fixture.sha, "crash-rename:target");
  await waitFor(() => renamed === 1, "the first rename");
  await waitFor(() => slotAt(crashing, 2).state === "available", "the source's return");
  assert.equal(slotAt(crashing, 1).depsState, "seeding");

  const restarted = manager(claim, {}, 2);
  await restarted.reconcile();
  const target = slotAt(restarted, 1);
  assert.equal(target.state, "quarantined");
  assert.equal(target.depsState, "interrupted");
  assert.equal(target.depsFingerprint, null);
  assert.equal(slotAt(restarted, 2).state, "available");
});

test("a seed source left leased by a crash and still occupied is quarantined, never handed out", async () => {
  const fixture = repository("mission-seed-crash-occupied-");
  const claim = claimWith(SEED);
  let copying = false;
  const crashing = manager(claim, {
    cloneTree: async () => {
      copying = true;
      return new Promise(() => {});
    },
  }, 2);
  await warmPool(crashing, fixture.clone, fixture.sha, 2, "crash-occupied");
  makeCold(slotAt(crashing, 1).id);
  void acquire(crashing, fixture.clone, fixture.sha, "crash-occupied:target");
  await waitFor(() => copying, "the seed to start copying");
  const sourcePath = slotAt(crashing, 2).path;
  // An orphaned process from the dead daemon is still inside the source.
  const restarted = manager(claim, {
    occupancy: async (paths) => new Map(paths.map((path) => [path, {
      status: "known" as const,
      occupants: path === sourcePath ? [{ pid: 777, command: "cp" }] : [],
    } as WorktreeOccupancy])),
  }, 2);
  await restarted.reconcile();
  assert.equal(slotAt(restarted, 2).state, "quarantined");
  assert.equal(slotAt(restarted, 2).quarantineReason, "an interrupted warm lease could not be returned");
});

// ---- the cold check fallback ----

test("a placement failure says whether it changed the target", async () => {
  const target = mkdtempSync(join(tmpdir(), "mission-seed-place-target-"));
  const staging = mkdtempSync(join(tmpdir(), "mission-seed-place-staging-"));
  const staged = join(staging, "0", "deps");
  mkdirSync(staged, { recursive: true });
  const exdev = async () => {
    throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
  };
  const base = { stagingDirectory: staging, signal: new AbortController().signal, deadline: Date.now() + 60_000, now: Date.now };
  // Nothing at the target yet: the first rename is refused, and nothing changed.
  const untouched = await placeSeed({ ...base, targetRoot: target, staged: [{ path: "deps", staged }], rename: exdev });
  assert.equal(untouched.ok, false);
  assert.equal("touched" in untouched && untouched.touched, false);
  assert.match("reason" in untouched ? untouched.reason : "", /EXDEV/);
  // An existing target path renamed aside, then the clone refused: the target has changed.
  mkdirSync(join(target, "deps"));
  let renames = 0;
  const touched = await placeSeed({
    ...base,
    targetRoot: target,
    staged: [{ path: "deps", staged }],
    rename: async (from, to) => {
      renames += 1;
      if (renames === 2) await exdev();
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
  });
  assert.equal("touched" in touched && touched.touched, true);
});

test("a cold check tree on another volume gets no seed, so its steps run instead of failing the claim", async () => {
  const fixture = repository("mission-seed-cold-xdev-");
  const claim = claimWith(SEED);
  const sources: string[] = [];
  let tree = "";
  const m = manager(claim, {
    cloneTree: recordingClone(sources),
    // The pool's staging and the check tree are on different filesystems.
    seedRename: async (from, to) => {
      if (to.startsWith(tree)) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
  }, 1);
  await warmPool(m, fixture.clone, fixture.sha, 1, "cold-xdev");
  // Physical, so it matches the working directory the steps report on a /var -> /private/var Mac.
  tree = join(realpathSync(mkdtempSync(join(tmpdir(), "mission-seed-cold-xdev-tree-"))), "check");
  gitIn(fixture.clone, "worktree", "add", "-q", "--detach", tree, fixture.sha);
  const result = await m.claimDisposableTree({
    repositoryPath: fixture.clone,
    path: tree,
    baseSha: fixture.sha,
    owner: { kind: "check", key: "cold-xdev-attempt" },
  });
  assert.deepEqual(result, { kind: "succeeded" }, "no seed is not a failed claim");
  assert.equal(sources.length, 2, "the clone into the pool's staging ran");
  assert.equal(runCount(tree), 1, "the steps installed the tree themselves");
  assert.equal(readFileSync(join(tree, "deps", "marker"), "utf8"), tree);
  assert.equal(slotAt(m, 1).state, "available");
});

test("the cold check fallback seeds its disposable tree from an idle slot and skips the steps on a match", async () => {
  const fixture = repository("mission-seed-cold-");
  const claim = claimWith(SEED);
  const sources: string[] = [];
  const m = manager(claim, { cloneTree: recordingClone(sources) }, 1);
  await warmPool(m, fixture.clone, fixture.sha, 1, "cold");
  const tree = join(mkdtempSync(join(tmpdir(), "mission-seed-cold-tree-")), "check");
  gitIn(fixture.clone, "worktree", "add", "-q", "--detach", tree, fixture.sha);
  const result = await m.claimDisposableTree({
    repositoryPath: fixture.clone,
    path: tree,
    baseSha: fixture.sha,
    owner: { kind: "check", key: "cold-attempt" },
  });
  assert.deepEqual(result, { kind: "succeeded" });
  assert.deepEqual(sources, [join(slotAt(m, 1).path, "deps"), join(slotAt(m, 1).path, "more")]);
  assert.equal(readFileSync(join(tree, "deps", "marker"), "utf8"), slotAt(m, 1).path);
  assert.equal(runCount(tree), 0, "the source matched this commit, so no step ran");
  assert.equal(slotAt(m, 1).state, "available");
});
