import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  WorktreeClaimSchema,
  WorktreesConfigPatchSchema,
  type WorktreeClaim,
} from "../src/shared/protocol.ts";
import type { WorktreeClaimVariableView } from "../src/shared/worktrees.ts";
import { openDb } from "../src/server/db.ts";
import {
  ClaimRegistry,
  buildClaimEnvironment,
  decodeClaimFailure,
  describeClaimFailure,
  describeClaimVariables,
  encodeClaimFailure,
  redactClaimValues,
  runClaimSteps,
  type RunningClaimStep,
} from "../src/server/worktrees/claim.ts";
import { LegacyTreehouseService } from "../src/server/worktrees/legacy-treehouse.ts";
import { WorktreeManager, type WorktreeAcquireResult } from "../src/server/worktrees/manager.ts";
import { WorktreeOperationsService, slotDependencies } from "../src/server/worktrees/operations.ts";
import type { WorktreeOccupancy } from "../src/server/worktrees/occupancy.ts";
import { CheckLeaseManager } from "../src/server/workflows/check-lease.ts";
import {
  claimErrorsFrom,
  claimFromDraft,
  draftFromClaim,
  draftNames,
  emptyClaimErrors,
  hasClaimErrors,
  hasClaimFieldErrors,
  withoutStepErrors,
  type ClaimDraft,
} from "../src/web/lib/worktree-claim-draft.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

// What Settings > Worktrees shows about a pool's dependency claim: each slot's dependency state,
// derived from the durable row, the claim running in it and the last FETCHED default branch,
// and whether each claim variable name has a value, without the value.

const db = openDb();

