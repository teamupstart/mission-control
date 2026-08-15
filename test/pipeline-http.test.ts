import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelinesView } from "../src/shared/pipeline.ts";

// What is at stake: this route is the consent boundary. Everything the integration does is
// downstream of a repository being switched on here, so the two things it must never do are
// accept a path that is not a repository (which would mean an operator consented to
// something they cannot have meant) and let a write take effect anywhere but the daemon.
//
// The third claim is the one that is easy to leave out: withdrawing consent has to be felt
// AT THE WRITE. A route that only persisted, leaving the watcher to notice on its next tick,
// would leave an operator watching a page that still shows the repository they just switched
// off - which reads as a setting that did not take, and is the exact thing the "everything
// arrives disabled" posture is supposed to make trustworthy.

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-http-"));
process.env.HARNESS_HOME = join(home, "state");
// Nothing on PATH, so the probe reports "not installed" deterministically - which is also
// the state every machine without conductor is in, and therefore the one the panel's
// detection card has to be right about.
process.env.MISSION_CONDUCTOR_BIN = join(home, "no-such-conductor");
process.env.AI_CONDUCTOR_REGISTRY = join(home, "no-such-registry.json");

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { getPipelinesConfig, setPipelinesConfig } = await import(
  "../src/server/pipelines/config.ts"
);
const { refreshPipelineRepo, restorePipelineProjection } = await import(
  "../src/server/pipelines/index.ts"
);
const { seedConductorDaemon, seedConductorRun } = await import("../e2e/fixtures/conductor.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

/**
 * Poll `read` until it equals `want`, or fail saying what it was.
 *
 * A poll rather than a sleep because the thing being waited for is a subprocess landing in
 * a background promise, and any fixed delay is either too short on a loaded CI box or wasted
 * wall clock on an idle one.
 */
async function expect_<T>(
  read: () => Promise<T>,
  want: T,
  message: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (last === want) return;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`${message} (last saw ${JSON.stringify(last)})`);
}

/** A real git repository, because the route resolves a git root and refuses anything else. */
function gitRepo(name: string): string {
  const root = join(home, name);
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "pipe" });
  return realpathSync(root);
}

/** A fresh daemon: an empty projection, no consent, and nothing yet found out. */
function fixture() {
  db.exec("DELETE FROM pipeline_runs");
  setPipelinesConfig({ enabled: false, repos: [] });
  const registry = new Registry();
  // The real boot path, which is also what clears this process's held probe - so a test
  // about the FIRST read of a daemon is about a first read rather than about whichever
  // test in this file happened to run before it.
  restorePipelineProjection(registry);
  const app = buildApp(
    registry, null as never, null as never, null as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
  );
  const request = (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { host: "127.0.0.1:7317", "content-type": "application/json", ...init?.headers },
    });
  return { registry, request };
}

test("the panel reads consent, detection and health in one call, and ships off", async () => {
  const { request } = fixture();
  const res = await request("/api/pipelines/config");
  assert.equal(res.status, 200);
  const view = (await res.json()) as PipelinesView;

  assert.equal(view.config.enabled, false, "the master switch ships off");
  assert.deepEqual(view.config.repos, [], "no repository is consented to on a fresh install");
  assert.deepEqual(view.status, []);
});

