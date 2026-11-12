import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  WorktreeClaimSchema,
  WorktreesConfigPatchSchema,
  WorktreesConfigSchema,
  type WorktreeClaim,
} from "../src/shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";
import { openDb } from "../src/server/db.ts";
import {
  getWorktreesConfig,
  resolveWorktreePolicy,
  setWorktreesConfig,
} from "../src/server/worktrees/config.ts";
import {
  WorktreeManager,
  type NativeWorktreeLease,
  type WorktreeAcquireResult,
  type WorktreeManagerDeps,
} from "../src/server/worktrees/manager.ts";
import {
  buildClaimEnvironment,
  claimFingerprint,
  claimVariableNames,
  claimWarningsBlock,
  decodeClaimFailure,
  describeClaimFailure,
  parseTreeBlobs,
  renderClaimArgv,
  runClaimStep,
  runClaimSteps,
  type ClaimStepResult,
} from "../src/server/worktrees/claim.ts";
import { ExecutableLocator, probeLoginShellPath } from "../src/server/executables/locator.ts";
import {
  parseSettingPayload,
  settingPayloadForEntry,
} from "../src/server/settings-backups/config-registry.ts";
import { WORKTREE_POOL_MARKER } from "../src/server/worktrees/marker.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// The dependency claim, end to end through the real manager, real Git and real child
// processes. Steps are small `node -e` programs, so a claim's environment, output, timeout and
// process group are all observed from the outside rather than asserted about a fake.

const db = openDb();
const DAEMON_TOKEN = "daemon-admission-token-for-claims";
const DAEMON_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ALPHA_TOKEN: "alpha-value",
  BETA_TOKEN: "beta-value",
  GAMMA_TOKEN: "gamma-value",
  PLAIN_SETTING: "plain-value",
  LEAKY_URL: `https://x/?auth=${DAEMON_TOKEN}`,
};

// A claim a test left hanging on purpose. Its deadline is a live 10-minute timer, so the
// worker cannot exit until this is stopped, and that once held the file open for 10 minutes
// after its last test had passed.
const abandoned: WorktreeManager[] = [];

afterEach(async () => {
  await Promise.all(abandoned.splice(0).map((m) => m.stop()));
  db.exec(
    "DELETE FROM worktree_slots; DELETE FROM worktree_pools; " +
      "DELETE FROM app_config WHERE key = 'worktrees';",
  );
});

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
}

function claimOf(input: unknown): WorktreeClaim {
  return WorktreeClaimSchema.parse(input);
}

/** A `node -e` step. Runs in the slot, so relative paths land in the leased tree. */
function node(code: string): string[] {
  return [process.execPath, "-e", code];
}

/** Appends one JSON line naming the variables this step can see, to `deps/<name>.log`. */
function recordStep(name: string): string[] {
  return node(
    `const fs=require("fs");fs.mkdirSync("deps",{recursive:true});` +
      `const seen={};for(const k of ["ALPHA_TOKEN","BETA_TOKEN","GAMMA_TOKEN","DELTA_TOKEN","PLAIN_SETTING","LEAKY_URL","MISSION_API_TOKEN"])seen[k]=process.env[k]??null;` +
      `seen.MISSION_HOME=process.env.MISSION_HOME??null;` +
      `fs.appendFileSync("deps/${name}.log",JSON.stringify(seen)+"\\n");`,
  );
}

function runs(path: string, name: string): Array<Record<string, string | null>> {
  const file = join(path, "deps", `${name}.log`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

/** A repository whose `deps/` is ignored, so step output never dirties the tree. */
function repository(prefix: string): { origin: string; clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, ".gitignore"), "deps/\n");
  writeFileSync(join(origin, "lock.txt"), "v1\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "lockfile");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

/** Commit one file change in origin and make the clone see it. Returns the new commit. */
function advance(fixture: { origin: string; clone: string }, file: string, content: string): string {
  writeFileSync(join(fixture.origin, file), content);
  gitIn(fixture.origin, "add", "-A");
  gitIn(fixture.origin, "commit", "-qm", `change ${file}`);
  gitIn(fixture.clone, "fetch", "-q", "origin");
  return gitIn(fixture.clone, "rev-parse", "origin/main");
}

function manager(claim: WorktreeClaim | null, deps: Partial<WorktreeManagerDeps> = {}): WorktreeManager {
  return new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: null, claim }),
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: DAEMON_ENV, daemonToken: DAEMON_TOKEN, loginShell: {} }),
    ...deps,
  });
}

