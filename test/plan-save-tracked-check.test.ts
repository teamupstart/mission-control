import { ensureNativeStateLockAddon } from "./helpers/native-state-lock.ts";
ensureNativeStateLockAddon();
import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { PlanAuthority } from "../src/server/plans/store.ts";
import type { SavePlanInput } from "../src/shared/managed-plans.ts";

/**
 * A new-plan save asks `git ls-files` whether the plan's directory is already tracked, and
 * refuses when it is. A git that never ANSWERS is not a git that said yes: under heavy host
 * load the check used to hit `run`'s 4 s default and was reported as "Existing tracked plans
 * cannot be adopted" - in a fresh repository with no plans at all, which is how
 * `plan-standing-approval.test.ts` failed the suite on a loaded machine.
 *
 * The git the store runs is a wrapper, named ahead of every other directory through
 * `MISSION_EXECUTABLE_PATHS`, that delegates to the real git except for `ls-files` while a
 * marker file exists - then it is SIGKILLed, the same unanswered outcome a timeout produces -
 * or, under a second marker, exits 128 the way a held index lock makes it.
 */
const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-plan-tracked-check-")));
const bin = join(home, "bin");
const killMarker = join(home, "kill-ls-files");
const failMarker = join(home, "fail-ls-files");
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "git"), [
  "#!/bin/sh",
  `if [ -e '${killMarker}' ]; then`,
  "  for arg in \"$@\"; do",
  "    if [ \"$arg\" = ls-files ]; then kill -KILL $$; fi",
  "  done",
  "fi",
  `if [ -e '${failMarker}' ]; then`,
  "  for arg in \"$@\"; do",
  "    if [ \"$arg\" = ls-files ]; then echo \"fatal: Unable to create '.git/index.lock': File exists.\" >&2; exit 128; fi",
  "  done",
  "fi",
  `exec '${realGit}' "$@"`,
  "",
].join("\n"));
chmodSync(join(bin, "git"), 0o755);
process.env.MISSION_HOME = join(home, "state");
const originalExecutablePaths = process.env.MISSION_EXECUTABLE_PATHS;
process.env.MISSION_EXECUTABLE_PATHS = bin;

const { savePlan } = await import("../src/server/plans/store.ts");
const { closeDb } = await import("../src/server/db.ts");

after(() => {
  closeDb();
  if (originalExecutablePaths === undefined) delete process.env.MISSION_EXECUTABLE_PATHS;
  else process.env.MISSION_EXECUTABLE_PATHS = originalExecutablePaths;
  rmSync(home, { recursive: true, force: true });
});
afterEach(() => {
  rmSync(killMarker, { force: true });
  rmSync(failMarker, { force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync(realGit, ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repo(): PlanAuthority {
  const checkout = join(home, randomUUID());
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", "--allow-empty");
  return { sessionId: randomUUID(), taskId: randomUUID(), episodeId: randomUUID(), repoSlot: "repo-01", checkout, repoRoot: checkout };
}

function input(slug: string): SavePlanInput {
  return { repoSlot: "repo-01", requestId: randomUUID(), slug, expectedRevision: 0, files: [
    { name: "plan.md", content: "# A plan" },
    { name: "plan.html", content: "<h1>A plan</h1>" },
  ] };
}

test("a git that never answers the tracked-plan check is reported as that, not as a tracked plan", async () => {
  const authority = repo();
  writeFileSync(killMarker, "");
  await assert.rejects(savePlan(authority, input("fresh-plan")), (error: Error) => {
    assert.doesNotMatch(error.message, /Existing tracked plans/, "nothing is tracked in a fresh repository");
    assert.match(error.message, /Could not check docs\/plans\/fresh-plan for tracked files: git ls-files was killed by SIGKILL/);
    assert.match(error.message, /Retry the save/);
    return true;
  });

  // The same save succeeds once git answers again.
  rmSync(killMarker, { force: true });
  const saved = await savePlan(authority, input("fresh-plan"));
  assert.equal(saved.manifest.revision, 1);
});

test("a plan directory git really tracks is still refused as one", async () => {
  const authority = repo();
  mkdirSync(join(authority.checkout, "docs", "plans", "tracked-plan"), { recursive: true });
  writeFileSync(join(authority.checkout, "docs", "plans", "tracked-plan", "plan.md"), "# Tracked\n");
  git(authority.checkout, "add", "-A");
  git(authority.checkout, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "track a plan");
  await assert.rejects(savePlan(authority, input("tracked-plan")), /Existing tracked plans cannot be adopted or migrated by a new-plan save/);
});

test("a git that exits with an error is reported with its reason, not as a tracked plan", async () => {
  const authority = repo();
  writeFileSync(failMarker, "");
  await assert.rejects(savePlan(authority, input("locked-plan")), (error: Error) => {
    assert.doesNotMatch(error.message, /Existing tracked plans/, "an error exit lists no files");
    assert.match(
      error.message,
      /Could not check docs\/plans\/locked-plan for tracked files: git ls-files failed: fatal: Unable to create '\.git\/index\.lock': File exists\./,
    );
    return true;
  });
  rmSync(failMarker, { force: true });
  assert.equal((await savePlan(authority, input("locked-plan"))).manifest.revision, 1);
});