test("an ordinary read never waits for a probe, and the next one carries its answer", async () => {
  // The panel polls every four seconds from a page that is mostly about other things, so a
  // route that awaited a spawn would put a `fork` + `execve` on that path - on a fleet with
  // this feature switched off entirely. So the FIRST read carries no probe and starts one in
  // the background; the panel draws its own "looking for the engine" state until it lands.
  const { request } = fixture();
  const first = (await (await request("/api/pipelines/config")).json()) as PipelinesView;
  assert.deepEqual(first.probes, [], "the first read must not have waited for a subprocess");

  await expect_(
    async () => {
      const view = (await (await request("/api/pipelines/config")).json()) as PipelinesView;
      return view.probes.length;
    },
    1,
    "the background probe should land and be served by a later read",
  );

  const settled = (await (await request("/api/pipelines/config")).json()) as PipelinesView;
  assert.equal(settled.probes[0]?.provider, "ai-conductor");
  // "Not installed" is an answer an operator can act on, and it is different from "we did
  // not look" - which is exactly the state the first read above reported.
  assert.equal(settled.probes[0]?.found, false);
  assert.match(String(settled.probes[0]?.error), /not on this daemon's PATH/);
  // And where it looked, so a wrong `$AI_CONDUCTOR_REGISTRY` is diagnosable rather than an
  // empty list with no explanation.
  assert.equal(settled.probes[0]?.registryPath, process.env.AI_CONDUCTOR_REGISTRY);
});

test("Check again waits, because that is the whole point of pressing it", async () => {
  // The one caller that blocks on the subprocess. An operator who has just installed the
  // engine is asking a question the cache would answer with yesterday's news.
  const { request } = fixture();
  const forced = (await (await request("/api/pipelines/config?refresh=1")).json()) as PipelinesView;
  assert.equal(forced.probes.length, 1, "a forced read carries the answer it just took");
  assert.equal(forced.probes[0]?.found, false);
});

test("a path that is not a git repository is refused by name", async () => {
  const { request } = fixture();
  const res = await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      repos: [{ provider: "ai-conductor", repoRoot: join(home, "not-a-repo"), enabled: true }],
    }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.text()), /not a git repository/);
  assert.deepEqual(getPipelinesConfig().repos, [], "a refused write persists nothing");
});

test("a repository is stored at its resolved root, and arrives off unless asked", async () => {
  const { request } = fixture();
  const repo = gitRepo("resolved");
  const res = await request("/api/pipelines/config", {
    method: "PUT",
    // No `enabled` on the entry: adding is configuration, and the schema's default is what
    // makes turning it on a separate act.
    body: JSON.stringify({ enabled: true, repos: [{ provider: "ai-conductor", repoRoot: repo }] }),
  });
  assert.equal(res.status, 200);
  const view = (await res.json()) as PipelinesView;
  assert.equal(view.config.repos[0]?.repoRoot, repo);
  assert.equal(view.config.repos[0]?.enabled, false);
  // The health line exists for a listed repository, and says it has not been read.
  assert.equal(view.status.length, 1);
  assert.equal(view.status[0]?.lastReadAt, null);
});

test("a body the schema refuses changes nothing", async () => {
  const { request } = fixture();
  const repo = gitRepo("bad-body");
  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }] }),
  });
  const res = await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, repos: [{ provider: "not-a-provider", repoRoot: repo }] }),
  });
  assert.equal(res.status, 400);
  assert.equal(getPipelinesConfig().repos[0]?.enabled, true, "the prior consent still stands");
});

test("switching a repository off drops its runs in the same request", async () => {
  // Not one watch tick later. An operator who withdraws consent and keeps looking at the
  // page is entitled to see it happen.
  const { registry, request } = fixture();
  const repo = gitRepo("withdraw");
  seedConductorRun(repo, "feat", { steps: { build: "done" } });
  seedConductorDaemon(repo, { pid: process.pid });

  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }] }),
  });
  await refreshPipelineRepo(registry, "ai-conductor", repo);
  assert.equal(registry.listPipelineRuns().length, 1);

  const res = await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: false }] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(registry.listPipelineRuns(), [], "the runs go with the consent");
});

test("the health line reports the engine daemon's state and the run counts", async () => {
  const { registry, request } = fixture();
  const repo = gitRepo("health");
  seedConductorRun(repo, "working", { steps: { build: "in_progress" } });
  seedConductorRun(repo, "stuck", { steps: { build: "done" }, halt: "a gate refused" });
  seedConductorDaemon(repo, { pid: process.pid, paused: true });

  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({ enabled: true, repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }] }),
  });
  await refreshPipelineRepo(registry, "ai-conductor", repo);

  const view = (await (await request("/api/pipelines/config")).json()) as PipelinesView;
  assert.equal(view.status[0]?.daemon, "paused");
  assert.equal(view.status[0]?.runs, 2);
  assert.equal(view.status[0]?.halted, 1);
  assert.notEqual(view.status[0]?.lastReadAt, null);
});

test("the routes are loopback-only, like every other /api route", async () => {
  const { request } = fixture();
  const read = await request("/api/pipelines/config", { headers: { host: "example.com" } });
  assert.equal(read.status, 403);
  const write = await request("/api/pipelines/config", {
    method: "PUT",
    headers: { host: "example.com" },
    body: JSON.stringify({ enabled: true, repos: [] }),
  });
  assert.equal(write.status, 403);
});
