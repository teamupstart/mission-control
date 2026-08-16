import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PipelineHaltClass,
  PipelineRepoStatus,
  PipelineRunDetail,
  PipelinesView,
} from "../src/shared/pipeline.ts";

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
const { setForemanConfig } = await import("../src/server/foreman/config.ts");
const { refreshPipelineRepo, restorePipelineProjection } = await import(
  "../src/server/pipelines/index.ts"
);
const {
  readConductorInvocations,
  seedConductorDaemon,
  seedConductorRun,
  writeFakeConductor,
} = await import("../e2e/fixtures/conductor.ts");
type Registry = InstanceType<typeof Registry>;

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

/** Every terminal a test asked for, so the console route can be driven without a window. */
interface FakeLaunch {
  backend: string;
  name: string;
  cwd: string;
  argv: string[];
}

/** A fresh daemon: an empty projection, no consent, and nothing yet found out. */
function fixture(opened?: FakeLaunch[]) {
  db.exec("DELETE FROM pipeline_runs");
  setPipelinesConfig({ enabled: false, foremanMechanicalTriage: false, repos: [] });
  setForemanConfig({ enabled: true });
  const registry = new Registry();
  // The real boot path, which is also what clears this process's held probe - so a test
  // about the FIRST read of a daemon is about a first read rather than about whichever
  // test in this file happened to run before it.
  restorePipelineProjection(registry);
  const launcher = opened
    ? (async (backend: never, spec: { name: string; cwd: string; argv: string[] }) => {
        opened.push({ backend, name: spec.name, cwd: spec.cwd, argv: spec.argv });
        return { ok: true as const, label: `fake ${String(backend)}`, homeName: spec.name };
      })
    : undefined;
  const app = buildApp(
    registry, null as never, null as never, null as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    launcher as never,
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

test("two paths that resolve to one repository are refused, not thrown over", async () => {
  // The schema rejects two entries naming the same PATH, which is not the same check: the
  // route resolves each entry to a git root first, so a repository root and a subdirectory
  // of it are two legal-looking paths that land on one root. Left to `setPipelinesConfig`,
  // its own refine throws out of an unguarded handler - a 500 where the operator has an
  // editable mistake, and the whole edit lost behind a generic error.
  const { request } = fixture();
  const repo = gitRepo("dupe");
  const inside = join(repo, "src", "deep");
  mkdirSync(inside, { recursive: true });

  const res = await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      repos: [
        { provider: "ai-conductor", repoRoot: repo, enabled: true },
        { provider: "ai-conductor", repoRoot: inside, enabled: true },
      ],
    }),
  });
  assert.equal(res.status, 400, "the same 400 the git-root check gives, not a 500");
  assert.match(await res.text(), /listed twice/);
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
  const repos = await request("/api/pipelines/repos", { headers: { host: "example.com" } });
  assert.equal(repos.status, 403);
  const detail = await request("/api/pipelines/run?provider=ai-conductor&repoRoot=/x&slug=y", {
    headers: { host: "example.com" },
  });
  assert.equal(detail.status, 403);
  // The two that SPAWN, which is where the guard matters most: without it a page on the
  // internet could run an engine verb on this machine.
  const acted = await request("/api/pipelines/action", {
    method: "POST",
    headers: { host: "example.com" },
    body: JSON.stringify({ provider: "ai-conductor", repoRoot: "/x", action: "daemon-stop" }),
  });
  assert.equal(acted.status, 403);
  const console_ = await request("/api/pipelines/console", {
    method: "POST",
    headers: { host: "example.com" },
    body: JSON.stringify({
      provider: "ai-conductor",
      repoRoot: "/x",
      console: "daemon",
      backend: "cmux",
    }),
  });
  assert.equal(console_.status, 403);
});

// ---- what the Runs page's Pipelines tab reads ------------------------------------------

