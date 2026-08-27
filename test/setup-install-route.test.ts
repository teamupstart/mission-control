import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-setup-install-route-"));
process.env.MISSION_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { SETUP_DEPENDENCY_INFO } = await import("../src/shared/setup-catalog.ts");
const { setupInstallerShell } = await import("../src/server/setup/install.ts");
type SetupDependencyId = import("../src/shared/setup-catalog.ts").SetupDependencyId;
type SetupRemedy = import("../src/shared/setup-catalog.ts").SetupRemedy;
type SetupInstallRouteDeps = import("../src/server/setup/install.ts").SetupInstallRouteDeps;
type TerminalBackendId = import("../src/shared/terminal.ts").TerminalBackendId;
type TerminalLaunchSpec = import("../src/server/terminal/targets.ts").TerminalLaunchSpec;

const LOOPBACK = { host: "127.0.0.1:7317", "content-type": "application/json" };

after(() => rmSync(home, { recursive: true, force: true }));

interface LaunchCall extends TerminalLaunchSpec {
  backend: TerminalBackendId;
}

function catalogWith(id: SetupDependencyId, remedy: SetupRemedy) {
  return {
    ...SETUP_DEPENDENCY_INFO,
    [id]: { ...SETUP_DEPENDENCY_INFO[id], remedy },
  };
}

function appFor({
  calls,
  launchResult = { ok: true, label: "cmux", status: 200 },
  install = {},
}: {
  calls: LaunchCall[];
  launchResult?: { ok: boolean; label: string; error?: string; status: number };
  install?: SetupInstallRouteDeps;
}) {
  const registry = new Registry();
  const launcher = async (backend: TerminalBackendId, spec: TerminalLaunchSpec) => {
    calls.push({ backend, ...spec });
    return { ...launchResult, homeName: spec.name };
  };
  return buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined, // away
    undefined, // personas
    undefined, // workflows
    undefined, // schedules
    undefined, // ensembles
    undefined, // sdk sessions
    undefined, // handoff deps
    launcher,
    undefined, // session actions
    undefined, // pending turns
    undefined, // pane deps
    undefined, // keep awake
    undefined, // archives
    undefined, // workflow commands
    undefined, // worktrees
    undefined, // worktree operations
    undefined, // model catalogs
    undefined, // product issues
    undefined, // file comments
    undefined, // file comment walkthrough
    undefined, // settings backups
    undefined, // setup check deps
    {
      catalog: SETUP_DEPENDENCY_INFO,
      homeDir: home,
      listRepoRoots: async () => ["/verified"],
      listProviderInstallers: async (provider, roots) => ({
        provider,
        supported: true,
        runtime: {
          id: "node",
          label: "Node.js",
          current: "26.7.0",
          requirement: ">=26.0.0",
          supported: true,
          detail: "Installer runtime ready.",
        },
        detail: "One verified local installer checkout found.",
        candidates: roots.slice(0, 1).map((checkout) => ({
          provider,
          checkout,
          remote: "github.com/mancej/ai-conductor",
          version: "test",
          changes: [],
        })),
      }),
      prepareProviderInstaller: async (provider, checkout) => ({
        ok: true,
        candidate: {
          provider,
          checkout,
          remote: "github.com/mancej/ai-conductor",
          version: "test",
          changes: [],
        },
        argv: [`${checkout}/bin/install`],
        cwd: checkout,
        title: "Install ai-conductor",
        terminalEnv: { PATH: `${checkout}/bin` },
      }),
      ...install,
    },
  );
}

function post(app: ReturnType<typeof buildApp>, body: unknown): Promise<Response> {
  return Promise.resolve(app.request("/api/setup/install", {
    method: "POST",
    headers: LOOPBACK,
    body: JSON.stringify(body),
  }));
}

