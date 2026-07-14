import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's state dir (token + sqlite) BEFORE anything reads config.
process.env.FLEET_HOME = mkdtempSync(join(tmpdir(), "fleet-reset-nm-"));

const { openDb } = await import("../src/server/db.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { NmRunSummary, Session } from "../src/shared/types.ts";

openDb();
const TOKEN = ensureToken();
const LOOPBACK = { host: "127.0.0.1:7317" };
const authed = { ...LOOPBACK, "content-type": "application/json", "x-harness-token": TOKEN };

const registry = new Registry();
const app = buildApp(registry, new ReviewManager(registry), new TaskManager(registry));

/** Run git in `dir`, returning trimmed stdout. */
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
}

/**
 * A real origin + a clone of it sitting on a feature branch with local work -
 * the shape a session is in when its no-mistakes run has just finished. Real git
 * so the reset route runs a genuine fetch/reset/clean, which is what proves the
 * branch name survives the reset (the whole reason the strip came back).
 */
function mkClone(branch: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-reset-nm-")));
  const origin = join(root, "origin");
  execFileSync("git", ["init", "-q", origin]);
  const og = (...a: string[]): string => gitIn(origin, ...a);
  og("branch", "-M", "main");
  og("config", "user.email", "t@test");
  og("config", "user.name", "t");
  writeFileSync(join(origin, "keep.txt"), "base\n");
  og("add", "-A");
  og("commit", "-qm", "base");

  const clone = join(root, "clone");
  execFileSync("git", ["clone", "-q", origin, clone]);
  gitIn(clone, "config", "user.email", "t@test");
  gitIn(clone, "config", "user.name", "t");
  gitIn(clone, "checkout", "-qb", branch);
  writeFileSync(join(clone, "keep.txt"), "base\nthe work the run validated\n");
  gitIn(clone, "commit", "-qam", "work");
  return clone;
}

/** Seed a discovered session on `branch`, checked out at `cwd`. */
function seedSession(id: string, cwd: string, branch: string): void {
  const d: DiscoveredSession = {
    syntheticId: id,
    agent: "claude",
    name: "work",
    nameSource: "tmux",
    cwd,
    gitBranch: branch,
    nomistakesGated: true,
    pid: 4242,
    tty: "ttys003",
    wezterm: null,
    tmux: null, // no pane -> the reset's best-effort `/clear` is a no-op
    startedAt: 0,
  };
  registry.applyDiscovery([d]);
}

/** A finished run on `branch` - what `axi status` keeps reporting after a merge. */
function finishedRun(branch: string, id = "01RUN_FINISHED"): NmRunSummary {
  return {
    id,
    status: "completed",
    branch,
    awaitingAgent: null,
    findingsSummary: null,
    gateStep: null,
    gateSummary: null,
    gateRisk: null,
    steps: [{ step: "review", status: "completed", findings: 0 }],
    findings: [],
    outcome: "passed",
  };
}

async function card(id: string): Promise<Session> {
  const res = await app.request("/api/sessions", { headers: LOOPBACK });
  const all = (await res.json()) as Session[];
  const s = all.find((x) => x.id === id);
  assert.ok(s, `session ${id} is on the dashboard`);
  return s;
}

test("reset clears the no-mistakes strip, and the poller cannot bring it back", async () => {
  const branch = "mancej/feature";
  const clone = mkClone(branch);
  seedSession("s1", clone, branch);

  // The run finished and its PR merged, but `axi status` still reports it, so the
  // card is decorated. This is the state the user is looking at when they reset.
  registry.reconcileNomistakes([finishedRun(branch)]);
  registry.applyNomistakesNarration("s1", "wrapping up");
  assert.equal((await card("s1")).nomistakes?.outcome, "passed");

  const res = await app.request("/api/sessions/s1/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);

  // The card is clean the moment the reset lands.
  const afterReset = await card("s1");
  assert.equal(afterReset.nomistakes, null, "strip is gone right after the reset");
  assert.equal(afterReset.nomistakesNarration, null, "narration goes with its run");

  // The reset moved the branch pointer but NOT the branch name, so the session is
  // still on `mancej/feature` and `axi status` still reports the same run for it.
  // This next poll is what used to re-decorate the card ~5s later.
  assert.equal(gitIn(clone, "rev-parse", "--abbrev-ref", "HEAD"), branch);
  registry.reconcileNomistakes([finishedRun(branch)]);
  assert.equal((await card("s1")).nomistakes, null, "the poller must not resurrect it");
});

test("a dismissal is scoped to the run it retired, not to the branch", async () => {
  const branch = "mancej/second";
  const clone = mkClone(branch);
  seedSession("s2", clone, branch);

  registry.reconcileNomistakes([finishedRun(branch, "01RUN_OLD")]);
  const res = await app.request("/api/sessions/s2/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 200);
  assert.equal((await card("s2")).nomistakes, null);

  // A brand-new run on the same branch is a different run - it must still show,
  // or resetting once would gag the card forever.
  registry.reconcileNomistakes([finishedRun(branch, "01RUN_NEW")]);
  assert.equal((await card("s2")).nomistakes?.id, "01RUN_NEW");
});

test("a failed reset leaves the strip alone", async () => {
  const branch = "mancej/third";
  const notRepo = realpathSync(mkdtempSync(join(tmpdir(), "harness-reset-nm-norepo-")));
  seedSession("s3", notRepo, branch);
  registry.reconcileNomistakes([finishedRun(branch)]);

  const res = await app.request("/api/sessions/s3/reset", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ clear: false }),
  });
  assert.equal(res.status, 500); // not a git repository

  // The work (and the run that validated it) is still there, so the strip stays.
  assert.equal((await card("s3")).nomistakes?.outcome, "passed");
});