test("the rail's repositories are the ones being READ, not the ones configured", async () => {
  // The narrower question, and the reason this is not a field on the panel's route: the
  // Settings panel lists every configured repository precisely so an operator can see the
  // ones that are off, while a rail that grouped runs under a repository nothing is reading
  // would draw an empty heading no control on that page explains.
  const { registry, request } = fixture();
  const observed = gitRepo("rail-observed");
  const off = gitRepo("rail-off");
  seedConductorRun(observed, "feat", { steps: { build: "in_progress" } });
  seedConductorDaemon(observed, { pid: process.pid });

  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      repos: [
        { provider: "ai-conductor", repoRoot: observed, enabled: true },
        { provider: "ai-conductor", repoRoot: off, enabled: false },
      ],
    }),
  });
  await refreshPipelineRepo(registry, "ai-conductor", observed);

  const res = await request("/api/pipelines/repos");
  assert.equal(res.status, 200);
  const { repos } = (await res.json()) as { repos: PipelineRepoStatus[] };
  assert.deepEqual(repos.map((repo) => repo.repoRoot), [observed]);
  assert.equal(repos[0]?.daemon, "running");
  assert.equal(repos[0]?.runs, 1);

  // And the master switch takes every heading with it, without forgetting the choice.
  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: false,
      repos: [{ provider: "ai-conductor", repoRoot: observed, enabled: true }],
    }),
  });
  const after = (await (await request("/api/pipelines/repos")).json()) as {
    repos: PipelineRepoStatus[];
  };
  assert.deepEqual(after.repos, []);
});

test("one run's gate evidence is read from the engine's files, on demand", async () => {
  const { request } = fixture();
  const repo = gitRepo("detail");
  seedConductorRun(repo, "feat", {
    steps: { plan: "done", build: "in_progress" },
    gates: {
      // Deliberately out of the engine's own step order in the fixture, so the response
      // proves the sort rather than the write order.
      build: { satisfied: false, reason: "two blocking defects" },
      plan: { satisfied: true, reason: "approved", kickbackFrom: "build_review" },
      complexity: { satisfied: true, reason: "skipped: tier S" },
    },
  });
  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }],
    }),
  });

  const res = await request(
    `/api/pipelines/run?provider=ai-conductor&repoRoot=${encodeURIComponent(repo)}&slug=feat`,
  );
  assert.equal(res.status, 200);
  const detail = (await res.json()) as PipelineRunDetail;
  assert.equal(detail.slug, "feat");
  assert.deepEqual(
    detail.gates.map((gate) => gate.step),
    ["complexity", "plan", "build"],
    "the engine's own step order, so the strip and this list cannot disagree",
  );
  // A skip is not a pass. The engine writes both as `satisfied: true`, and a surface reading
  // that alone would credit a tier-S run with gates it never ran.
  assert.equal(detail.gates[0]?.skipped, true);
  assert.equal(detail.gates[1]?.kickbackFrom, "build_review");
  assert.equal(detail.gates[2]?.satisfied, false);
});

test("gate evidence is behind the same consent the projection is", async () => {
  // The argument is a repository path off a URL. Without the consent check this route reads
  // `.pipeline/` files out of any directory on the machine for anything that can reach the
  // loopback API - and every "no" is the same 404, because telling an unknown provider from
  // an unconsented repository from a missing worktree would answer questions about the
  // filesystem that nobody asked.
  const { request } = fixture();
  const repo = gitRepo("unconsented");
  seedConductorRun(repo, "feat", { steps: { build: "done" }, gates: { build: { satisfied: true } } });

  const url = `/api/pipelines/run?provider=ai-conductor&repoRoot=${encodeURIComponent(repo)}&slug=feat`;
  assert.equal((await request(url)).status, 404, "a repository nobody consented to");

  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }],
    }),
  });
  assert.equal((await request(url)).status, 200, "and the same repository once switched on");

  // A slug is a path segment in the engine's layout, so it is resolved by LISTING the
  // repository rather than by joining it onto a root: `..` would otherwise be a traversal.
  const traversal = `/api/pipelines/run?provider=ai-conductor&repoRoot=${encodeURIComponent(repo)}&slug=${encodeURIComponent("../..")}`;
  assert.equal((await request(traversal)).status, 404);
  assert.equal(
    (await request(`/api/pipelines/run?provider=nope&repoRoot=${encodeURIComponent(repo)}&slug=feat`))
      .status,
    404,
    "a provider this build does not have",
  );
  assert.equal(
    (await request(`/api/pipelines/run?provider=ai-conductor&repoRoot=${encodeURIComponent(repo)}`))
      .status,
    404,
    "and an incomplete address",
  );

  // Withdrawal is felt here in the same request too, for the reason the projection's is.
  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: false }],
    }),
  });
  assert.equal((await request(url)).status, 404);
});

