import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { QueueManager } from "../src/server/queue.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { RepoIndexView } from "../src/shared/repo-index.ts";

const root = mkdtempSync(join(tmpdir(), "mission-repo-index-http-"));
const operatorHome = join(root, "operator");
const stateHome = join(root, "state");
const previousHome = process.env.HOME;
const previousMissionHome = process.env.MISSION_HOME;
const WORKSPACE_ENV_NAMES = [
  "MISSION_WORKSPACE_DIRS",
  "FLEET_WORKSPACE_DIRS",
  "HARNESS_WORKSPACE_DIRS",
  "MISSION_WORKSPACE_DIR",
  "FLEET_WORKSPACE_DIR",
  "HARNESS_WORKSPACE_DIR",
] as const;
const previousWorkspaceEnv = new Map(
  WORKSPACE_ENV_NAMES.map((name) => [name, process.env[name]]),
);

mkdirSync(operatorHome, { recursive: true });
mkdirSync(stateHome, { recursive: true });
// Set the supported test home before importing any server module that can resolve the DB.
process.env.MISSION_HOME = stateHome;
process.env.HOME = operatorHome;
for (const name of WORKSPACE_ENV_NAMES) delete process.env[name];

const { openDb } = await import("../src/server/db.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { invalidateReposCache } = await import("../src/server/repos.ts");

const app = buildApp({
  registry: {} as Registry,
  reviews: {} as ReviewManager,
  tasks: {} as TaskManager,
  queues: {} as QueueManager,
});
const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), "gitdir: /fixture\n");
}

async function getView(): Promise<RepoIndexView> {
  const res = await app.request("/api/repo-index", { headers: HEADERS });
  assert.equal(res.status, 200);
  return await res.json() as RepoIndexView;
}

async function putDirectories(paths: string[]): Promise<Response> {
  return app.request("/api/repo-index", {
    method: "PUT",
    headers: HEADERS,
    body: JSON.stringify({ directories: paths.map((path) => ({ path })) }),
  });
}

beforeEach(() => {
  for (const name of WORKSPACE_ENV_NAMES) delete process.env[name];
  openDb().exec("DELETE FROM app_config WHERE key = 'repoIndex'");
  rmSync(operatorHome, { recursive: true, force: true });
  mkdirSync(operatorHome, { recursive: true });
  invalidateReposCache();
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousMissionHome === undefined) delete process.env.MISSION_HOME;
  else process.env.MISSION_HOME = previousMissionHome;
  for (const name of WORKSPACE_ENV_NAMES) {
    const value = previousWorkspaceEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("GET reports seeded directory statuses and repository counts", async () => {
  makeRepo(join(operatorHome, "workspace", "demo"));
  const nonDirectory = join(operatorHome, "dev");
  writeFileSync(nonDirectory, "not a directory\n");

  const view = await getView();
  assert.equal(view.managedBy, "config");
  assert.equal(view.environmentVariable, null);
  assert.equal(view.environmentValue, null);
  assert.deepEqual(view.directories.map((row) => row.path), [
    "~/workspace",
    "~/code",
    "~/dev",
    "~/upstart",
  ]);
  assert.deepEqual(
    view.directories.map((row) => [row.path, row.status, row.repoCount]),
    [
      ["~/workspace", "ok", 1],
      ["~/code", "missing", null],
      ["~/dev", "not-a-directory", null],
      ["~/upstart", "missing", null],
    ],
  );
  assert.ok(view.directories.every((row) => row.isDefault));
  assert.deepEqual(view.savedDirectories, []);
  assert.deepEqual(view.defaultsMissing, []);
  assert.equal(view.repoCount, 1);
  assert.equal(typeof view.scannedAt, "number");
});

test("the environment override wins and preserves the saved rows read-only", async () => {
  const configured = join(operatorHome, "workspace");
  const overridden = join(operatorHome, "code");
  makeRepo(join(configured, "saved"));
  makeRepo(join(overridden, "effective"));
  assert.equal((await putDirectories(["~/workspace"])).status, 200);

  process.env.MISSION_WORKSPACE_DIRS = overridden;
  invalidateReposCache();
  const view = await getView();
  assert.equal(view.managedBy, "environment");
  assert.equal(view.environmentVariable, "MISSION_WORKSPACE_DIRS");
  assert.equal(view.environmentValue, overridden);
  assert.deepEqual(view.directories.map((row) => row.path), [overridden]);
  assert.equal(view.directories[0]?.repoCount, 1);
  assert.deepEqual(view.savedDirectories.map((row) => row.path), ["~/workspace"]);
  assert.equal(view.savedDirectories[0]?.repoCount, null);

  const refused = await putDirectories(["~/dev"]);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "Repository index directories are read-only while MISSION_WORKSPACE_DIRS is set.",
  });
  assert.deepEqual((await getView()).savedDirectories.map((row) => row.path), ["~/workspace"]);
});

