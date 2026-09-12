import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { Task } from "../src/shared/types.ts";
// Pure and browser-safe (no `node:` imports), so a static import cannot open the DB ahead
// of the HARNESS_HOME preamble below.
import { TaskSourcesConfigSchema } from "../src/shared/task-source.ts";

// `POST /api/tasks/:id/push` as an HTTP client sees it. What is at stake is the STATUS
// CODE, and specifically one distinction inside it: 502 means GitHub refused and nothing
// was published, so retrying is safe; 504 means the outcome is unknown, so retrying may
// file a second issue into a tracker other people are reading. Any path that maps a dead
// `gh` to 502 invites a double-created issue, and no unit test of the mapping function can
// prove the route wired it up that way.
//
// The three interesting codes run against a FAKE `gh` on disk rather than a stubbed
// dependency, reached through the `MISSION_GH_BIN` seam phase 1 added. That is deliberate:
// it exercises the actual chain - route -> pushTask -> pushToSource -> the github-issues
// implementation -> `run()` -> `pushResultFrom` - so the argv the operator's repo would
// receive, the cwd it would run in, and the reading of a child that died by signal are all
// the real ones. A stub at the route would have proved only that the route can map an
// enum it was handed.
//
// The refusals that happen BEFORE anything is spawned need no fake at all, and that they
// need none is itself the property: a 400/404/409 from here published nothing.

const home = mkdtempSync(join(tmpdir(), "mission-task-push-http-"));
process.env.HARNESS_HOME = home;

const { openDb, countTaskSourceSeen, getTask } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { setTaskSourcesConfig } = await import("../src/server/task-sources/config.ts");

/**
 * The repo both the task and the source are bound to - a real directory, since gh gets a cwd.
 *
 * Realpath'd, because macOS's temp dir is a symlink into `/private/var` and the `pwd` the
 * fake reports back is the resolved one. Comparing an unresolved path against it fails on
 * a machine where the code is perfectly correct.
 */
const repo = realpathSync(mkdtempSync(join(tmpdir(), "mission-task-push-repo-")));
const bin = mkdtempSync(join(tmpdir(), "mission-task-push-bin-"));
const record = join(bin, "gh-argv.txt");

after(() => {
  for (const dir of [home, repo, bin]) rmSync(dir, { recursive: true, force: true });
});

/**
 * A `gh` that behaves one of three ways, written to disk and pointed at by `MISSION_GH_BIN`.
 *
 * `unknown` kills itself with SIGKILL, which is the honest reproduction rather than a
 * convenience: `run()` reads `outcomeUnknown` off a child that died WITHOUT reporting its
 * own exit, which is what our own timeout, the OOM killer and an operator's `pkill` all
 * look like. Faking it with a special exit code would exercise the 502 path instead.
 */
function fakeGh(mode: "created" | "refused" | "unknown"): string {
  const path = join(bin, `gh-${mode}`);
  const body =
    mode === "created"
      ? [
          // Everything gh was asked to do, for the assertions below: the cwd first, then
          // one argv entry per line so a title with spaces stays one entry.
          `{ pwd; for a in "$@"; do printf '%s\\n' "$a"; done; } > "$MC_GH_RECORD"`,
          `echo "Creating issue in acme/demo"`,
          `echo "https://github.com/acme/demo/issues/7"`,
        ]
      : mode === "refused"
        ? [`echo "could not add label: 'triage' not found" >&2`, `exit 1`]
        : [`kill -9 $$`];
  writeFileSync(path, ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

const GH = {
  created: fakeGh("created"),
  refused: fakeGh("refused"),
  unknown: fakeGh("unknown"),
};

function setup(over: Partial<Task> = {}) {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const task = mkTask({
    id: "t1",
    title: "Fix the parser",
    intent: "the parser drops trailing commas",
    status: "backlog",
    repoRoot: repo,
    ...over,
  });
  registry.upsertTask(task);
  const app = buildApp({
    registry,
    reviews: {} as unknown as ReviewManager,
    tasks,
    queues: {} as unknown as QueueManager,
  });
  const push = async (id: string, body: unknown): Promise<Response> =>
    app.request(`/api/tasks/${id}/push`, {
      method: "POST",
      headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { registry, tasks, push };
}

/**
 * Configure the sources this daemon knows about.
 *
 * Written straight through the config module rather than through
 * `PUT /api/task-sources/config`, so the fixture does not need a real git checkout to
 * satisfy that route's repo resolution - and so the `repoRoot` these tests compare is
 * exactly the string that was stored, which is the comparison the push guard makes.
 */
function configure(...sources: Array<Record<string, unknown>>): void {
  setTaskSourcesConfig(
    TaskSourcesConfigSchema.parse({ sources: sources.map((s) => ({ repoRoot: repo, ...s })) }),
  );
}

const GITHUB = {
  id: "src-gh",
  kind: "github-issues",
  label: "demo issues",
  config: { labelsAny: ["mission", "triage"] },
};

beforeEach(() => {
  openDb().exec("DELETE FROM tasks; DELETE FROM task_source_seen; DELETE FROM app_config;");
  delete process.env.MISSION_GH_BIN;
  delete process.env.MC_GH_RECORD;
});

// ---- the refusals that spawn nothing ----

test("a body with no sourceId is refused at the door", async () => {
  configure(GITHUB);
  const res = await setup().push("t1", {});
  assert.equal(res.status, 400);
});

test("no such task is a 404, and is asked before the source is even resolved", async () => {
  configure(GITHUB);
  const res = await setup().push("nope", { sourceId: "src-gh" });
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /no such task/);
});

test("no such task source is a 404, in the wording the sibling routes already use", async () => {
  configure(GITHUB);
  const res = await setup().push("t1", { sourceId: "src-gone" });
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, "no such task source");
});

// 400 rather than 409: no change of state makes a Jira source able to receive a push, so
// this is a request that could never work rather than one that is currently blocked.
test("a kind that cannot receive pushes is a 400", async () => {
  configure({ id: "src-jira", kind: "jira", label: "jira", config: {} });
  const res = await setup().push("t1", { sourceId: "src-jira" });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /jira cannot receive pushed tasks/);
});

test("a task that has left the backlog is a 409", async () => {
  configure(GITHUB);
  const res = await setup({ status: "running" }).push("t1", { sourceId: "src-gh" });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /not in the backlog/);
});