// ---- acting on a pipeline ------------------------------------------------------------------
//
// The consent boundary again, pointed the other way. A read behind it exposes an operator's
// files; a VERB behind it spawns a process with a working directory of anywhere on the
// machine, for anything that can reach the loopback API. So every case below is either about
// what reaches the engine or about what is refused before anything is spawned.

const fakeEngine = writeFakeConductor(home);
process.env.MC_E2E_CONDUCTOR_LOG = fakeEngine.logPath;

/** Run `body` with the fake engine installed, then put the missing binary back. */
async function withEngine<T>(body: () => Promise<T>): Promise<T> {
  const had = process.env.MISSION_CONDUCTOR_BIN;
  process.env.MISSION_CONDUCTOR_BIN = fakeEngine.bin;
  rmSync(fakeEngine.logPath, { force: true });
  try {
    return await body();
  } finally {
    process.env.MISSION_CONDUCTOR_BIN = had;
  }
}

/**
 * Every CONTROL verb the engine has been asked for, oldest first.
 *
 * Filtered rather than counted raw, and the filter is load-bearing rather than tidy: the
 * settings routes these cases go through spawn `engineer projects` to probe the installation,
 * behind a TTL cache this test cannot see. Counting every invocation therefore makes "nothing
 * was spawned" an assertion about whether that cache happened to expire mid-test - which is
 * true on a fast machine and false on a slow one, and which failed on CI while passing here.
 * What each of these cases actually claims is that the engine was never asked to DO anything.
 */
function verbsAsked(): string[][] {
  return readConductorInvocations(home)
    .filter((call) => call.argv[0] !== "engineer")
    .map((call) => call.argv);
}

/** A repository with one halted run, consented to and projected. */
async function actable(
  name: string,
  registry: Registry,
  request: ReturnType<typeof fixture>["request"],
  haltClass: PipelineHaltClass = "needs-human",
) {
  const repo = gitRepo(name);
  // `needs-human` by default, because that is the halt most action cases are about: it is the
  // class a refused DECIDE gate raises, and the only one a grant is licensed by. The console
  // case asks for `protected-artifact`, because the reseal ceremony is licensed the same way.
  seedConductorRun(repo, "feat", {
    steps: { build: "done" },
    halt: haltClass === "protected-artifact" ? "a sealed decision changed" : "a gate refused",
    haltClass,
  });
  seedConductorDaemon(repo, { pid: process.pid });
  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }],
    }),
  });
  await refreshPipelineRepo(registry, "ai-conductor", repo);
  return repo;
}

test("a verb reaches the engine, and the run it changed is re-projected in the same request", async () => {
  // The re-projection is what makes this a control rather than a request: every verb changes
  // something the projection reads FROM FILES, so a pass immediately afterwards is what turns
  // it into the `pipeline_upsert` the open dashboard is already listening for. Without it the
  // operator presses Park and watches an unchanged row until the next tick.
  const { registry, request } = fixture();
  await withEngine(async () => {
    const repo = await actable("act-park", registry, request);
    assert.equal(registry.listPipelineRuns()[0]?.group, "halted");

    const emitted: string[] = [];
    const unsubscribe = registry.subscribe((event) => {
      if (event.type === "pipeline_upsert") emitted.push(event.run.group);
    });
    const res = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        slug: "feat",
        action: "park",
      }),
    });
    unsubscribe();

    assert.equal(res.status, 200);
    const result = (await res.json()) as { ok: boolean; detail: string; command: string };
    assert.equal(result.ok, true, result.detail);
    assert.match(result.command, /daemon park feat$/);
    // The engine wrote the marker, and the projection read it back.
    assert.equal(registry.listPipelineRuns()[0]?.group, "parked");
    assert.deepEqual(emitted, ["parked"], "the browser is told, once");

    // And the way back out.
    const back = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        slug: "feat",
        action: "unpark",
      }),
    });
    assert.equal(((await back.json()) as { ok: boolean }).ok, true);
    assert.equal(registry.listPipelineRuns()[0]?.group, "halted");
  });
});