afterEach(() => {
  db.exec(
    "DELETE FROM worktree_slots; DELETE FROM worktree_pools; " +
      "DELETE FROM app_config WHERE key = 'worktrees';",
  );
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function row(over: Partial<Parameters<typeof slotDependencies>[0]["slot"]> = {}) {
  return {
    depsState: null,
    depsFingerprint: null,
    depsFingerprintSha: null,
    depsClaimedAt: null,
    depsLastError: null,
    ...over,
  };
}

test("a pool with no claim shows no dependency state at all", () => {
  assert.equal(
    slotDependencies({ hasClaim: false, slot: row({ depsState: "current" }), running: null, defaultSha: SHA_A, defaultFingerprint: "f" }),
    null,
  );
});

test("each durable dependency state maps to the state Settings names", () => {
  const view = (slot: ReturnType<typeof row>, defaultFingerprint: string | null = "fp-default") =>
    slotDependencies({ hasClaim: true, slot, running: null, defaultSha: SHA_B, defaultFingerprint });

  assert.equal(view(row())?.state, "never");

  const current = view(row({ depsState: "current", depsFingerprint: "fp-default", depsFingerprintSha: SHA_A, depsClaimedAt: 7 }));
  assert.deepEqual(current, { state: "current", fingerprintSha: SHA_A, claimedAt: 7, defaultSha: SHA_B });

  const stale = view(row({ depsState: "current", depsFingerprint: "fp-old", depsFingerprintSha: SHA_A }));
  assert.deepEqual(stale, { state: "stale", fingerprintSha: SHA_A, claimedAt: null, defaultSha: SHA_B },
    "stale names the default commit it was judged against, and the slot's fingerprint commit");

  // A claim with no fingerprint paths records no fingerprint and runs every lease: never stale.
  assert.equal(view(row({ depsState: "current", depsFingerprint: null, depsFingerprintSha: SHA_A }))?.state, "current");
  // An unknown default (no fetched ref, unreadable tree) is not evidence of staleness.
  assert.deepEqual(view(row({ depsState: "current", depsFingerprint: "fp-old" }), null),
    { state: "current", fingerprintSha: null, claimedAt: null, defaultSha: null },
    "a default it did not judge against is not named");

  const failed = view(row({
    depsState: "failed",
    depsLastError: encodeClaimFailure({
      step: 1, stepCount: 1, argv: ["yarn", "install"], reason: "exited with code 3", tail: "E401 Unauthorized\n", truncatedBytes: 0,
    }),
  }));
  assert.deepEqual(failed, {
    state: "failed",
    fingerprintSha: null,
    claimedAt: null,
    failure: {
      step: 1, stepCount: 1, command: "yarn install", reason: "exited with code 3", tail: "E401 Unauthorized\n", truncatedBytes: 0,
      tailWithheld: false,
    },
  }, "a failure reaches the view as fields, never as prose to parse");

  assert.equal(view(row({ depsState: "interrupted" }))?.state, "interrupted");
  // A write-ahead nobody is running behind is a claim a restart cut off.
  assert.equal(view(row({ depsState: "claiming" }))?.state, "interrupted");
  // A value a later build wrote is never trusted as current.
  assert.equal(view(row({ depsState: "seeding-v9" }))?.state, "interrupted");
});

test("a running claim is installing, with its step, command and start time", () => {
  const owner = { kind: "task" as const, key: "task-1:0" };
  const reading = slotDependencies({
    hasClaim: true,
    slot: row({ depsState: "current", depsFingerprint: "x" }),
    running: { id: "claim-1", slotId: "s", owner, startedAt: 100, step: null },
    defaultSha: SHA_A,
    defaultFingerprint: "x",
  });
  assert.deepEqual(reading, { state: "installing", claimId: "claim-1", fingerprintSha: null, claimedAt: null, startedAt: 100, step: null },
    "before step 1 it is still reading the fingerprint");

  const stepping = slotDependencies({
    hasClaim: true,
    slot: row({ depsState: "claiming" }),
    running: { id: "claim-2", slotId: "s", owner, startedAt: 100, step: { step: 2, stepCount: 3, argv: ["yarn", "rebuild"], startedAt: 150 } },
    defaultSha: SHA_A,
    defaultFingerprint: "x",
  });
  assert.deepEqual(stepping, {
    state: "installing",
    claimId: "claim-2",
    fingerprintSha: null,
    claimedAt: null,
    startedAt: 100,
    step: { step: 2, stepCount: 3, command: "yarn rebuild", startedAt: 150 },
  });
});

test("presence says where a name's value comes from and never carries the value", () => {
  const token = "daemon-token-123";
  const views = describeClaimVariables({
    names: ["FROM_DAEMON", "FROM_SHELL", "EMPTY_IN_DAEMON", "NOWHERE", "CARRIES_TOKEN"],
    daemonEnv: { FROM_DAEMON: "daemon-secret", EMPTY_IN_DAEMON: "", CARRIES_TOKEN: `x${token}x` },
    daemonToken: token,
    loginShell: { FROM_SHELL: "shell-secret", EMPTY_IN_DAEMON: "shell-fallback-secret" },
  });
  assert.deepEqual(views, [
    { name: "FROM_DAEMON", present: true, source: "daemon" },
    { name: "FROM_SHELL", present: true, source: "loginShell" },
    { name: "EMPTY_IN_DAEMON", present: true, source: "loginShell" },
    { name: "NOWHERE", present: false, source: null },
    { name: "CARRIES_TOKEN", present: false, source: null },
  ]);
  const serialized = JSON.stringify(views);
  for (const secret of ["daemon-secret", "shell-secret", "shell-fallback-secret", token]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not appear in a presence view`);
  }
});

test("presence and the step environment agree on every name", () => {
  const sources = {
    daemonEnv: { A: "1", C: "has-the-token-inside" } as NodeJS.ProcessEnv,
    daemonToken: "token-inside",
    loginShell: { B: "2" },
  };
  const names = ["A", "B", "C", "D"];
  const environment = buildClaimEnvironment({ names, ...sources });
  const presence = describeClaimVariables({ names, ...sources });
  assert.deepEqual(presence.filter((view) => view.present).map((view) => view.name), environment.received);
  assert.deepEqual(presence.filter((view) => !view.present).map((view) => view.name), environment.missing);
});

test("the registry records each step a claim reaches, and only for the claim that owns it", async () => {
  const registry = new ClaimRegistry();
  const control = registry.register("slot-1", { kind: "task", key: "t:0" }, 10)!;
  assert.equal(registry.get("slot-1")?.step, null);
  const seen: RunningClaimStep[] = [];
  let clock = 1_000;
  const outcome = await runClaimSteps({
    claim: WorktreeClaimSchema.parse({ steps: [{ argv: ["one"] }, { argv: ["two", "--x"] }] }),
    cwd: "/nowhere",
    signal: control.signal,
    environment: async () => ({ env: {}, received: [], missing: [] }),
    runStep: async () => {
      clock += 5;
      return { outcome: "exited", code: 0, signal: null, tail: "", truncatedBytes: 0 };
    },
    now: () => clock,
    onStep: (step) => {
      seen.push(step);
      registry.progress("slot-1", control, step);
    },
  });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(seen, [
    { step: 1, stepCount: 2, argv: ["one"], startedAt: 1_000 },
    { step: 2, stepCount: 2, argv: ["two", "--x"], startedAt: 1_005 },
  ]);
  assert.deepEqual(registry.get("slot-1")?.step, { step: 2, stepCount: 2, argv: ["two", "--x"], startedAt: 1_005 });

  // A stale controller from an earlier claim on the same slot cannot overwrite a newer one.
  registry.unregister("slot-1", control);
  const next = registry.register("slot-1", { kind: "task", key: "t:1" }, 20)!;
  registry.progress("slot-1", control, { step: 9, stepCount: 9, argv: ["late"], startedAt: 0 });
  assert.equal(registry.get("slot-1")?.step, null);
  registry.unregister("slot-1", next);
  assert.equal(registry.get("slot-1"), null);
});

test("the claim draft round-trips a stored claim and sends exactly what was typed", () => {
  const claim = WorktreeClaimSchema.parse({
    steps: [
      { argv: ["yarn", "install", "--immutable"], env: ["ARTIFACTORY_AUTH_TOKEN", "NPM_TOKEN"] },
      { argv: ["yarn", "rebuild"] },
    ],
    timeoutMinutes: 25,
    fingerprintPaths: ["yarn.lock", "apps/*/package.json"],
  });
  const draft = draftFromClaim(claim);
  assert.equal(draft.steps[0]!.argv, "yarn\ninstall\n--immutable");
  assert.deepEqual(claimFromDraft(draft), claim);
  assert.deepEqual(draftNames(" A_1,B_2\nC_3  "), ["A_1", "B_2", "C_3"]);
  // An argument keeps its spaces: a line is an argument, never split on whitespace.
  assert.deepEqual(
    (claimFromDraft({ steps: [{ argv: "node\n-e\nconsole.log( 1 )\n", env: "" }], timeoutMinutes: "5", fingerprintPaths: "", seedPaths: "", seedExclude: "" }) as WorktreeClaim).steps[0]!.argv,
    ["node", "-e", "console.log( 1 )"],
  );
  assert.equal(draftFromClaim(null).steps.length, 0);

  // Seeding round-trips one glob per line, and blank seed fields leave the claim unseeded.
  const seeded = WorktreeClaimSchema.parse({
    ...claim,
    seed: { paths: ["node_modules", "apps/*/node_modules"], exclude: ["**/node_modules/.cache"] },
  });
  const seededDraft = draftFromClaim(seeded);
  assert.equal(seededDraft.seedPaths, "node_modules\napps/*/node_modules");
  assert.equal(seededDraft.seedExclude, "**/node_modules/.cache");
  assert.deepEqual(claimFromDraft(seededDraft), seeded);
  assert.equal("seed" in (claimFromDraft(draft) as object), false, "an unseeded claim sends no seed at all");
});

test("the route's schema refusal lands beside the claim field that caused it", () => {
  const draft: ClaimDraft = {
    steps: [
      { argv: "yarn\ninstall", env: "GOOD_NAME bad-name" },
      { argv: "", env: "MISSION_API_TOKEN" },
    ],
    timeoutMinutes: "0",
    fingerprintPaths: "yarn.lock\n../outside.json",
    seedPaths: "node_modules\n**/node_modules",
    seedExclude: "/abs/.cache",
  };
  const parsed = WorktreesConfigPatchSchema.safeParse({
    repositories: { "/repo/.git": { claim: claimFromDraft(draft) } },
  });
  assert.equal(parsed.success, false);
  // The route answers with exactly this text as its `error` (parseBody in routes.ts).
  const errors = claimErrorsFrom(parsed.error!.message, draft);
  assert.deepEqual(errors.general, []);
  assert.equal(errors.env[0]?.length, 1);
  assert.match(errors.env[0]![0]!, /^bad-name: a variable name is letters, digits and underscores$/);
  assert.match(errors.env[1]![0]!, /^MISSION_API_TOKEN: PATH and MISSION_\/FLEET_\/HARNESS_ names are reserved$/);
  assert.equal(errors.argv[1]?.length, 1, "an empty command is refused on its own step");
  assert.equal(errors.argv[0], undefined);
  assert.equal(errors.timeoutMinutes.length, 1);
  assert.equal(errors.fingerprintPaths.length, 1);
  assert.match(errors.fingerprintPaths[0]!, /^\.\.\/outside\.json: a fingerprint path is a repository-relative glob/);
  assert.deepEqual(errors.seedPaths, ["**/node_modules: a seed path cannot use **; name each directory level, with * for one level"]);
  assert.equal(errors.seedExclude.length, 1);
  assert.match(errors.seedExclude[0]!, /^\/abs\/\.cache: a seed exclusion is a repository-relative glob/);

  // Exclusions with no seed paths are sent as typed, so the route refuses them beside the paths.
  const excludeOnly = { ...draft, steps: [{ argv: "true", env: "" }], timeoutMinutes: "10", fingerprintPaths: "", seedPaths: "", seedExclude: "**/.cache" };
  const refusedExclude = WorktreesConfigPatchSchema.safeParse({
    repositories: { "/repo/.git": { claim: claimFromDraft(excludeOnly) } },
  });
  assert.equal(refusedExclude.success, false);
  assert.equal(claimErrorsFrom(refusedExclude.error!.message, excludeOnly).seedPaths.length, 1);

  const blankTimeout = { ...draft, steps: [{ argv: "true", env: "" }], timeoutMinutes: "", fingerprintPaths: "", seedPaths: "", seedExclude: "" };
  const refusedBlank = WorktreesConfigPatchSchema.safeParse({
    repositories: { "/repo/.git": { claim: claimFromDraft(blankTimeout) } },
  });
  assert.equal(refusedBlank.success, false, "a blank timeout is sent as typed and refused, never defaulted silently");
  assert.equal(claimErrorsFrom(refusedBlank.error!.message, blankTimeout).timeoutMinutes.length, 1);

  const noSteps = { ...draft, steps: [] };
  const refusedEmpty = WorktreesConfigPatchSchema.safeParse({
    repositories: { "/repo/.git": { claim: claimFromDraft({ ...noSteps, timeoutMinutes: "10", fingerprintPaths: "", seedPaths: "", seedExclude: "" }) } },
  });
  assert.equal(claimErrorsFrom(refusedEmpty.error!.message, noSteps).steps.length, 1);

  const unreachable = claimErrorsFrom("worktree operations unavailable", draft);
  assert.deepEqual(unreachable.general, ["worktree operations unavailable"]);
  // A refusal that names no field is still an error, but there is no field to send anyone to.
  assert.equal(hasClaimErrors(unreachable), true);
  assert.equal(hasClaimFieldErrors(unreachable), false);
  assert.equal(hasClaimFieldErrors(errors), true);
  assert.equal(hasClaimErrors(emptyClaimErrors()), false);
});

test("removing a step moves its successors' errors down with them and drops its own", () => {
  const errors = {
    ...emptyClaimErrors(),
    timeoutMinutes: ["Number must be greater than or equal to 1"],
    argv: { 0: ["Argument 1: bad first"], 2: ["Argument 1: bad third"] },
    env: { 1: ["bad-name: a variable name is letters, digits and underscores"], 2: ["OTHER: reserved"] },
  };
  assert.deepEqual(withoutStepErrors(errors, 0), {
    ...errors,
    argv: { 1: ["Argument 1: bad third"] },
    env: { 0: ["bad-name: a variable name is letters, digits and underscores"], 1: ["OTHER: reserved"] },
  }, "step 2's name error now sits on step 1, where that step now is");
  assert.deepEqual(withoutStepErrors(errors, 1).env, { 1: ["OTHER: reserved"] }, "the removed step's own errors go with it");
  assert.deepEqual(withoutStepErrors(errors, 1).argv, { 0: ["Argument 1: bad first"], 1: ["Argument 1: bad third"] });
  assert.deepEqual(withoutStepErrors(errors, 5), errors, "removing a step after every error changes nothing");
  // Removing the only step with field errors leaves nothing to point the operator at.
  const onlyStep = { ...emptyClaimErrors(), env: { 0: ["bad-name: no"] } };
  assert.equal(hasClaimErrors(withoutStepErrors(onlyStep, 0)), false);
});

test("a failure record round-trips field for field, whatever the command and reason contain", () => {
  const warning = {
    step: 2,
    stepCount: 3,
    argv: ["node", "-e", "console.log(1)) exited with code 9 (fake"],
    reason: "stopped before it started",
    tail: "line one\nline two\n",
    truncatedBytes: 12,
  };
  assert.deepEqual(decodeClaimFailure(encodeClaimFailure(warning)), {
    step: 2,
    stepCount: 3,
    command: "node -e console.log(1)) exited with code 9 (fake",
    reason: "stopped before it started",
    tail: "line one\nline two\n",
    truncatedBytes: 12,
    tailWithheld: false,
  }, "no reason vocabulary and no parenthesis in the command can confuse a record");

  // A row an earlier build wrote as text keeps its first line as the reason, claims no step or
  // command it would have to guess at, and withholds the output it stored before redaction.
  assert.deepEqual(decodeClaimFailure(describeClaimFailure(warning)), {
    step: null,
    stepCount: null,
    command: null,
    reason: "step 2 of 3 (node -e console.log(1)) exited with code 9 (fake) stopped before it started",
    tail: "",
    truncatedBytes: 0,
    tailWithheld: true,
  });
  assert.deepEqual(decodeClaimFailure("step 1 of 1 (pnpm) exited with code 1"), {
    step: null, stepCount: null, command: null, reason: "step 1 of 1 (pnpm) exited with code 1", tail: "", truncatedBytes: 0, tailWithheld: false,
  }, "a text row that stored no output has nothing withheld");
  assert.deepEqual(decodeClaimFailure(""), {
    step: null, stepCount: null, command: null, reason: "", tail: "", truncatedBytes: 0, tailWithheld: false,
  });
  assert.equal(decodeClaimFailure(JSON.stringify({ version: 99, step: 1 })).step, null, "an unknown record version is not trusted");
});

test("an earlier build's failure text never sends its stored output, whatever value it holds", () => {
  // Written before redaction existed: the step printed a value that may since have rotated, so
  // nothing the daemon knows now could recognize it.
  const rotated = "s3cr3t-rotated-registry-value";
  const legacy = `step 1 of 1 (pnpm install) exited with code 1\nusing token ${rotated}\nE401 Unauthorized\n`;
  const view = slotDependencies({
    hasClaim: true,
    slot: row({ depsState: "failed", depsLastError: legacy }),
    running: null,
    defaultSha: null,
    defaultFingerprint: null,
  });
  assert.equal(view?.state, "failed");
  if (view?.state !== "failed") return;
  assert.equal(view.failure.reason, "step 1 of 1 (pnpm install) exited with code 1");
  assert.equal(view.failure.tail, "");
  assert.equal(view.failure.tailWithheld, true);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(rotated), false, "the stored value never reaches the view");
  assert.equal(serialized.includes("E401"), false, "nor any of the stored output");
});

test("redaction removes every received value, including one the tail ring cut into", () => {
  const secrets = [
    { name: "NPM_TOKEN", value: "npm_abcdefghijklmnop" },
    { name: "SHORT", value: "xyz" },
  ];
  assert.equal(
    redactClaimValues("auth=npm_abcdefghijklmnop failed; xyz again npm_abcdefghijklmnop", secrets),
    "auth=[NPM_TOKEN redacted] failed; [SHORT redacted] again [NPM_TOKEN redacted]",
  );
  // The ring dropped the front of the output partway through the token.
  assert.equal(redactClaimValues("ghijklmnop\nE401", secrets), "[NPM_TOKEN redacted]\nE401");
  // Three characters that happen to end a value are not treated as a cut-off value.
  assert.equal(redactClaimValues("nop is fine", secrets), "nop is fine");
  assert.equal(redactClaimValues("nothing to hide", []), "nothing to hide");
});

test("one value's match never hides another's: overlapping values are both redacted whole", () => {
  // `xABCD` ends with `ABCD`, which is how the second value begins. Matching one value and
  // rewriting the text before looking for the other would leave `-super-secret-value` behind.
  const overlapping = [
    { name: "SHORT_TOKEN", value: "xABCD" },
    { name: "LONG_TOKEN", value: "ABCD-super-secret-value" },
  ];
  for (const secrets of [overlapping, [...overlapping].reverse()]) {
    const redacted = redactClaimValues("ABCD-super-secret-value\nE401\n", secrets);
    assert.equal(redacted.includes("super-secret"), false, `nothing of LONG_TOKEN survives (${redacted})`);
    assert.match(redacted, /^\[[A-Z_, ]*LONG_TOKEN[A-Z_, ]* redacted\]\nE401\n$/);
  }
  // Each in the middle of the output, overlapping where they meet.
  const middle = redactClaimValues("token xABCD-super-secret-value end", overlapping);
  assert.equal(middle, "token [SHORT_TOKEN, LONG_TOKEN redacted] end");

  // A value that contains another value is removed whole, not left with a hole in it.
  const nested = [
    { name: "INNER", value: "secret" },
    { name: "OUTER", value: "my-secret-key" },
  ];
  assert.equal(redactClaimValues("use my-secret-key and secret", nested), "use [OUTER, INNER redacted] and [INNER redacted]");

  // Overlapping and touching occurrences of one value leave nothing between them.
  assert.equal(redactClaimValues("aaaaa", [{ name: "A", value: "aaa" }]), "[A redacted]");
  assert.equal(redactClaimValues("k3yk3y!", [{ name: "K", value: "k3y" }]), "[K redacted]!");
});

test("a step that prints its own variable and fails stores, warns and shows only the redaction", async () => {
  const value = "s3cr3t-fixture-claim-value";
  const outcome = await runClaimSteps({
    claim: WorktreeClaimSchema.parse({ steps: [{ argv: ["fails"], env: ["REGISTRY_TOKEN"] }] }),
    cwd: "/nowhere",
    signal: new AbortController().signal,
    environment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: { REGISTRY_TOKEN: value }, daemonToken: "tok", loginShell: {} }),
    runStep: async (request) => ({
      outcome: "exited",
      code: 1,
      signal: null,
      // The tail ring keeps the end, so the first occurrence arrives cut.
      tail: `${String(request.env.REGISTRY_TOKEN).slice(6)}\nusing token ${String(request.env.REGISTRY_TOKEN)}\nE401\n`,
      truncatedBytes: 40,
    }),
    now: () => 0,
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.warning.tail, "[REGISTRY_TOKEN redacted]\nusing token [REGISTRY_TOKEN redacted]\nE401\n");
  const stored = encodeClaimFailure(outcome.warning);
  assert.equal(stored.includes("s3cr3t"), false, "the slot row never holds the value");
  assert.equal(stored.includes(value.slice(6)), false, "nor the cut-off piece of it");
});

// ---- Through the real manager and inventory ----

function emptyOccupancy(paths: readonly string[]): Promise<Map<string, WorktreeOccupancy>> {
  return Promise.resolve(new Map(paths.map((path) => [path, { status: "known", occupants: [] }])));
}

function node(code: string): string[] {
  return [process.execPath, "-e", code];
}

function repository(prefix: string): { origin: string; clone: string; sha: string } {
  const { origin, clone } = mkOriginAndClone(prefix);
  writeFileSync(join(origin, "lock.txt"), "v1\n");
  gitIn(origin, "add", "-A");
  gitIn(origin, "commit", "-qm", "lockfile");
  gitIn(clone, "fetch", "-q", "origin");
  gitIn(clone, "reset", "-q", "--hard", "origin/main");
  return { origin, clone, sha: gitIn(clone, "rev-parse", "HEAD") };
}

function harness(claim: WorktreeClaim, presence: (names: readonly string[]) => Promise<WorktreeClaimVariableView[]>) {
  let bumps = 0;
  const manager = new WorktreeManager(db, {
    occupancy: emptyOccupancy,
    resolvePolicy: () => ({ enabled: true, maxSlots: 4, setupArgv: null, claim }),
    claimEnvironment: async (names) =>
      buildClaimEnvironment({ names, daemonEnv: { PRESENT_TOKEN: "s3cr3t-daemon-value" }, daemonToken: "tok", loginShell: {} }),
    publishChanged: () => { bumps += 1; },
  });
  const operations = new WorktreeOperationsService(manager, {
    legacy: new LegacyTreehouseService(db),
    tasks: { get: () => null, reclaim: async () => ({ ok: false, error: "unexpected task" }) },
    checks: new CheckLeaseManager(db, { manager, legacy: new LegacyTreehouseService(db) }),
    checkRecovery: async () => "unknown",
    notifyChanged: () => {},
    diskBytes: async () => null,
    claimVariablePresence: presence,
  });
  return { manager, operations, bumps: () => bumps };
}

function leased(result: WorktreeAcquireResult): Extract<WorktreeAcquireResult, { outcome: "acquired" }> {
  assert.equal(result.outcome, "acquired", JSON.stringify(result));
  return result as Extract<WorktreeAcquireResult, { outcome: "acquired" }>;
}

async function slotView(operations: WorktreeOperationsService, slotId: string) {
  const inventory = await operations.inventory();
  const found = inventory.repositories.flatMap((repo) => repo.slots).find((slot) => slot.id === slotId);
  assert.ok(found, `slot ${slotId} is in the inventory`);
  return { inventory, slot: found };
}

test("the inventory reports current, then stale only once the default ref is fetched", async () => {
  const fixture = repository("mission-claim-inventory-stale-");
  const claim = WorktreeClaimSchema.parse({
    steps: [{ argv: node("process.exit(0)"), env: ["PRESENT_TOKEN", "ABSENT_TOKEN"] }],
    fingerprintPaths: ["lock.txt"],
  });
  const presence = async (names: readonly string[]) =>
    describeClaimVariables({
      names,
      daemonEnv: { PRESENT_TOKEN: "s3cr3t-daemon-value" },
      daemonToken: "tok",
      loginShell: { SHELL_ONLY: "s3cr3t-shell-value" },
    });
  const { manager, operations } = harness(claim, presence);
  const lease = leased(await manager.acquire({
    repositoryPath: fixture.clone,
    baseSha: fixture.sha,
    owner: { kind: "task", key: "task-stale:0" },
    runClaim: true,
  })).lease;

  const first = await slotView(operations, lease.slotId);
  assert.equal(first.slot.dependencies?.state, "current");
  assert.equal(first.slot.dependencies?.fingerprintSha, fixture.sha, "the fingerprint's commit is the leased commit");
  assert.equal(first.slot.dependencies?.defaultSha, fixture.sha);
  const repo = first.inventory.repositories[0]!;
  assert.deepEqual(repo.policy.claim, claim);
  assert.deepEqual(repo.claimVariables, [
    { name: "ABSENT_TOKEN", present: false, source: null },
    { name: "PRESENT_TOKEN", present: true, source: "daemon" },
  ]);
  assert.equal(JSON.stringify(first.inventory).includes("s3cr3t"), false, "no variable value reaches the inventory");

  // origin moves the lockfile, but nothing has fetched it: building the inventory must not.
  writeFileSync(join(fixture.origin, "lock.txt"), "v2\n");
  gitIn(fixture.origin, "add", "-A");
  gitIn(fixture.origin, "commit", "-qm", "lockfile v2");
  const unfetched = await slotView(operations, lease.slotId);
  assert.equal(unfetched.slot.dependencies?.state, "current", "the inventory judges against the last fetched ref only");
  assert.equal(gitIn(fixture.clone, "rev-parse", "origin/main"), fixture.sha, "and it did not fetch to find out");

  gitIn(fixture.clone, "fetch", "-q", "origin");
  const fetched = gitIn(fixture.clone, "rev-parse", "origin/main");
  const stale = await slotView(operations, lease.slotId);
  assert.equal(stale.slot.dependencies?.state, "stale");
  assert.equal(stale.slot.dependencies?.defaultSha, fetched);
  assert.equal(stale.slot.dependencies?.fingerprintSha, fixture.sha);

});

test("a fetched change outside the fingerprint paths leaves a current slot current", async () => {
  const fixture = repository("mission-claim-inventory-unlisted-");
  const claim = WorktreeClaimSchema.parse({
    steps: [{ argv: node("process.exit(0)") }],
    fingerprintPaths: ["lock.txt"],
  });
  const { manager, operations } = harness(claim, async () => []);
  const lease = leased(await manager.acquire({
    repositoryPath: fixture.clone,
    baseSha: fixture.sha,
    owner: { kind: "task", key: "task-unlisted:0" },
    runClaim: true,
  })).lease;
  assert.equal((await slotView(operations, lease.slotId)).slot.dependencies?.state, "current");

  // Only an unlisted path moves on origin, and the clone fetches it: the default commit
  // changes, but the claim's fingerprint at that commit does not.
  writeFileSync(join(fixture.origin, "README.md"), "docs only\n");
  gitIn(fixture.origin, "add", "-A");
  gitIn(fixture.origin, "commit", "-qm", "docs");
  gitIn(fixture.clone, "fetch", "-q", "origin");
  const fetched = gitIn(fixture.clone, "rev-parse", "origin/main");
  assert.notEqual(fetched, fixture.sha, "the default branch really moved");
  const after = await slotView(operations, lease.slotId);
  assert.equal(after.slot.dependencies?.state, "current", "README.md is not a fingerprint path");
  assert.equal(after.slot.dependencies?.defaultSha, fetched, "judged against the moved default, not the old one");
  assert.equal(after.slot.dependencies?.fingerprintSha, fixture.sha);
});

test("a presence probe that fails leaves the inventory available and every name missing", async () => {
  const fixture = repository("mission-claim-inventory-presence-fails-");
  const claim = WorktreeClaimSchema.parse({
    steps: [{ argv: node("process.exit(0)"), env: ["PRESENT_TOKEN", "OTHER_TOKEN"] }],
  });
  let asked: readonly string[] = [];
  const { manager, operations } = harness(claim, async (names) => {
    asked = names;
    throw new Error("login shell exploded with s3cr3t-in-error");
  });
  const lease = leased(await manager.acquire({
    repositoryPath: fixture.clone,
    baseSha: fixture.sha,
    owner: { kind: "task", key: "task-presence-fails:0" },
    runClaim: true,
  })).lease;

  const { inventory, slot } = await slotView(operations, lease.slotId);
  assert.deepEqual(asked, ["OTHER_TOKEN", "PRESENT_TOKEN"], "the probe was asked, once, for every name");
  assert.equal(slot.dependencies?.state, "current", "the rest of the inventory is unaffected");
  assert.deepEqual(inventory.repositories[0]!.claimVariables, [
    { name: "OTHER_TOKEN", present: false, source: null },
    { name: "PRESENT_TOKEN", present: false, source: null },
  ]);
  const serialized = JSON.stringify(inventory);
  for (const leak of ["s3cr3t", "exploded"]) {
    assert.equal(serialized.includes(leak), false, `${leak} must not reach the inventory`);
  }
});

test("a failure tail is kept whole up to its byte bound, and cut on a character boundary past it", () => {
  const record = (tail: string) =>
    encodeClaimFailure({ step: 1, stepCount: 1, argv: ["pnpm", "install"], reason: "exited with code 1", tail, truncatedBytes: 0 });
  const failedTail = (depsLastError: string) => {
    const view = slotDependencies({
      hasClaim: true,
      slot: row({ depsState: "failed", depsLastError }),
      running: null,
      defaultSha: null,
      defaultFingerprint: null,
    });
    assert.equal(view?.state, "failed");
    return view?.state === "failed" ? view.failure.tail : null;
  };
  const bound = 4_096;

  const ascii = "x".repeat(bound);
  assert.equal(failedTail(record(ascii)), ascii, "exactly at the bound, single-byte text is untouched");
  const wide = "€".repeat(Math.floor(bound / 3));
  assert.equal(failedTail(record(wide)), wide, "multi-byte text inside the bound is untouched");

  // 1,400 three-byte characters and a final "zz" are 4,202 bytes. Keeping the last 4,096 starts
  // one byte into a character, which must be dropped rather than shown as U+FFFD.
  const over = `${"€".repeat(1_400)}zz`;
  const kept = failedTail(record(over))!;
  assert.equal(kept, `${"€".repeat(1_364)}zz`, "the newest output, the end, is what is kept");
  assert.equal(kept.includes("�"), false, "no replacement character from the cut");
  assert.ok(Buffer.byteLength(kept) <= bound);

  const overAscii = `head-${"y".repeat(bound)}`;
  assert.equal(failedTail(record(overAscii)), "y".repeat(bound), "past the bound, exactly the last bytes remain");

});

test("a running claim shows installing with its step, and a failed one keeps its tail", async () => {
  const fixture = repository("mission-claim-inventory-running-");
  const gate = join(fixture.clone, "..", `gate-${process.pid}-${Date.now()}`);
  const claim = WorktreeClaimSchema.parse({
    steps: [
      { argv: node("process.exit(0)") },
      {
        // It prints the value it was given before failing, as a debug-minded install might.
        argv: node(
          `const fs=require("fs");const gate=${JSON.stringify(gate)};` +
            `const wait=()=>{if(fs.existsSync(gate)){console.log("resolving packages with "+process.env.PRESENT_TOKEN);console.error("E401 Unauthorized: token rejected");process.exit(3)}setTimeout(wait,25)};wait();`,
        ),
        env: ["PRESENT_TOKEN"],
      },
    ],
  });
  const { manager, operations, bumps } = harness(claim, async () => []);
  const pending = manager.acquire({
    repositoryPath: fixture.clone,
    baseSha: fixture.sha,
    owner: { kind: "task", key: "task-running:0" },
    runClaim: true,
  });
  const deadline = Date.now() + 15_000;
  while (manager.claims.list()[0]?.step?.step !== 2) {
    if (Date.now() > deadline) throw new Error("the claim never reached step 2");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const slotId = manager.claims.list()[0]!.slotId;
  const bumpsBefore = bumps();
  assert.ok(bumpsBefore >= 3, "the write-ahead and each step start bump the worktrees revision");

  const installing = await slotView(operations, slotId);
  assert.equal(installing.slot.state, "provisioning");
  const running = installing.slot.dependencies;
  assert.equal(running?.state, "installing");
  if (running?.state !== "installing") return;
  assert.equal(running.step?.step, 2);
  assert.equal(running.step?.stepCount, 2);
  assert.match(running.step?.command ?? "", /-e /);

  writeFileSync(gate, "go\n");
  const result = leased(await pending);
  assert.ok(result.claimWarning, "a failed claim still hands the slot over, with a warning");
  assert.equal(existsSync(gate), true);
  const failed = await slotView(operations, slotId);
  const deps = failed.slot.dependencies;
  assert.equal(deps?.state, "failed");
  if (deps?.state !== "failed") return;
  assert.equal(deps.failure.step, 2);
  assert.equal(deps.failure.stepCount, 2);
  assert.equal(deps.failure.reason, "exited with code 3");
  assert.match(deps.failure.command ?? "", /^\S+node -e /);
  assert.match(deps.failure.tail, /resolving packages with \[PRESENT_TOKEN redacted\]/);
  assert.match(deps.failure.tail, /E401 Unauthorized: token rejected/);
  // The value the step printed reaches neither the inventory, the slot row nor the agent's note.
  assert.equal(JSON.stringify(failed.inventory).includes("s3cr3t-daemon-value"), false);
  assert.equal(String(db.prepare("SELECT deps_last_error FROM worktree_slots WHERE id = ?").get(slotId)?.deps_last_error).includes("s3cr3t"), false);
  assert.equal(result.claimWarning.tail.includes("s3cr3t"), false);
});