function taskAcquire(m: WorktreeManager, clone: string, sha: string, key: string) {
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function onlySlot(m: WorktreeManager) {
  const slots = m.store.slots();
  assert.equal(slots.length, 1);
  return slots[0]!;
}

// ---- settings ----

test("the claim schema is strict, bounded and defaulted like setupArgv", () => {
  const parsed = claimOf({ steps: [{ argv: ["yarn", "install"] }] });
  assert.deepEqual(parsed, {
    steps: [{ argv: ["yarn", "install"], env: [] }],
    timeoutMinutes: 10,
    fingerprintPaths: [],
  });
  assert.equal(claimOf({ steps: [{ argv: ["x"] }], timeoutMinutes: 240 }).timeoutMinutes, 240);
  for (const bad of [
    { steps: [] },
    { steps: [{ argv: [] }] },
    { steps: [{ argv: ["x"] }], timeoutMinutes: 241 },
    { steps: [{ argv: ["x"] }], timeoutMinutes: 0 },
    { steps: [{ argv: ["x"] }], timeoutMinutes: 1.5 },
    { steps: [{ argv: ["x"], shell: true }] },
    { steps: [{ argv: ["x"] }], extra: 1 },
    { steps: Array.from({ length: 17 }, () => ({ argv: ["x"] })) },
    { steps: [{ argv: Array.from({ length: 33 }, () => "a") }] },
    { steps: [{ argv: ["x".repeat(4097)] }] },
    { steps: [{ argv: ["x"], env: ["NOT-A-NAME"] }] },
    { steps: [{ argv: ["x"], env: ["A_TOKEN", "A_TOKEN"] }] },
    { steps: [{ argv: ["x"], env: ["PATH"] }] },
    { steps: [{ argv: ["x"], env: ["MISSION_API_TOKEN"] }] },
    { steps: [{ argv: ["x"], env: ["HARNESS_HOME"] }] },
    { steps: [{ argv: ["x"], env: Array.from({ length: 33 }, (_, i) => `V${i}`) }] },
    { steps: [{ argv: ["x"] }], fingerprintPaths: Array.from({ length: 65 }, () => "a") },
    { steps: [{ argv: ["x"] }], fingerprintPaths: [""] },
  ]) {
    assert.throws(() => WorktreeClaimSchema.parse(bad), JSON.stringify(bad).slice(0, 80));
  }
});

test("the claim schema accepts every documented maximum exactly", () => {
  const atMost = claimOf({
    steps: [
      { argv: Array.from({ length: 32 }, () => "a".repeat(4096)), env: Array.from({ length: 32 }, (_, i) => `V${i}`) },
      ...Array.from({ length: 15 }, () => ({ argv: ["x"] })),
    ],
    timeoutMinutes: 240,
    fingerprintPaths: [...Array.from({ length: 63 }, (_, i) => `p${i}`), "f".repeat(1024)],
  });
  assert.equal(atMost.steps.length, 16);
  assert.equal(atMost.steps[0]!.env.length, 32);
  assert.equal(atMost.fingerprintPaths.length, 64);
  assert.equal(claimOf({ steps: [{ argv: ["x"], env: ["N".repeat(128)] }] }).steps[0]!.env[0]!.length, 128);
  assert.equal(claimOf({ steps: [{ argv: ["x"] }], timeoutMinutes: 1 }).timeoutMinutes, 1);
  // One past each length limit that the table above does not already reach.
  assert.throws(() => claimOf({ steps: [{ argv: ["x"], env: ["N".repeat(129)] }] }));
  assert.throws(() => claimOf({ steps: [{ argv: ["x"] }], fingerprintPaths: ["f".repeat(1025)] }));
});

test("fingerprint paths must be repository-relative globs", () => {
  const accepted = claimOf({
    steps: [{ argv: ["x"] }],
    fingerprintPaths: ["yarn.lock", "apps/*/package.json", ".yarn/releases/**", "packages/**/package.json"],
  });
  assert.equal(accepted.fingerprintPaths.length, 4);
  for (const glob of ["/etc/passwd", "../outside.lock", "apps/../yarn.lock", "./yarn.lock", "apps//package.json", "apps/", "apps\\web\\package.json", ".."]) {
    assert.throws(() => claimOf({ steps: [{ argv: ["x"] }], fingerprintPaths: [glob] }), glob);
  }
  assert.throws(() =>
    WorktreesConfigPatchSchema.parse({
      repositories: { "/one/.git": { claim: { steps: [{ argv: ["x"] }], fingerprintPaths: ["/abs/yarn.lock"] } } },
    }),
  );
});

test("the worktrees settings API stores, replaces and removes a pool's claim", () => {
  const claim = { steps: [{ argv: ["yarn", "install"], env: ["ARTIFACTORY_AUTH_TOKEN"] }], fingerprintPaths: ["yarn.lock"] };
  setWorktreesConfig(
    WorktreesConfigPatchSchema.parse({ repositories: { "/one/.git": { setupArgv: ["true"], claim } } }),
  );
  assert.deepEqual(getWorktreesConfig().repositories["/one/.git"], {
    setupArgv: ["true"],
    claim: { ...claim, timeoutMinutes: 10 },
  });
  assert.deepEqual(resolveWorktreePolicy("/one/.git").claim, { ...claim, timeoutMinutes: 10 });
  assert.equal(resolveWorktreePolicy("/other/.git").claim, null);

  // A claim is replaced whole, and leaves the fields beside it alone.
  setWorktreesConfig(
    WorktreesConfigPatchSchema.parse({
      repositories: { "/one/.git": { claim: { steps: [{ argv: ["npm", "ci"] }], timeoutMinutes: 30 } } },
    }),
  );
  assert.deepEqual(getWorktreesConfig().repositories["/one/.git"], {
    setupArgv: ["true"],
    claim: { steps: [{ argv: ["npm", "ci"], env: [] }], timeoutMinutes: 30, fingerprintPaths: [] },
  });

  setWorktreesConfig(WorktreesConfigPatchSchema.parse({ repositories: { "/one/.git": { claim: null } } }));
  assert.deepEqual(getWorktreesConfig().repositories["/one/.git"], { setupArgv: ["true"] });
  assert.throws(() =>
    WorktreesConfigPatchSchema.parse({ repositories: { "/one/.git": { claim: { steps: [{ argv: ["x"] }], timeoutMinutes: 999 } } } }),
  );
});

test("settings backups capture the claim with the rest of the repository override", () => {
  const config = WorktreesConfigSchema.parse({
    repositories: {
      "/one/.git": {
        maxSlots: 3,
        claim: { steps: [{ argv: ["yarn", "install"], env: ["ARTIFACTORY_AUTH_TOKEN"] }], fingerprintPaths: ["yarn.lock"] },
      },
    },
  });
  const payload = settingPayloadForEntry(APP_CONFIG_ENTRIES.worktrees, config) as typeof config;
  assert.deepEqual(payload.repositories["/one/.git"]!.claim, config.repositories["/one/.git"]!.claim);
  // What a restore reads back is the same claim, names only: there is no value to capture.
  assert.deepEqual(parseSettingPayload(APP_CONFIG_ENTRIES.worktrees, JSON.parse(JSON.stringify(payload))), payload);
  assert.doesNotMatch(JSON.stringify(payload), /alpha-value|beta-value/);
});

// ---- environment ----

test("each step gets the scrubbed check base plus only the variables it names", () => {
  const one = buildClaimEnvironment({ names: ["ALPHA_TOKEN"], daemonEnv: DAEMON_ENV, daemonToken: DAEMON_TOKEN, loginShell: {} });
  const none = buildClaimEnvironment({ names: [], daemonEnv: DAEMON_ENV, daemonToken: DAEMON_TOKEN, loginShell: {} });
  try {
    assert.equal(one.env.ALPHA_TOKEN, "alpha-value");
    assert.equal(one.env.BETA_TOKEN, undefined, "a credential-shaped name nobody named is absent");
    assert.equal(one.env.GAMMA_TOKEN, undefined);
    assert.equal(one.env.PLAIN_SETTING, "plain-value", "the base keeps ordinary variables");
    assert.equal(one.env.LEAKY_URL, undefined, "a value carrying the daemon token is scrubbed");
    assert.deepEqual(one.received, ["ALPHA_TOKEN"]);
    assert.deepEqual(one.missing, []);
    assert.equal(none.env.ALPHA_TOKEN, undefined);
    assert.notEqual(one.env.MISSION_HOME, process.env.HARNESS_HOME, "the child has its own disposable home");
  } finally {
    rmSync(one.env.MISSION_HOME!, { recursive: true, force: true });
    rmSync(none.env.MISSION_HOME!, { recursive: true, force: true });
  }
});

test("a name missing from the daemon environment falls back to the login shell, never to the token", () => {
  const built = buildClaimEnvironment({
    names: ["DELTA_TOKEN", "ALPHA_TOKEN", "EMPTY_TOKEN", "LEAKY_URL"],
    daemonEnv: { ...DAEMON_ENV, EMPTY_TOKEN: "" },
    daemonToken: DAEMON_TOKEN,
    loginShell: { DELTA_TOKEN: "delta-from-shell", ALPHA_TOKEN: "shell-loses" },
  });
  try {
    assert.equal(built.env.DELTA_TOKEN, "delta-from-shell");
    assert.equal(built.env.ALPHA_TOKEN, "alpha-value", "the daemon's own value wins");
    assert.equal(built.env.EMPTY_TOKEN, undefined);
    assert.equal(built.env.LEAKY_URL, undefined, "a named variable carrying the daemon token is refused");
    assert.deepEqual(built.received, ["DELTA_TOKEN", "ALPHA_TOKEN"]);
    assert.deepEqual(built.missing, ["EMPTY_TOKEN", "LEAKY_URL"]);
  } finally {
    rmSync(built.env.MISSION_HOME!, { recursive: true, force: true });
  }
});

test("the locator's one login-shell read captures named variables alongside PATH", async () => {
  const asked: Array<readonly string[]> = [];
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  const locator = new ExecutableLocator({
    env,
    probeLoginShell: async (_env, variables) => {
      asked.push([...variables]);
      return {
        path: "/login/bin",
        problem: null,
        variables: Object.fromEntries(variables.filter((name) => name !== "UNSET_TOKEN").map((name) => [name, `${name}-value`])),
      };
    },
  });
  assert.deepEqual(await locator.loginShellVariables(["DELTA_TOKEN", "UNSET_TOKEN"]), { DELTA_TOKEN: "DELTA_TOKEN-value" });
  assert.deepEqual(asked.at(-1), ["DELTA_TOKEN", "UNSET_TOKEN"]);
  const probes = asked.length;
  assert.deepEqual(await locator.loginShellVariables(["DELTA_TOKEN"]), { DELTA_TOKEN: "DELTA_TOKEN-value" });
  assert.equal(asked.length, probes, "an already-captured name does not force another probe");
  assert.equal(env.DELTA_TOKEN, undefined, "values never enter the daemon's own environment");
  assert.equal(locator.snapshot().path.includes("/login/bin"), true, "PATH is still read by the same probe");
});

test("a name added while a forced probe is in flight is read by the next probe, not left unread", async () => {
  const asked: Array<readonly string[]> = [];
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const locator = new ExecutableLocator({
    env: { PATH: "/usr/bin" },
    probeLoginShell: async (_env, variables) => {
      asked.push([...variables]);
      if (asked.length === 1) await firstHeld;
      return {
        path: "/login/bin",
        problem: null,
        variables: Object.fromEntries(variables.map((name) => [name, `${name}-value`])),
      };
    },
  });
  const starting = locator.initialize();
  await waitFor(() => asked.length === 1, "the forced startup probe to begin");
  const reading = locator.loginShellVariables(["LATE_TOKEN"]);
  releaseFirst();
  await starting;
  assert.deepEqual(await reading, { LATE_TOKEN: "LATE_TOKEN-value" });
  assert.deepEqual(asked, [[], ["LATE_TOKEN"]]);
});

test("the real login-shell probe prints each variable between its own markers", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-claim-shell-"));
  const shell = join(root, "shell");
  writeFileSync(
    shell,
    [
      `#!${process.execPath}`,
      `const script = process.argv[3];`,
      `require("node:fs").writeFileSync(${JSON.stringify(join(root, "script"))}, script);`,
      `require("node:child_process").execFileSync("/bin/sh", ["-c", script], { stdio: "inherit" });`,
      "",
    ].join("\n"),
  );
  chmodSync(shell, 0o755);
  try {
    const result = await probeLoginShellPath(
      {
        SHELL: shell,
        PATH: "/usr/bin:/bin",
        DELTA_TOKEN: "delta $(not run) `nor this`",
        DELTA_TOKEN__B: "the longer name",
        BLANK_TOKEN: "",
      },
      10_000,
      ["DELTA_TOKEN__B", "DELTA_TOKEN", "BLANK_TOKEN", "UNSET_TOKEN"],
    );
    assert.equal(result.path, "/usr/bin:/bin");
    assert.deepEqual(result.variables, {
      DELTA_TOKEN: "delta $(not run) `nor this`",
      DELTA_TOKEN__B: "the longer name",
    });
    assert.match(readFileSync(join(root, "script"), "utf8"), /"\$DELTA_TOKEN"/);
    // Without names the read is exactly the PATH read it always was.
    assert.deepEqual(await probeLoginShellPath({ SHELL: shell, PATH: "/usr/bin" }, 10_000), {
      path: "/usr/bin",
      problem: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- fingerprint ----

test("the fingerprint hashes matching blob ids, every argv and every variable name", () => {
  const blobs = parseTreeBlobs(
    [
      "100644 blob aaa\tyarn.lock",
      "100644 blob bbb\tapps/web/package.json",
      "100644 blob ccc\tapps/web/src/index.ts",
      "160000 commit ddd\tvendor/sub",
      "",
    ].join("\0"),
  );
  assert.deepEqual(blobs.map((blob) => blob.path), ["yarn.lock", "apps/web/package.json", "apps/web/src/index.ts", "vendor/sub"]);
  const base = claimOf({ steps: [{ argv: ["yarn", "install"], env: ["A_TOKEN"] }], fingerprintPaths: ["yarn.lock", "apps/*/package.json"] });
  const fingerprint = claimFingerprint(base, blobs)!;
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(claimFingerprint(base, [...blobs].reverse()), fingerprint, "order of the tree listing is irrelevant");
  const sourceOnly = blobs.map((blob) => (blob.path.endsWith(".ts") ? { ...blob, object: "eee" } : blob));
  assert.equal(claimFingerprint(base, sourceOnly), fingerprint, "a path outside fingerprintPaths does not count");
  const lockChanged = blobs.map((blob) => (blob.path === "yarn.lock" ? { ...blob, object: "fff" } : blob));
  assert.notEqual(claimFingerprint(base, lockChanged), fingerprint);
  assert.notEqual(claimFingerprint({ ...base, steps: [{ argv: ["yarn", "install", "--immutable"], env: ["A_TOKEN"] }] }, blobs), fingerprint);
  assert.notEqual(claimFingerprint({ ...base, steps: [{ argv: ["yarn", "install"], env: ["B_TOKEN"] }] }, blobs), fingerprint);
  assert.equal(claimFingerprint({ ...base, fingerprintPaths: [] }, blobs), null, "no paths means always run");
  assert.deepEqual(claimVariableNames(claimOf({ steps: [{ argv: ["a"], env: ["B", "A"] }, { argv: ["b"], env: ["A", "C"] }] })), ["A", "B", "C"]);
});

test("a matching fingerprint skips the steps, and a changed input runs them", async () => {
  const fixture = repository("mission-claim-fingerprint-");
  const claim = claimOf({ steps: [{ argv: recordStep("one") }], fingerprintPaths: ["lock.txt"] });
  const m = manager(claim);
  const first = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-fp-1"));
  assert.equal(runs(first.lease.path, "one").length, 1);
  let slot = onlySlot(m);
  assert.equal(slot.depsState, "current");
  assert.match(slot.depsFingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.equal(slot.depsFingerprintSha, fixture.sha);
  assert.equal(first.claimWarning, undefined);
  assert.equal((await m.release(first.lease)).outcome, "released");

  const second = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-fp-2"));
  assert.equal(runs(second.lease.path, "one").length, 1, "same inputs skip the steps");
  assert.equal((await m.release(second.lease)).outcome, "released");

  const unrelated = advance(fixture, "keep.txt", "unrelated\n");
  const third = leased(await taskAcquire(m, fixture.clone, unrelated, "task-fp-3"));
  assert.equal(runs(third.lease.path, "one").length, 1, "a file outside fingerprintPaths does not rerun");
  assert.equal((await m.release(third.lease)).outcome, "released");

  const lockChanged = advance(fixture, "lock.txt", "v2\n");
  const fourth = leased(await taskAcquire(m, fixture.clone, lockChanged, "task-fp-4"));
  assert.equal(runs(fourth.lease.path, "one").length, 2, "a changed lockfile blob reruns the steps");
  slot = onlySlot(m);
  assert.equal(slot.depsFingerprintSha, lockChanged);
  assert.equal((await m.release(fourth.lease)).outcome, "released");

  // Changing the claim's own argv is a mismatch too.
  const changed = manager(claimOf({ steps: [{ argv: [...recordStep("one"), "extra-arg"] }], fingerprintPaths: ["lock.txt"] }));
  const fifth = leased(await taskAcquire(changed, fixture.clone, lockChanged, "task-fp-5"));
  assert.equal(runs(fifth.lease.path, "one").length, 3);
  await changed.release(fifth.lease);
});

test("an empty fingerprintPaths runs the claim on every lease", async () => {
  const fixture = repository("mission-claim-always-");
  const m = manager(claimOf({ steps: [{ argv: recordStep("one") }] }));
  const first = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-always-1"));
  assert.equal(onlySlot(m).depsFingerprint, null);
  assert.equal(onlySlot(m).depsState, "current");
  await m.release(first.lease);
  const second = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-always-2"));
  assert.equal(runs(second.lease.path, "one").length, 2);
  await m.release(second.lease);
});

test("fingerprint paths that match no file still fingerprint the steps, so an identical lease skips", async () => {
  const unmatched = claimOf({ steps: [{ argv: ["yarn"], env: ["A_TOKEN"] }], fingerprintPaths: ["no-such.lock"] });
  const fingerprint = claimFingerprint(unmatched, parseTreeBlobs("100644 blob aaa\tyarn.lock\0"));
  assert.match(fingerprint ?? "", /^[0-9a-f]{64}$/, "zero matches is not the same as no fingerprint paths");
  assert.notEqual(claimFingerprint({ ...unmatched, steps: [{ argv: ["npm"], env: ["A_TOKEN"] }] }, []), fingerprint);

  const fixture = repository("mission-claim-unmatched-");
  const m = manager(claimOf({ steps: [{ argv: recordStep("one") }], fingerprintPaths: ["no-such.lock"] }));
  const first = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-unmatched-1"));
  assert.match(onlySlot(m).depsFingerprint ?? "", /^[0-9a-f]{64}$/);
  await m.release(first.lease);
  const second = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-unmatched-2"));
  assert.equal(runs(second.lease.path, "one").length, 1, "the identical second lease skipped the steps");
  await m.release(second.lease);
});

test("on a new slot a task's claim runs after the setup command has finished", async () => {
  const fixture = repository("mission-claim-after-setup-");
  const order: string[] = [];
  const claim = claimOf({
    steps: [
      { argv: node(`if(!require("fs").existsSync("deps/setup.done"))process.exit(9)`) },
      { argv: recordStep("one") },
    ],
  });
  const m = manager(
    claim,
    {
      resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: ["setup"], claim }),
      runSetup: async (_argv, cwd) => {
        order.push("setup");
        mkdirSync(join(cwd, "deps"), { recursive: true });
        // Finishes later than it starts, so a claim that did not wait for it would miss the file.
        await new Promise((resolve) => setTimeout(resolve, 200));
        writeFileSync(join(cwd, "deps", "setup.done"), "ok\n");
        return { ok: true, reason: null, outcomeUnknown: false };
      },
    },
  );
  const result = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-after-setup"));
  assert.deepEqual(order, ["setup"]);
  assert.equal(result.claimWarning, undefined, "the first step saw setup's completed effect");
  assert.equal(runs(result.lease.path, "one").length, 1);
  assert.equal(onlySlot(m).depsState, "current");
  await m.release(result.lease);
});

test("a lease that does not ask for the claim does not run it", async () => {
  // An acquire without `runClaim`, whatever its owner kind: the manual acquire the route answers
  // synchronously because its pool had no claim when it asked. Task dispatch, check attempts and
  // the background manual acquire all ask for it; see test/manual-worktree-claim-http.test.ts.
  const fixture = repository("mission-claim-other-kinds-");
  const m = manager(claimOf({ steps: [{ argv: recordStep("one") }] }));
  const manual = leased(await m.acquire({ repositoryPath: fixture.clone, baseSha: fixture.sha, owner: { kind: "manual", key: "m1" } }));
  assert.equal(runs(manual.lease.path, "one").length, 0);
  assert.equal(onlySlot(m).depsState, null);
  await m.release(manual.lease, { ownerAuthorized: true });
  const check = leased(await m.acquire({ repositoryPath: fixture.clone, baseSha: fixture.sha, owner: { kind: "check", key: "attempt-1" } }));
  assert.equal(runs(check.lease.path, "one").length, 0);
  await m.release(check.lease, { ownerAuthorized: true });
});

// ---- failure and proof ----

test("a failing step hands the slot over with a warning and clears the fingerprint", async () => {
  const fixture = repository("mission-claim-failure-");
  const claim = claimOf({
    steps: [
      { argv: recordStep("one") },
      { argv: node(`process.stdout.write("resolving packages\\n");process.stderr.write("YN0001: registry refused\\n");process.exit(3)`) },
      { argv: recordStep("three") },
    ],
    fingerprintPaths: ["lock.txt"],
  });
  const m = manager(claim);
  const result = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-fail-1"));
  assert.ok(result.claimWarning, "the lease carries the warning");
  assert.equal(result.claimWarning.step, 2);
  assert.equal(result.claimWarning.stepCount, 3);
  assert.equal(result.claimWarning.reason, "exited with code 3");
  assert.match(result.claimWarning.tail, /resolving packages[\s\S]*YN0001: registry refused/);
  assert.equal(runs(result.lease.path, "three").length, 0, "a failing step stops the claim");
  const slot = onlySlot(m);
  assert.equal(slot.state, "leased", "never quarantined for an exit code");
  assert.equal(slot.depsState, "failed");
  assert.equal(slot.depsFingerprint, null);
  const recorded = decodeClaimFailure(slot.depsLastError ?? "");
  assert.equal(recorded.step, 2);
  assert.equal(recorded.stepCount, 3);
  assert.equal(recorded.reason, "exited with code 3");
  assert.match(recorded.tail, /registry refused/);
  assert.equal((await m.release(result.lease)).outcome, "released");

  const retry = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-fail-2"));
  assert.equal(runs(retry.lease.path, "one").length, 2, "a failed claim is never skipped");
  assert.ok(retry.claimWarning);
  await m.release(retry.lease);
});

test("a step that cannot start fails the claim and still hands the slot over", async () => {
  const fixture = repository("mission-claim-cannot-start-");
  const started: string[] = [];
  const m = manager(
    claimOf({ steps: [{ argv: ["yarn", "install"] }, { argv: ["yarn", "rebuild"] }], fingerprintPaths: ["lock.txt"] }),
    {
      runClaimStep: async (request): Promise<ClaimStepResult> => {
        started.push(request.argv.join(" "));
        return { outcome: "spawnFailed", reason: 'executable "yarn" was not found in the executable environment' };
      },
    },
  );
  const result = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-cannot-start"));
  assert.deepEqual(started, ["yarn install"], "the remaining steps do not run");
  assert.equal(result.claimWarning?.step, 1);
  assert.equal(
    result.claimWarning?.reason,
    'could not start: executable "yarn" was not found in the executable environment',
  );
  const slot = onlySlot(m);
  assert.equal(slot.state, "leased", "never quarantined for a step that cannot start");
  assert.equal(slot.depsState, "failed");
  assert.equal(slot.depsFingerprint, null);
  const recorded = decodeClaimFailure(slot.depsLastError ?? "");
  assert.equal(recorded.step, 1);
  assert.equal(recorded.command, "yarn install");
  assert.match(recorded.reason, /^could not start/);
  await m.release(result.lease);
});

test("a claim that dirties a tracked file still fails the final proof", async () => {
  const fixture = repository("mission-claim-dirty-");
  const m = manager(claimOf({ steps: [{ argv: node(`require("fs").writeFileSync("keep.txt","rewritten\\n")`) }] }));
  const result = await taskAcquire(m, fixture.clone, fixture.sha, "task-dirty");
  assert.equal(result.outcome, "outcomeUnknown");
  const slot = onlySlot(m);
  assert.equal(slot.state, "quarantined");
  assert.equal(slot.quarantineReason, "materialized slot verification failed");
});

test("a timeout kills the step's whole process group and counts as a failed claim", async () => {
  const fixture = repository("mission-claim-timeout-");
  const grandchild = node(
    `const fs=require("fs");const {spawn}=require("child_process");fs.mkdirSync("deps",{recursive:true});` +
      `const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});` +
      `fs.writeFileSync("deps/grandchild.pid",String(c.pid));setInterval(()=>{},1000);`,
  );
  const m = manager(claimOf({ steps: [{ argv: grandchild }, { argv: recordStep("after") }] }), {
    // The schema's smallest limit is a minute; the runner's own timer is what is under test.
    runClaimStep: (request) => runClaimStep({ ...request, timeoutMs: Math.min(request.timeoutMs, 750) }),
  });
  const result = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-timeout"));
  assert.equal(result.claimWarning?.reason, "timed out at the claim's 10-minute limit");
  assert.equal(runs(result.lease.path, "after").length, 0);
  const pid = Number(readFileSync(join(result.lease.path, "deps", "grandchild.pid"), "utf8"));
  await waitFor(() => !alive(pid), "the grandchild to die with its group");
  assert.equal(onlySlot(m).depsState, "failed");
  await m.release(result.lease);
});

test("the claim's deadline covers every step together", async () => {
  let clock = 0;
  const started: string[] = [];
  const outcome = await runClaimSteps({
    claim: claimOf({ steps: [{ argv: ["first"] }, { argv: ["second"] }], timeoutMinutes: 1 }),
    cwd: "/nowhere",
    signal: new AbortController().signal,
    environment: async () => ({ env: {}, received: [], missing: [] }),
    runStep: async (request): Promise<ClaimStepResult> => {
      started.push(request.argv[0]!);
      assert.equal(request.timeoutMs, 60_000 - clock);
      clock += 60_001;
      return { outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 };
    },
    now: () => clock,
  });
  assert.deepEqual(started, ["first"]);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.warning.step, 2);
  assert.equal(!outcome.ok && outcome.warning.reason, "timed out at the claim's 1-minute limit");
});

test("building a step's environment spends the claim's deadline, and the step gets what is left", async () => {
  const exited: ClaimStepResult = { outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 };
  const emptyEnv = { env: {}, received: [], missing: [] };
  const claim = claimOf({ steps: [{ argv: ["first"] }, { argv: ["second"] }], timeoutMinutes: 1 });

  // A slow environment for the second step leaves it only the remainder.
  let clock = 0;
  const budgets: number[] = [];
  const shared = await runClaimSteps({
    claim,
    cwd: "/nowhere",
    signal: new AbortController().signal,
    environment: async () => {
      clock += 20_000;
      return emptyEnv;
    },
    runStep: async (request) => {
      budgets.push(request.timeoutMs);
      clock += 10_000;
      return exited;
    },
    now: () => clock,
  });
  assert.equal(shared.ok, true);
  assert.deepEqual(budgets, [40_000, 10_000], "each step is handed the deadline as it stands after its environment");

  // An environment that uses up the whole deadline never reaches its step.
  clock = 0;
  const ran: string[] = [];
  const exhausted = await runClaimSteps({
    claim,
    cwd: "/nowhere",
    signal: new AbortController().signal,
    environment: async () => {
      clock += 60_000;
      return emptyEnv;
    },
    runStep: async (request) => {
      ran.push(request.argv[0]!);
      return exited;
    },
    now: () => clock,
  });
  assert.deepEqual(ran, []);
  assert.equal(!exhausted.ok && exhausted.warning.step, 1);
  assert.equal(!exhausted.ok && exhausted.warning.reason, "timed out at the claim's 1-minute limit");

  // An environment that never answers is cut off by the deadline itself, in real time.
  const started = Date.now();
  let reads = 0;
  const hung = await runClaimSteps({
    claim,
    cwd: "/nowhere",
    signal: new AbortController().signal,
    environment: () => new Promise(() => {}),
    runStep: async () => exited,
    // The deadline is set from the first read; every later read is 50 ms before it.
    now: () => (reads++ === 0 ? 0 : 60_000 - 50),
  });
  assert.equal(!hung.ok && hung.warning.reason, "timed out at the claim's 1-minute limit");
  assert.ok(Date.now() - started < 5_000, "the hung environment did not hold the claim");

  // A stop while the environment is being built stops the claim.
  const controller = new AbortController();
  const stopping = runClaimSteps({
    claim,
    cwd: "/nowhere",
    signal: controller.signal,
    environment: () => new Promise(() => {}),
    runStep: async () => exited,
    now: () => 0,
  });
  controller.abort("shutdown");
  const stopped = await stopping;
  assert.equal(!stopped.ok && stopped.stopped, true);
});

test("resolving a step's executable spends the step's budget, and a late resolution launches nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-claim-resolve-"));
  const marker = join(root, "launched");
  const launches = node(`require("fs").writeFileSync(${JSON.stringify(marker)}, "x");setInterval(()=>{},1000)`);
  const real = { path: process.execPath, env: { PATH: process.env.PATH } };
  const delayed = (ms: number) => () =>
    new Promise<typeof real>((resolve) => setTimeout(() => resolve(real), ms));
  const request = (timeoutMs: number, signal = new AbortController().signal) => ({
    argv: launches,
    cwd: root,
    env: { PATH: process.env.PATH },
    timeoutMs,
    signal,
  });
  try {
    // Resolution outlasts the whole budget: the step times out, and the resolver's answer,
    // arriving afterwards, never starts a process.
    const late = await runClaimStep(request(100), { resolveCommand: delayed(400) });
    assert.deepEqual(late, { outcome: "timedOut", tail: "", truncatedBytes: 0 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(existsSync(marker), false, "no process was launched for a late resolution");

    // Resolution spends most of the budget: the process gets only what is left. The clock reads
    // 1,400 ms gone after resolving, so a 2,000 ms budget leaves the process 600 ms, which is
    // enough for it to start and well short of the 2,000 ms a stale budget would give it.
    let reads = 0;
    const started = Date.now();
    const squeezed = await runClaimStep(request(2_000), {
      resolveCommand: delayed(10),
      now: () => (reads++ === 0 ? 0 : 1_400),
    });
    assert.equal(squeezed.outcome, "timedOut");
    assert.ok(Date.now() - started < 1_500, "the process was not handed the stale full budget");
    assert.equal(existsSync(marker), true, "it did start, with the remainder");
    rmSync(marker, { force: true });

    // A stop while resolving reports stopped and launches nothing.
    const controller = new AbortController();
    const stopping = runClaimStep(request(10_000, controller.signal), { resolveCommand: delayed(300) });
    controller.abort("shutdown");
    assert.deepEqual(await stopping, { outcome: "stopped", tail: "", truncatedBytes: 0 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(existsSync(marker), false, "no process was launched after the stop");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output size never fails a step, and the tail keeps the last 4,000 bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-claim-output-"));
  try {
    const loud = await runClaimStep({
      argv: node(`process.stdout.write("x".repeat(2*1024*1024)+"THE-END")`),
      cwd: root,
      env: { PATH: process.env.PATH },
      timeoutMs: 30_000,
      signal: new AbortController().signal,
    });
    assert.equal(loud.outcome, "exited");
    assert.equal(loud.outcome === "exited" && loud.code, 0);
    assert.equal(loud.outcome === "exited" && Buffer.byteLength(loud.tail), 4_000);
    assert.equal(loud.outcome === "exited" && loud.tail.endsWith("THE-END"), true);
    assert.equal(loud.outcome === "exited" && loud.truncatedBytes, 2 * 1024 * 1024 + 7 - 4_000);
    const stdin = await runClaimStep({
      argv: node(`process.stdin.on("data",()=>{});process.stdin.on("end",()=>process.exit(0))`),
      cwd: root,
      env: { PATH: process.env.PATH },
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    assert.equal(stdin.outcome === "exited" && stdin.code, 0, "stdin is closed, so a reader sees end-of-input at once");
    const missing = await runClaimStep({
      argv: ["mission-claim-no-such-binary"],
      cwd: root,
      env: { PATH: "/nonexistent" },
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    assert.equal(missing.outcome, "spawnFailed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each step's process sees exactly the variables it names", async () => {
  const fixture = repository("mission-claim-env-");
  const m = manager(
    claimOf({
      steps: [
        { argv: recordStep("alpha"), env: ["ALPHA_TOKEN"] },
        { argv: recordStep("beta"), env: ["BETA_TOKEN", "DELTA_TOKEN"] },
      ],
    }),
    {
      claimEnvironment: async (names) =>
        buildClaimEnvironment({
          names,
          daemonEnv: DAEMON_ENV,
          daemonToken: DAEMON_TOKEN,
          loginShell: { DELTA_TOKEN: "delta-from-login-shell" },
        }),
    },
  );
  const result = leased(await taskAcquire(m, fixture.clone, fixture.sha, "task-env"));
  const [alpha] = runs(result.lease.path, "alpha");
  const [beta] = runs(result.lease.path, "beta");
  assert.deepEqual(
    { ...alpha, MISSION_HOME: undefined },
    { ALPHA_TOKEN: "alpha-value", BETA_TOKEN: null, GAMMA_TOKEN: null, DELTA_TOKEN: null, PLAIN_SETTING: "plain-value", LEAKY_URL: null, MISSION_API_TOKEN: null, MISSION_HOME: undefined },
  );
  assert.deepEqual(
    { ...beta, MISSION_HOME: undefined },
    { ALPHA_TOKEN: null, BETA_TOKEN: "beta-value", GAMMA_TOKEN: null, DELTA_TOKEN: "delta-from-login-shell", PLAIN_SETTING: "plain-value", LEAKY_URL: null, MISSION_API_TOKEN: null, MISSION_HOME: undefined },
  );
  assert.notEqual(alpha!.MISSION_HOME, beta!.MISSION_HOME, "each step gets its own disposable home");
  assert.equal(existsSync(alpha!.MISSION_HOME!), false, "and it is removed after the step");
  await m.release(result.lease);
});

test("setup runs on the scrubbed base with the union of the pool's claim names", async () => {
  const fixture = repository("mission-claim-setup-env-");
  const seen: NodeJS.ProcessEnv[] = [];
  const claim = claimOf({ steps: [{ argv: ["true"], env: ["ALPHA_TOKEN"] }, { argv: ["true"], env: ["BETA_TOKEN"] }] });
  const m = new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: ["setup"], claim }),
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: DAEMON_ENV, daemonToken: DAEMON_TOKEN, loginShell: {} }),
    runSetup: async (_argv, _cwd, env) => {
      seen.push({ ...env });
      return { ok: true, reason: null, outcomeUnknown: false };
    },
    runClaimStep: async () => ({ outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 }),
  });
  // A manual lease still runs setup on a new slot: setup's environment changed for every
  // lease kind, while the claim itself runs only for tasks.
  const held = leased(await m.acquire({ repositoryPath: fixture.clone, baseSha: fixture.sha, owner: { kind: "manual", key: "setup" } }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.ALPHA_TOKEN, "alpha-value");
  assert.equal(seen[0]!.BETA_TOKEN, "beta-value");
  assert.equal(seen[0]!.GAMMA_TOKEN, undefined, "an unlisted credential no longer reaches setup");
  assert.equal(seen[0]!.LEAKY_URL, undefined);
  assert.equal(seen[0]!.PLAIN_SETTING, "plain-value");
  assert.ok(seen[0]!.MISSION_HOME && seen[0]!.MISSION_HOME !== process.env.HARNESS_HOME);
  assert.equal(existsSync(seen[0]!.MISSION_HOME), false, "the disposable home is released after setup");
  await m.release(held.lease, { ownerAuthorized: true });
});

test("a failed setup's reason is redacted of the claim values it received before it is stored", async () => {
  const fixture = repository("mission-claim-setup-redact-");
  const claim = claimOf({ steps: [{ argv: ["true"], env: ["ALPHA_TOKEN"] }] });
  const m = new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 1, setupArgv: ["setup"], claim }),
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: DAEMON_ENV, daemonToken: DAEMON_TOKEN, loginShell: {} }),
    runSetup: async (_argv, _cwd, env) => ({
      ok: false,
      reason: `fetch https://registry.example/?token=${env.ALPHA_TOKEN} refused`,
      outcomeUnknown: false,
    }),
    runClaimStep: async () => ({ outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 }),
  });
  const result = await m.acquire({ repositoryPath: fixture.clone, baseSha: fixture.sha, owner: { kind: "manual", key: "setup-redact" } });
  assert.equal(result.outcome, "outcomeUnknown");
  assert.ok(result.outcome === "outcomeUnknown");
  assert.doesNotMatch(result.reason, /alpha-value/);
  assert.match(result.reason, /\[ALPHA_TOKEN redacted\]/);
  const slot = onlySlot(m);
  for (const stored of [slot.quarantineReason, slot.lastError]) {
    assert.doesNotMatch(stored ?? "", /alpha-value/, "the credential was stored on the slot");
  }
});

// ---- crash recovery, maintenance and shutdown ----

/** A claim that succeeds once and then hangs at the chosen point, as a crash would leave it. */
async function crashedClaim(prefix: string, at: "after-write-ahead" | "mid-step") {
  const fixture = repository(prefix);
  const claim = claimOf({ steps: [{ argv: recordStep("one") }], fingerprintPaths: ["lock.txt"] });
  const good = manager(claim);
  const first = leased(await taskAcquire(good, fixture.clone, fixture.sha, `${prefix}-1`));
  assert.equal(onlySlot(good).depsState, "current");
  const priorFingerprint = onlySlot(good).depsFingerprint;
  assert.equal((await good.release(first.lease)).outcome, "released");

  // Unchanged inputs would skip the claim, so change the lockfile: the claim then reaches its
  // write-ahead, and hangs at the chosen point.
  const sha = advance(fixture, "lock.txt", "v2\n");
  let stepStarted = false;
  const never = new Promise<never>(() => {});
  const hang: Partial<WorktreeManagerDeps> = at === "after-write-ahead"
    ? { claimEnvironment: async () => never }
    : {
        runClaimStep: async () => {
          stepStarted = true;
          return never;
        },
      };
  const crashing = manager(claim, hang);
  abandoned.push(crashing);
  void taskAcquire(crashing, fixture.clone, sha, `${prefix}-2`);
  await waitFor(
    () => onlySlot(crashing).depsState === "claiming" && (at === "after-write-ahead" || stepStarted),
    "the claim to reach its crash point",
  );
  const written = onlySlot(crashing);
  assert.equal(written.state, "provisioning");
  assert.equal(written.depsFingerprint, null, "the write-ahead cleared the fingerprint");
  return { fixture, claim, sha, priorFingerprint };
}

for (const at of ["after-write-ahead", "mid-step"] as const) {
  test(`startup quarantines a claim interrupted ${at} and nothing later skips on its fingerprint`, async () => {
    const { fixture, claim, sha, priorFingerprint } = await crashedClaim(`mission-claim-crash-${at}-`, at);
    assert.ok(priorFingerprint);

    // A fresh manager on the same database is the next daemon: no claim is running in it.
    const restarted = manager(claim);
    await restarted.reconcile();
    const recovered = onlySlot(restarted);
    assert.equal(recovered.state, "quarantined");
    assert.equal(recovered.quarantineReason, "startup found an interrupted provisioning intent");
    assert.equal(recovered.depsState, "interrupted");
    assert.equal(recovered.depsFingerprint, null);

    // Even if the slot came back to the pool at the commit whose fingerprint it once had,
    // the claim runs: nothing recorded survives to be skipped on.
    gitIn(recovered.path, "checkout", "-q", "--detach", fixture.sha);
    db.prepare(
      `UPDATE worktree_slots SET state = 'available', current_head_sha = ?, active_lease_id = NULL,
         active_owner_kind = NULL, active_owner_key = NULL, leased_at = NULL,
         quarantine_reason = NULL, last_error = NULL WHERE id = ?`,
    ).run(fixture.sha, recovered.id);
    const before = runs(recovered.path, "one").length;
    const again = leased(await taskAcquire(restarted, fixture.clone, fixture.sha, `crash-${at}-3`));
    assert.equal(runs(again.lease.path, "one").length, before + 1);
    assert.equal(onlySlot(restarted).depsFingerprint, priorFingerprint, "the rerun records the same inputs afresh");
    assert.ok(sha);
    await restarted.release(again.lease);
  });
}

test("a pool-wide startup failure still marks an interrupted claim before it quarantines the slot", async () => {
  const { claim } = await crashedClaim("mission-claim-crash-pool-", "mid-step");
  const restarted = manager(claim);
  // A missing pool marker fails the whole pool before any per-slot reconciliation runs.
  const pool = restarted.store.pools()[0]!;
  rmSync(join(pool.poolPath, WORKTREE_POOL_MARKER));
  await restarted.reconcile();
  const recovered = onlySlot(restarted);
  assert.equal(recovered.state, "quarantined");
  assert.match(recovered.quarantineReason ?? "", /pool marker/);
  assert.equal(recovered.depsState, "interrupted");
  assert.equal(recovered.depsFingerprint, null);
});

test("maintenance skips a claiming slot instead of waiting on it, and retries it next pass", async () => {
  const fixture = repository("mission-claim-maintenance-");
  let started!: () => void;
  const stepStarted = new Promise<void>((resolve) => (started = resolve));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const m = manager(claimOf({ steps: [{ argv: ["slow"] }] }), {
    runClaimStep: async () => {
      started();
      await gate;
      return { outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 };
    },
  });
  const pending = taskAcquire(m, fixture.clone, fixture.sha, "task-maint");
  await stepStarted;
  assert.deepEqual(m.claims.list().map((claim) => claim.owner), [{ kind: "task", key: "task-maint" }]);
  const pass = await Promise.race([
    m.reconcile().then(() => "finished"),
    new Promise((resolve) => setTimeout(() => resolve("waited on the claim"), 10_000)),
  ]);
  assert.equal(pass, "finished");
  const pool = m.store.pools()[0]!;
  assert.match(pool.reconciliationError ?? "", /slot 1: skipped while its dependency claim runs/);
  assert.equal(onlySlot(m).state, "provisioning", "the claiming slot was left alone");

  finish();
  const result = leased(await pending);
  assert.equal(m.claims.list().length, 0);
  await m.reconcile();
  assert.doesNotMatch(m.store.pools()[0]!.reconciliationError ?? "", /skipped/, "the next pass reconciles it");
  await m.release(result.lease);
});

test("shutdown kills a running claim, grants nothing, and startup marks it interrupted", async () => {
  const fixture = repository("mission-claim-shutdown-");
  const sleeper = node(
    `const fs=require("fs");fs.mkdirSync("deps",{recursive:true});` +
      `fs.writeFileSync("deps/leader.pid",String(process.pid));setInterval(()=>{},1000);`,
  );
  const claim = claimOf({ steps: [{ argv: sleeper }] });
  const m = manager(claim);
  const pending = taskAcquire(m, fixture.clone, fixture.sha, "task-shutdown");
  const slotPath = () => m.store.slots()[0]?.path ?? "";
  await waitFor(() => slotPath() !== "" && existsSync(join(slotPath(), "deps", "leader.pid")), "the step to start");
  const pid = Number(readFileSync(join(slotPath(), "deps", "leader.pid"), "utf8"));
  assert.equal(alive(pid), true);

  await m.stop();
  const result = await pending;
  assert.deepEqual(result, {
    outcome: "outcomeUnknown",
    reason: "the daemon stopped during this slot's dependency claim, so nothing was granted",
  });
  await waitFor(() => !alive(pid), "the claim's process to be killed");
  const left = onlySlot(m);
  assert.equal(left.state, "provisioning", "nothing was granted and nothing was settled");
  assert.equal(left.depsState, "claiming");
  assert.equal(left.leasedAt !== null && left.activeOwnerKind, "task");
  assert.deepEqual(await taskAcquire(m, fixture.clone, fixture.sha, "task-after-stop"), {
    outcome: "outcomeUnknown",
    reason: "the daemon is stopping, so no dependency claim can start",
  });

  const restarted = manager(claim);
  await restarted.reconcile();
  const recovered = onlySlot(restarted);
  assert.equal(recovered.state, "quarantined");
  assert.equal(recovered.depsState, "interrupted");
});

// ---- the agent's note ----

test("the launch-prompt note names the failing step and fences its tail safely", () => {
  assert.equal(claimWarningsBlock([]), "");
  const block = claimWarningsBlock([
    {
      path: "/pool/1/repo",
      warning: {
        step: 1,
        stepCount: 2,
        argv: ["yarn", "install", "--immutable"],
        reason: "exited with code 1",
        tail: "error ```inside``` output\n",
        truncatedBytes: 12,
      },
    },
  ]);
  assert.match(block, /^## Dependency install warning\n/);
  assert.match(block, /dependency claim for \/pool\/1\/repo failed/);
  assert.match(block, /Failing step 1 of 2: `yarn install --immutable` exited with code 1\./);
  assert.match(block, /12 earlier bytes were dropped/);
  assert.match(block, /\n````\nerror ```inside``` output\n````\n/, "the fence outgrows any backtick run in the tail");
  assert.match(block, /\n---\n$/, "the same separator the repository manifest uses");
});

test("the note and the failure record bound a huge failing command and keep the step and tail", () => {
  const argv = Array.from({ length: 32 }, (_, i) => `${i}`.padEnd(4096, "a"));
  const warning = {
    step: 3,
    stepCount: 4,
    argv,
    reason: "exited with code 1",
    tail: "THE-USEFUL-TAIL",
    truncatedBytes: 0,
  };
  const fullBytes = Buffer.byteLength(argv.join(" "));
  const rendered = renderClaimArgv(argv);
  assert.ok(Buffer.byteLength(rendered) < 600, `rendered command is ${Buffer.byteLength(rendered)} bytes`);
  assert.match(rendered, new RegExp(`\\.\\.\\. \\(${fullBytes - 512} more bytes\\)$`));
  assert.equal(renderClaimArgv(["yarn", "install"]), "yarn install", "a short command is untouched");

  const block = claimWarningsBlock([
    { path: "/pool/1/a", warning },
    { path: "/pool/1/b", warning },
  ]);
  assert.ok(Buffer.byteLength(block) < 4_000, `two failed repositories add ${Buffer.byteLength(block)} bytes`);
  assert.match(block, /Failing step 3 of 4: `0a+.*more bytes\)` exited with code 1\./);
  assert.match(block, /THE-USEFUL-TAIL/);
  const record = describeClaimFailure(warning);
  assert.match(record, /^step 3 of 4 \(0a+.*more bytes\)\) exited with code 1\nTHE-USEFUL-TAIL$/);

  // A backtick in the command cannot end its inline code span early.
  assert.match(
    claimWarningsBlock([{ path: "/p", warning: { ...warning, argv: ["sh", "-c", "echo `id`"] } }]),
    /Failing step 3 of 4: `` sh -c echo `id` `` exited/,
  );
});

test("a task lease's claim warning reaches provisionWorktree's caller", async () => {
  const { provisionWorktree } = await import("../src/server/dispatcher.ts");
  const fixture = repository("mission-claim-provision-");
  const m = manager(claimOf({ steps: [{ argv: node(`console.error("no lockfile");process.exit(1)`) }] }));
  const provisioned = await provisionWorktree(fixture.clone, "task-provision", "slug", "short", fixture.sha, 0, m);
  assert.equal(provisioned.provider, "mission");
  assert.equal(provisioned.claimWarning?.reason, "exited with code 1");
  assert.match(provisioned.claimWarning?.tail ?? "", /no lockfile/);
  const lease = m.lookupLease({ leaseId: provisioned.leaseId! });
  assert.equal(lease.state, "active");
  m.settleDomainLease(provisioned.leaseId!);
  await m.release((lease as { lease: NativeWorktreeLease }).lease, { ownerAuthorized: true });
});