test("Foreman's master switch gates its pipeline feed, reservation, and provider action", async () => {
  const { registry, request } = fixture();
  await withEngine(async () => {
    const repo = await actable("foreman-master-switch", registry, request, "mechanical");
    setPipelinesConfig({ ...getPipelinesConfig(), foremanMechanicalTriage: true });
    setForemanConfig({ enabled: true });

    const available = (await (await request("/api/pipelines/foreman")).json()) as {
      enabled: boolean;
      items: Array<{ marker: string }>;
    };
    assert.equal(available.enabled, true);
    assert.equal(available.items.length, 1);
    const marker = available.items[0]?.marker;
    assert.ok(marker);

    setForemanConfig({ enabled: false });
    const stopped = await request("/api/pipelines/foreman");
    assert.deepEqual(await stopped.json(), { enabled: false, items: [] });

    const episode = {
      marker,
      situation: "pipeline-halt",
      surface: "pipeline",
      question: "a gate refused",
      classification: "mechanical",
      disposition: "pending",
    };
    const reserved = await request("/api/pipelines/foreman-episode", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        slug: "feat",
        episode,
      }),
    });
    assert.equal(reserved.status, 403);

    const before = verbsAsked().length;
    const automated = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        slug: "feat",
        action: "unpark",
        requestedBy: "foreman",
      }),
    });
    assert.equal(automated.status, 403);
    assert.equal(verbsAsked().length, before, "a disabled Foreman reaches no provider command");

    const operator = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        slug: "feat",
        action: "unpark",
      }),
    });
    assert.equal(operator.status, 200, "Foreman's switch does not withdraw operator control");
    assert.equal(((await operator.json()) as { ok: boolean }).ok, true);
  });
});

test("a repository verb moves the daemon the rail reports, without naming a feature", async () => {
  const { registry, request } = fixture();
  await withEngine(async () => {
    const repo = await actable("act-daemon", registry, request);
    const daemonNow = async (): Promise<string | undefined> => {
      const view = (await (await request("/api/pipelines/repos")).json()) as {
        repos: PipelineRepoStatus[];
      };
      return view.repos[0]?.daemon;
    };
    assert.equal(await daemonNow(), "running");

    const paused = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({ provider: "ai-conductor", repoRoot: repo, action: "daemon-pause" }),
    });
    assert.equal(((await paused.json()) as { ok: boolean }).ok, true);
    assert.equal(await daemonNow(), "paused");

    // Idempotent at the engine, and therefore idempotent here: an operator who pauses a
    // paused daemon got what they asked for, and a red flash on a correct state is a lie.
    const again = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({ provider: "ai-conductor", repoRoot: repo, action: "daemon-pause" }),
    });
    assert.equal(((await again.json()) as { ok: boolean }).ok, true);

    const resumed = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({ provider: "ai-conductor", repoRoot: repo, action: "daemon-resume" }),
    });
    assert.equal(((await resumed.json()) as { ok: boolean }).ok, true);
    assert.equal(await daemonNow(), "running");
  });
});

test("a grant is recorded by the engine, and a plan grant never reaches it", async () => {
  const { registry, request } = fixture();
  await withEngine(async () => {
    const repo = await actable("act-grant", registry, request);
    const grant = (step: string) =>
      request("/api/pipelines/action", {
        method: "POST",
        body: JSON.stringify({
          provider: "ai-conductor",
          repoRoot: repo,
          slug: "feat",
          action: "grant",
          step,
          reason: "the PRD's assumption changed",
        }),
      });

    const ok = (await (await grant("prd")).json()) as { ok: boolean; detail: string };
    assert.equal(ok.ok, true, ok.detail);
    assert.equal(existsSync(join(repo, ".daemon", "grants", "feat.json")), true);

    // Refused HERE, with an explanation, and no subprocess: the engine refuses `plan` in
    // four places of its own, and relaying an exit code would teach by rejection.
    const before = verbsAsked().length;
    const refused = await grant("plan");
    // A 200, because the engine's answer IS the answer to the request - the surface draws
    // the sentence either way.
    assert.equal(refused.status, 200);
    const body = (await refused.json()) as { ok: boolean; detail: string; output: string };
    assert.equal(body.ok, false);
    assert.match(body.detail, /never grants re-entry to 'plan'/);
    assert.equal(body.output, "");
    assert.equal(verbsAsked().length, before, "nothing was spawned");
  });
});