test("a source bound to another repo is a 409", async () => {
  configure({ ...GITHUB, repoRoot: join(repo, "elsewhere") });
  const res = await setup().push("t1", { sourceId: "src-gh" });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /files against/);
});

// ---- the three answers that need a gh ----

test("a created issue answers 200 with the linked task, records it seen, and files it right", async () => {
  configure(GITHUB);
  process.env.MISSION_GH_BIN = GH.created;
  process.env.MC_GH_RECORD = record;

  const res = await setup().push("t1", { sourceId: "src-gh" });
  assert.equal(res.status, 200);
  // The updated Task, like the dispatch/assign/complete siblings - so a caller reads the
  // link off the reply instead of racing the `task_upsert` event.
  const task = (await res.json()) as Task;
  assert.deepEqual(task.source, {
    sourceId: "src-gh",
    externalId: "acme/demo#7",
    url: "https://github.com/acme/demo/issues/7",
  });
  assert.equal(task.status, "backlog", "a pushed task stays in the backlog");

  // Persisted, not merely returned.
  assert.deepEqual(getTask("t1")!.source, task.source);
  // And remembered, which is what stops this source's next sweep from filing the issue this
  // very request created as a second backlog task.
  assert.equal(countTaskSourceSeen("src-gh"), 1);

  const [cwd, ...argv] = readFileSync(record, "utf8").trimEnd().split("\n");
  assert.equal(cwd, repo, "gh ran outside the repo, so it would resolve the wrong one");
  assert.deepEqual(argv, [
    "issue",
    "create",
    "--title",
    "Fix the parser",
    "--body",
    "the parser drops trailing commas",
    // The source's own sweep filter, so the created issue matches what this source sweeps.
    "--label",
    "mission",
    "--label",
    "triage",
  ]);
});

test("a second push of a now-linked task is a 409, not a second issue", async () => {
  configure(GITHUB);
  process.env.MISSION_GH_BIN = GH.created;
  process.env.MC_GH_RECORD = record;
  const app = setup();
  assert.equal((await app.push("t1", { sourceId: "src-gh" })).status, 200);

  const again = await app.push("t1", { sourceId: "src-gh" });
  assert.equal(again.status, 409);
  assert.match(((await again.json()) as { error: string }).error, /already linked to acme\/demo#7/);
  assert.equal(countTaskSourceSeen("src-gh"), 1);
});

// 502: gh ran and said no. Nothing was published, so the caller may retry - and the UI
// keeps its button on the strength of exactly this code.
test("a gh that refuses is a 502, and leaves nothing behind", async () => {
  configure(GITHUB);
  process.env.MISSION_GH_BIN = GH.refused;

  const res = await setup().push("t1", { sourceId: "src-gh" });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string; outcomeUnknown?: boolean };
  assert.match(body.error, /'triage' not found/);
  assert.equal(body.outcomeUnknown, undefined, "a refusal must not look like an unknown outcome");
  assert.equal(countTaskSourceSeen("src-gh"), 0);
  assert.equal(getTask("t1")!.source, null);
});

// 504: gh died without reporting back, so the issue MAY exist. The whole safety property
// of this route is that this case does not arrive as a 502.
test("a gh that never reports back is a 504 carrying outcomeUnknown", async () => {
  configure(GITHUB);
  process.env.MISSION_GH_BIN = GH.unknown;

  const res = await setup().push("t1", { sourceId: "src-gh" });
  assert.equal(res.status, 504, "an unknown outcome answered as retry-safe double-creates issues");
  const body = (await res.json()) as { error: string; outcomeUnknown?: boolean };
  // Flagged as well as worded, so a client drops its retry affordance without parsing prose.
  assert.equal(body.outcomeUnknown, true);
  assert.match(body.error, /check GitHub before retrying/);
  // Nothing recorded: a sweep is the operator's best way of finding out whether the issue
  // is actually there, and a seen row would suppress it.
  assert.equal(countTaskSourceSeen("src-gh"), 0);
  assert.equal(getTask("t1")!.source, null);
});