test("validation refuses empty, relative, broad, duplicate, and oversized lists", async () => {
  const parent = dirname(operatorHome);
  const sibling = join(parent, `${basename(operatorHome)}2`, "code");
  const workspace = join(operatorHome, "workspace");
  const alias = join(operatorHome, "workspace-link");
  mkdirSync(workspace, { recursive: true });
  symlinkSync(workspace, alias);

  const refused: Array<{ paths: string[]; message: RegExp }> = [
    { paths: ["   "], message: /Directory paths cannot be empty/ },
    { paths: ["relative/code"], message: /not an absolute path/ },
    { paths: ["/"], message: /at or above your home directory/ },
    { paths: [operatorHome], message: /at or above your home directory/ },
    { paths: ["~/.."], message: /at or above your home directory/ },
    { paths: [`${operatorHome}/..`], message: /at or above your home directory/ },
    { paths: [parent], message: /at or above your home directory/ },
    {
      paths: [`${operatorHome}/projects/not-yet/../../../`],
      message: /at or above your home directory/,
    },
    { paths: [workspace, alias], message: /same directory/ },
    {
      paths: Array.from({ length: 17 }, (_, index) => join(operatorHome, `code-${index}`)),
      message: /At most 16 directories/,
    },
  ];

  for (const { paths, message } of refused) {
    const res = await putDirectories(paths);
    assert.equal(res.status, 400, `expected ${JSON.stringify(paths)} to be refused`);
    const body = await res.json() as { error: string };
    assert.match(body.error, message);
  }

  const accepted = await putDirectories([sibling]);
  assert.equal(accepted.status, 200, "a sibling whose name shares the home prefix is safe");
});

test("a removed default and an intentionally empty list survive a re-read", async () => {
  const withoutDev = ["~/workspace", "~/code", "~/upstart"];
  assert.equal((await putDirectories(withoutDev)).status, 200);
  assert.deepEqual((await getView()).directories.map((row) => row.path), withoutDev);
  assert.deepEqual((await getView()).defaultsMissing, ["~/dev"]);

  assert.equal((await putDirectories([])).status, 200);
  const empty = await getView();
  assert.deepEqual(empty.directories, []);
  assert.deepEqual(empty.defaultsMissing, ["~/workspace", "~/code", "~/dev", "~/upstart"]);
  assert.equal(empty.repoCount, 0);
});

test("restoring defaults adds only missing defaults and keeps an operator path", async () => {
  const custom = join(operatorHome, "projects");
  assert.equal((await putDirectories(["~/workspace", custom])).status, 200);
  const edited = await getView();
  const restored = [
    ...edited.directories.map((row) => row.path),
    ...edited.defaultsMissing,
  ];
  assert.equal((await putDirectories(restored)).status, 200);
  const view = await getView();
  assert.deepEqual(view.directories.map((row) => row.path), [
    "~/workspace",
    custom,
    "~/code",
    "~/dev",
    "~/upstart",
  ]);
});

test("an absolute spelling of a seeded directory is not offered as a duplicate default", async () => {
  const workspace = join(operatorHome, "workspace");
  assert.equal((await putDirectories([workspace])).status, 200);
  assert.deepEqual((await getView()).defaultsMissing, ["~/code", "~/dev", "~/upstart"]);
});

test("a saved missing directory is reported unsafe if it later resolves at or above home", async () => {
  const deferred = join(operatorHome, "future-code");
  assert.equal((await putDirectories([deferred])).status, 200);
  assert.equal((await getView()).directories[0]?.status, "missing");

  symlinkSync(operatorHome, deferred);
  const view = await getView();
  assert.deepEqual(view.directories[0], {
    path: deferred,
    resolved: realpathSync(operatorHome),
    status: "unsafe",
    repoCount: null,
    isDefault: false,
  });
  assert.equal(view.repoCount, 0);
});

test("a config write and Rescan now both invalidate the repository cache", async () => {
  const workspace = join(operatorHome, "workspace");
  mkdirSync(workspace, { recursive: true });
  assert.equal((await putDirectories([workspace])).status, 200);
  assert.equal((await getView()).repoCount, 0);

  makeRepo(join(workspace, "after-first-read"));
  assert.equal((await getView()).repoCount, 0, "the ordinary read should still use the cache");

  assert.equal((await putDirectories([workspace])).status, 200);
  assert.equal((await getView()).repoCount, 1, "a config write invalidates the cache");

  makeRepo(join(workspace, "after-write"));
  const res = await app.request("/api/repo-index/rescan", {
    method: "POST",
    headers: HEADERS,
  });
  assert.equal(res.status, 200);
  const rescanned = await res.json() as RepoIndexView;
  assert.equal(rescanned.repoCount, 2);
});

test("unreadable directories have a stable view status when the host enforces permissions", async () => {
  const unreadable = join(operatorHome, "unreadable");
  mkdirSync(unreadable, { recursive: true });
  chmodSync(unreadable, 0o000);
  try {
    assert.equal((await putDirectories([unreadable])).status, 200);
    const row = (await getView()).directories[0]!;
    assert.ok(
      row.status === "unreadable" || row.status === "ok",
      `permission-enforcing hosts report unreadable; privileged runners may report ok, got ${row.status}`,
    );
  } finally {
    chmodSync(unreadable, 0o700);
  }
});