test("a grant is refused for a run whose halt did not ask for one", async () => {
  // The eligibility rule the surface draws its buttons from, held HERE as well - because
  // hiding a button decides what an operator is offered, not what the loopback API accepts.
  // A grant is a standing authorization for the engine to re-enter a DECIDE step unattended:
  // handed to a run that never stopped at a gate, it is the gate's whole purpose spent in
  // advance, and the engine would record it without complaint because from its side a person
  // typed it.
  const { registry, request } = fixture();
  await withEngine(async () => {
    const repo = gitRepo("act-grant-class");
    // Three runs, one per shape the rule has to separate: never halted, halted for something
    // the engine re-kicks itself, and halted for a broken seal - which is a ceremony, not a
    // decision.
    seedConductorRun(repo, "running", { steps: { build: "in_progress" } });
    seedConductorRun(repo, "mech", {
      steps: { build: "done" },
      halt: "the branch would not rebase",
      haltClass: "mechanical",
    });
    seedConductorRun(repo, "sealed", {
      steps: { build: "done" },
      halt: "a sealed decision changed",
      haltClass: "protected-artifact",
    });
    seedConductorRun(repo, "asked", {
      steps: { build: "done" },
      halt: "the DECIDE gate refused a second autonomous entry",
      haltClass: "needs-human",
    });
    seedConductorDaemon(repo, { pid: process.pid });
    await request("/api/pipelines/config", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }],
      }),
    });
    await refreshPipelineRepo(registry, "ai-conductor", repo);

    const grant = (slug: string) =>
      request("/api/pipelines/action", {
        method: "POST",
        body: JSON.stringify({
          provider: "ai-conductor",
          repoRoot: repo,
          slug,
          action: "grant",
          step: "prd",
          reason: "because I said so",
        }),
      });

    const before = verbsAsked().length;
    for (const slug of ["running", "mech", "sealed"]) {
      const refused = await grant(slug);
      // 409 rather than 404 or 400: the request is well formed and the run exists - its STATE
      // is what refuses this, which is a different thing to tell an operator.
      assert.equal(refused.status, 409, slug);
      assert.match(await refused.text(), /answers a halt that asked for one/, slug);
    }
    assert.equal(verbsAsked().length, before, "and nothing was spawned for any of them");
    assert.equal(existsSync(join(repo, ".daemon", "grants")), false, "no grant was recorded");

    // And the run that DID stop at a gate still gets one, so this is an eligibility rule
    // rather than the verb quietly going away.
    const allowed = await grant("asked");
    assert.equal(allowed.status, 200);
    assert.equal(((await allowed.json()) as { ok: boolean }).ok, true);
    assert.equal(existsSync(join(repo, ".daemon", "grants", "asked.json")), true);
  });
});

test("a verb is refused for a repository nobody consented to, and for a run nobody projects", async () => {
  const { registry, request } = fixture();
  await withEngine(async () => {
    const repo = await actable("act-consent", registry, request);
    const before = verbsAsked().length;

    // 404 and the same sentence for both, so the loopback API answers no questions about
    // which directories on this machine exist.
    const elsewhere = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: join(home, "somewhere-else"),
        action: "daemon-stop",
      }),
    });
    assert.equal(elsewhere.status, 404);
    assert.match((await elsewhere.text()), /no such pipeline repository/);

    // A slug is a path component the engine joins onto a root, so it is checked against the
    // runs actually projected rather than validated for shape - which makes `..` a 404 for
    // the right reason.
    for (const slug of ["nope", "../..", ".."]) {
      const res = await request("/api/pipelines/action", {
        method: "POST",
        body: JSON.stringify({ provider: "ai-conductor", repoRoot: repo, slug, action: "park" }),
      });
      assert.equal(res.status, 404, slug);
      assert.match(await res.text(), /no such pipeline run/);
    }

    // Withdrawal is felt at the verb, in the same request that withdrew it.
    await request("/api/pipelines/config", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: false }],
      }),
    });
    const withdrawn = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({ provider: "ai-conductor", repoRoot: repo, slug: "feat", action: "park" }),
    });
    assert.equal(withdrawn.status, 404);
    assert.equal(verbsAsked().length, before, "and nothing was spawned");
  });
});