test("the setup install schema refuses malformed shape and unknown ids before launch", async () => {
  const calls: LaunchCall[] = [];
  const app = appFor({ calls });
  for (const body of [
    { id: "unknown", backend: "cmux" },
    { id: 17, backend: "cmux" },
    { id: "wezterm" },
    { id: "wezterm", backend: "unknown" },
    { id: "ai-conductor", backend: "cmux", checkout: "" },
    { id: "ai-conductor", backend: "cmux", checkout: "/browser/path" },
    { id: "wezterm", backend: "cmux", argv: ["brew", "install", "wezterm"] },
  ]) {
    assert.equal((await post(app, body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});

test("the route refuses inert remedies before launch", async () => {
  const calls: LaunchCall[] = [];
  const app = appFor({ calls });
  const link = await post(app, { id: "codex-cli", backend: "cmux" });
  assert.equal(link.status, 409);
  assert.match(await link.text(), /opens a link/);

  const skill = appFor({
    calls,
    install: { catalog: catalogWith("codex-cli", { kind: "skill", command: "/setup" }) },
  });
  const skillResponse = await post(skill, { id: "codex-cli", backend: "cmux" });
  assert.equal(skillResponse.status, 409);
  assert.match(await skillResponse.text(), /must run inside a session/);
  assert.deepEqual(calls, []);
});

test("a provider remedy delegates through server verification and preserves its argv and cwd", async () => {
  const calls: LaunchCall[] = [];
  const listed: Array<{ provider: string; roots: readonly string[] }> = [];
  const prepared: Array<{ provider: string; checkout: string; roots: readonly string[] }> = [];
  const app = appFor({
    calls,
    install: {
      listRepoRoots: async () => ["/workspace/a", "/workspace/b"],
      listProviderInstallers: async (provider, roots) => {
        listed.push({ provider, roots });
        return {
          provider,
          supported: true,
          runtime: {
            id: "node",
            label: "Node.js",
            current: "26.7.0",
            requirement: ">=26.0.0",
            supported: true,
            detail: "Installer runtime ready.",
          },
          detail: "One verified local installer checkout found.",
          candidates: [{
            provider,
            checkout: "/verified",
            remote: "github.com/mancej/ai-conductor",
            version: "test",
            changes: [],
          }],
        };
      },
      prepareProviderInstaller: async (provider, checkout, roots) => {
        prepared.push({ provider, checkout, roots });
        return {
          ok: true,
          candidate: {
            provider,
            checkout,
            remote: "github.com/mancej/ai-conductor",
            version: "test",
            changes: [],
          },
          argv: ["/verified/bin/install"],
          cwd: "/verified",
          title: "Verified installer",
          terminalEnv: { PATH: "/verified/bin" },
        };
      },
    },
  });
  const response = await post(app, {
    id: "ai-conductor",
    backend: "cmux",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(listed, [{
    provider: "ai-conductor",
    roots: ["/workspace/a", "/workspace/b"],
  }]);
  assert.deepEqual(prepared, [{
    provider: "ai-conductor",
    checkout: "/verified",
    roots: ["/workspace/a", "/workspace/b"],
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cwd, "/verified");
  assert.equal(calls[0]?.name, "Verified installer");
  assert.deepEqual(calls[0]?.argv, [
    process.env.SHELL || "/bin/sh",
    "-c",
    setupInstallerShell(["/usr/bin/env", "PATH=/verified/bin", "/verified/bin/install"]),
  ]);
});

test("a provider remedy refuses ambiguous daemon-owned candidates before preparation", async () => {
  const calls: LaunchCall[] = [];
  let preparations = 0;
  const app = appFor({
    calls,
    install: {
      listProviderInstallers: async (provider) => ({
        provider,
        supported: true,
        runtime: {
          id: "node",
          label: "Node.js",
          current: "26.7.0",
          requirement: ">=26.0.0",
          supported: true,
          detail: "Installer runtime ready.",
        },
        detail: "Two verified local installer checkouts found.",
        candidates: ["/one", "/two"].map((checkout) => ({
          provider,
          checkout,
          remote: "github.com/mancej/ai-conductor",
          version: "test",
          changes: [],
        })),
      }),
      prepareProviderInstaller: async () => {
        preparations += 1;
        return { ok: false, error: "must not prepare" };
      },
    },
  });
  const response = await post(app, { id: "ai-conductor", backend: "cmux" });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /Multiple verified installer checkouts/);
  assert.equal(preparations, 0);
  assert.deepEqual(calls, []);
});

test("a provider verification refusal reaches the operator and never reaches the terminal", async () => {
  const calls: LaunchCall[] = [];
  const app = appFor({
    calls,
    install: {
      prepareProviderInstaller: async () => ({
        ok: false,
        error: "That checkout is no longer a verified installer candidate.",
      }),
    },
  });
  const response = await post(app, {
    id: "ai-conductor",
    backend: "cmux",
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /no longer a verified installer candidate/);
  assert.deepEqual(calls, []);
});

test("a bad future catalog command is refused by the runtime guard before launch", async () => {
  const calls: LaunchCall[] = [];
  const app = appFor({
    calls,
    install: {
      catalog: catalogWith("wezterm", {
        kind: "command",
        argv: ["npm", "exec", "arbitrary-code"],
        note: "bad future edit",
      }),
    },
  });
  const response = await post(app, { id: "wezterm", backend: "cmux" });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /outside Mission Control's approved install grammar/);
  assert.deepEqual(calls, []);
});

test("a command remedy launches the exact catalog argv in the hold-open wrapper from home", async () => {
  const calls: LaunchCall[] = [];
  const app = appFor({ calls });
  const response = await post(app, { id: "wezterm", backend: "cmux" });
  const body = await response.json() as { outcome: string; detail: string };
  assert.equal(response.status, 200);
  assert.equal(body.outcome, "opened");
  assert.match(body.detail, /Watch it finish and read its exit code/);
  assert.deepEqual(calls, [{
    backend: "cmux",
    name: "Install WezTerm",
    cwd: home,
    argv: [
      process.env.SHELL || "/bin/sh",
      "-c",
      setupInstallerShell(["brew", "install", "--cask", "wezterm"]),
    ],
  }]);
});

test("terminal outcomes preserve status and the launcher's exact sentence", async () => {
  for (const expected of [
    { status: 404, outcome: "refused" },
    { status: 409, outcome: "refused" },
    { status: 502, outcome: "refused" },
    { status: 504, outcome: "maybe-opening" },
  ] as const) {
    const calls: LaunchCall[] = [];
    const sentence = `launcher sentence ${expected.status}`;
    const app = appFor({
      calls,
      launchResult: { ok: false, label: "cmux", error: sentence, status: expected.status },
    });
    const response = await post(app, { id: "wezterm", backend: "cmux" });
    const body = await response.json() as { outcome: string; detail: string };
    assert.equal(response.status, expected.status);
    assert.equal(body.outcome, expected.outcome);
    assert.equal(body.detail, sentence);
    assert.equal(calls.length, 1);
  }
});