test("a verb addressed at the wrong scope is refused by the schema, not by the engine", async () => {
  const { registry, request } = fixture();
  await withEngine(async () => {
    const repo = await actable("act-scope", registry, request);
    const before = verbsAsked().length;
    const bad = async (body: Record<string, unknown>): Promise<number> =>
      (await request("/api/pipelines/action", { method: "POST", body: JSON.stringify(body) })).status;

    // A repository verb carrying a slug is the dangerous direction: it reads as "pause this
    // feature" and would in fact pause every feature in the checkout.
    assert.equal(await bad({ provider: "ai-conductor", repoRoot: repo, slug: "feat", action: "daemon-pause" }), 400);
    assert.equal(await bad({ provider: "ai-conductor", repoRoot: repo, action: "park" }), 400);
    assert.equal(await bad({ provider: "ai-conductor", repoRoot: repo, slug: "feat", action: "grant" }), 400);
    assert.equal(await bad({ provider: "ai-conductor", repoRoot: repo, action: "nonsense" }), 400);
    assert.equal(verbsAsked().length, before, "nothing was spawned");
  });
});

test("a reseal terminal is refused for a run whose halt did not ask for one", async () => {
  // The dashboard already hides this ceremony everywhere except a protected-artifact halt.
  // The route holds the same rule because it is the authority boundary: a direct loopback
  // caller must not be able to break a seal, or clear its halt, on an unrelated run.
  const opened: FakeLaunch[] = [];
  const { registry, request } = fixture(opened);
  await withEngine(async () => {
    const repo = gitRepo("act-reseal-class");
    seedConductorRun(repo, "running", { steps: { build: "in_progress" } });
    seedConductorRun(repo, "asked", {
      steps: { build: "done" },
      halt: "a DECIDE gate refused another entry",
      haltClass: "needs-human",
    });
    seedConductorDaemon(repo, { pid: process.pid });
    await request("/api/pipelines/config", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }],
      }),
    });
    await refreshPipelineRepo(registry, "ai-conductor", repo);

    for (const slug of ["running", "asked"]) {
      const refused = await request("/api/pipelines/console", {
        method: "POST",
        body: JSON.stringify({
          provider: "ai-conductor",
          repoRoot: repo,
          slug,
          console: "reseal",
          paths: [".docs/decisions/feature.md"],
          reason: "a direct caller supplied this",
          clearHalt: true,
          backend: "cmux",
        }),
      });
      assert.equal(refused.status, 409, slug);
      assert.match(await refused.text(), /answers a protected-artifact halt/, slug);
    }
    assert.equal(opened.length, 0, "an ineligible ceremony opens no terminal");
  });
});

test("a console opens a hosted terminal running the engine's own command", async () => {
  const opened: FakeLaunch[] = [];
  const { registry, request } = fixture(opened);
  await withEngine(async () => {
    const repo = await actable("act-console", registry, request, "protected-artifact");

    const daemonConsole = await request("/api/pipelines/console", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        console: "daemon",
        backend: "cmux",
      }),
    });
    assert.equal(daemonConsole.status, 200);
    assert.equal(((await daemonConsole.json()) as { ok: boolean }).ok, true);
    assert.equal(opened.length, 1);
    // From the MAIN checkout, and through a shell that holds the window open: `connect`
    // prints and exits when it cannot find a session, and a window that closed with it would
    // take the explanation with it.
    assert.equal(opened[0]?.cwd, repo);
    // Every word single-quoted by `shellCommand`, because this is a shell script the daemon
    // composed - a slug or a path with a space in it must not become two arguments.
    const command = opened[0]?.argv.at(-1) ?? "";
    assert.match(command, /'daemon' 'connect'/);
    assert.doesNotMatch(command, /--attach-into/, "we host the terminal, so there is no target");
    assert.match(command, /read -r _/);
    assert.match(opened[0]?.name ?? "", /ai-conductor daemon/);

    // The ceremony carries the operator's own artifacts and rationale, one `--path` each.
    const reseal = await request("/api/pipelines/console", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        slug: "feat",
        console: "reseal",
        paths: [".docs/decisions/feat.md", ".docs/prd/feat.md"],
        reason: "the decision moved after review",
        clearHalt: true,
        backend: "cmux",
      }),
    });
    assert.equal(reseal.status, 200);
    assert.equal(opened.length, 2);
    const ceremony = opened[1]?.argv.at(-1) ?? "";
    assert.match(ceremony, /'reseal' '--slug' 'feat'/);
    assert.match(
      ceremony,
      /'--path' '\.docs\/decisions\/feat\.md' '--path' '\.docs\/prd\/feat\.md'/,
      "one --path per artifact, repeated - a joined list is one path with commas in it",
    );
    assert.match(ceremony, /'--reason' 'the decision moved after review'/);
    assert.match(ceremony, /'--clear-halt'/);
    assert.match(opened[1]?.name ?? "", /reseal feat/);

    // And the refusals: a reseal with nothing to re-seal, and one naming no feature.
    const noPaths = await request("/api/pipelines/console", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        slug: "feat",
        console: "reseal",
        reason: "why",
        backend: "cmux",
      }),
    });
    assert.equal(noPaths.status, 400);
    const noSlug = await request("/api/pipelines/console", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        console: "reseal",
        paths: ["a.md"],
        reason: "why",
        backend: "cmux",
      }),
    });
    assert.equal(noSlug.status, 400);

    // And the one a length bound cannot catch: a path that leaves the feature's worktree.
    // The engine would accept every one of these - from its side an operator typed them -
    // so the containment is Mission Control's, and it happens before argv is composed.
    for (const path of [
      "../other/.docs/decisions/x.md",
      "a/../../x.md",
      join(repo, "sealed.md"),
      "/etc/passwd",
    ]) {
      const escaped = await request("/api/pipelines/console", {
        method: "POST",
        body: JSON.stringify({
          provider: "ai-conductor",
          repoRoot: repo,
          slug: "feat",
          console: "reseal",
          paths: [".docs/decisions/feat.md", path],
          reason: "why",
          backend: "cmux",
        }),
      });
      assert.equal(escaped.status, 400, path);
      assert.match(await escaped.text(), /outside this feature's worktree|absolute path/, path);
    }
    assert.equal(opened.length, 2, "a refused console opens no window");
  });
});

test("with the integration switched off, no verb acts and no console opens", async () => {
  // The phase's own exit criterion, asserted as one case rather than inferred from the two
  // above: the master switch is what an operator reaches for, and it has to stop BOTH routes.
  const opened: FakeLaunch[] = [];
  const { registry, request } = fixture(opened);
  await withEngine(async () => {
    const repo = await actable("act-master-switch", registry, request);
    await request("/api/pipelines/config", {
      method: "PUT",
      body: JSON.stringify({
        enabled: false,
        repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }],
      }),
    });
    const before = verbsAsked().length;

    const acted = await request("/api/pipelines/action", {
      method: "POST",
      body: JSON.stringify({ provider: "ai-conductor", repoRoot: repo, action: "daemon-stop" }),
    });
    assert.equal(acted.status, 404);
    const console_ = await request("/api/pipelines/console", {
      method: "POST",
      body: JSON.stringify({
        provider: "ai-conductor",
        repoRoot: repo,
        console: "daemon",
        backend: "cmux",
      }),
    });
    assert.equal(console_.status, 404);
    assert.equal(verbsAsked().length, before);
    assert.deepEqual(opened, []);
  });
});

test("consent moves the settings tuple, so the Runs page's tab appears with it", async () => {
  // The Pipelines tab is drawn from `settingsStatus.pipelines.observing`, which rides the
  // connect snapshot. Published at the write rather than waited for on the watcher's
  // once-a-minute presence check: an operator who switches a repository on is entitled to
  // see the surface it produces without wondering whether they mis-clicked.
  const { registry, request } = fixture();
  const repo = gitRepo("observing");
  const seen: number[] = [];
  const unsubscribe = registry.subscribe((event) => {
    if (event.type === "settings_status") seen.push(event.status.pipelines.observing);
  });

  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: true }],
    }),
  });
  await request("/api/pipelines/config", {
    method: "PUT",
    body: JSON.stringify({
      enabled: true,
      repos: [{ provider: "ai-conductor", repoRoot: repo, enabled: false }],
    }),
  });
  unsubscribe();

  assert.deepEqual(seen, [1, 0], "on and off both reach the browser at the write");
});
