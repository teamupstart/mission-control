import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-tools-dispatch-")));
process.env.MISSION_HOME = home;
process.env.MISSION_PI_EXTENSION = join(home, "missing-extension.js");
process.env.MISSION_PORT = "7317";
process.env.MISSION_PRODUCT_ISSUE_CLIENT = "browser";
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_CODEX_BIN = "/bin/echo";
process.env.MISSION_PI_BIN = "/bin/echo";
process.env.MISSION_MCP_SERVER = join(home, "server.mjs");
process.env.MISSION_CODEX_HOOK = join(home, "codex-hook.mjs");
writeFileSync(process.env.MISSION_CODEX_HOOK, "// Registration fixture.\n");
writeFileSync(process.env.MISSION_MCP_SERVER, "// Only registration is under test.\n");

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { prepareTaskRepositories } = await import("../src/server/task-repository-preparation.ts");
const { missionToolsAvailability } = await import("../src/server/mission-tools.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const roots: string[] = [home];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function repo() {
  const fixture = mkOriginAndClone("mission-tools-repo-");
  roots.push(fixture.root);
  return fixture.clone;
}

for (const kind of ["plan", "scout"] as const) {
  test(`Pi ${kind} is refused at preparation without a worktree`, async () => {
    const clone = repo();
    const before = gitIn(clone, "worktree", "list", "--porcelain");
    const result = await prepareTaskRepositories({
      primary: clone, extras: [], agent: "pi", kind, shortNameSelectors: "none",
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("Pi tools are unavailable");
    assert.equal(result.status, 400);
    assert.match(result.error, /integration for Pi is not installed/);
    assert.doesNotMatch(result.error, /bundle|npm run build/);
    assert.equal(gitIn(clone, "worktree", "list", "--porcelain"), before);
    assert.equal(existsSync(join(home, "worktrees")), false);
  });
}

for (const kind of ["plan", "scout", "ship"] as const) {
  test(`existing Pi ${kind} fails visibly before bases, leases, or spawn`, async () => {
    const clone = repo();
    const registry = new Registry();
    const id = `pi-${kind}`;
    registry.upsertTask(mkTask({ id, kind, agent: "pi", status: "backlog", repoRoot: clone }));
    const before = gitIn(clone, "worktree", "list", "--porcelain");
    let touched = false;
    const fail = async (): Promise<never> => { touched = true; throw new Error("resource boundary crossed"); };
    await new Dispatcher(registry, async (task) => { assert.equal(task.worktreePath, null); }, { resolveBases: fail, spawn: fail }).dispatch(id,
      kind === "ship" ? { missionMcp: { tools: ["submit_ensemble_result"] } } : {},
    );
    const task = registry.getTask(id)!;
    assert.equal(touched, false, "refusal must precede provisioning, not acquire and clean it up afterwards");
    assert.equal(task.status, "failed");
    assert.match(task.error!, /integration for Pi is not installed/);
    assert.doesNotMatch(task.error!, /bundle|npm run build/);
    assert.equal(task.worktreePath, null);
    assert.equal(gitIn(clone, "worktree", "list", "--porcelain"), before);
    assert.equal(existsSync(join(home, "worktrees")), false);
  });
}

test("one machine probe can satisfy availability without changing Pi's MCP client", async () => {
  let calls = 0;
  assert.deepEqual(await missionToolsAvailability("pi", () => { calls++; return true; }), {
    available: true, reason: null,
  });
  assert.equal(calls, 1);
  assert.equal((await missionToolsAvailability("pi")).available, false);
  for (const agent of ["claude", "codex"] as const) {
    assert.equal((await missionToolsAvailability(agent, () => { throw new Error("not machine scoped"); })).available, true);
  }
  assert.equal((await prepareTaskRepositories({
    primary: repo(), extras: [], agent: "pi", kind: "ship", shortNameSelectors: "none",
  })).ok, true);
});

for (const agent of ["claude", "codex"] as const) {
  test(`${agent} dispatch argv is byte-identical to the pre-capability baseline`, async () => {
    const clone = repo();
    setHarnessesConfig({ autoModeOnDispatch: true });
    const registry = new Registry();
    const id = `argv-${agent}`;
    registry.upsertTask(mkTask({ id, agent, repoRoot: clone, title: "Argv contract" }));
    const captured: { argv: string[] | null } = { argv: null };
    await new Dispatcher(registry, async () => {}, {
      resolveRuntime: () => "terminal",
      verifyMissionMcpTools: async () => ({ ok: true }),
      spawn: async (_label, _short, _cwd, _bin, args) => {
        captured.argv = [...args!];
        throw new Error("captured at the spawn boundary");
      },
    }).dispatch(id, { missionMcp: { tools: ["request_input", "submit_ensemble_result"] } });
    const argv = captured.argv;
    assert.ok(argv, registry.getTask(id)?.error ?? "spawn must receive argv");
    // Captured from dispatcher.ts at cc709c01, before this capability change. Only
    // machine paths, the inherited PATH and temporary credential locations vary.
    // Every flag, other value, ordering and escaped byte is pinned.
    const stable = argv.map((arg) => arg
      .replace(/"PATH"="[^"]*"/, '"PATH"="<PATH>"')
      .replace(/"MISSION_HOME"="[^"]*"/, '"MISSION_HOME"="<AGENT_HOME>"')
      .replace(/"MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE"="[^"]*"/,
        '"MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE"="<CREDENTIAL_FILE>"'));
    const serialized = JSON.stringify(stable, null, 2)
      .replaceAll(home, "<STATE_HOME>")
      .replaceAll(process.cwd(), "<CHECKOUT>")
      .replaceAll(process.execPath, "<NODE>");
    const fixture = new URL(`./fixtures/mission-tools-${agent}-argv.json`, import.meta.url);
    assert.equal(serialized + "\n", readFileSync(fixture, "utf8"));
  });
}

test("workflow-required evidence is refused early, while one successful probe reaches Pi's launch", async () => {
  const clone = repo();
  const registry = new Registry();
  registry.upsertTask(mkTask({ id: "workflow-pi", agent: "pi", repoRoot: clone }));
  let bases = 0;
  await new Dispatcher(registry, async () => {}, {
    workflowEvidenceEnabled: () => true,
    resolveBases: async () => { bases++; throw new Error("too late"); },
  }).dispatch("workflow-pi");
  assert.equal(bases, 0);
  assert.match(registry.getTask("workflow-pi")!.error!, /integration for Pi is not installed/);

  registry.upsertTask(mkTask({ id: "installed-pi", agent: "pi", repoRoot: clone }));
  let probes = 0;
  let verified = 0;
  let spawned = false;
  await new Dispatcher(registry, async () => {}, {
    piExtensionInstalled: async () => { probes++; return true; },
    verifyMissionMcpTools: async () => { verified++; return { ok: true }; },
    spawn: async () => { spawned = true; throw new Error("captured Pi launch"); },
  }).dispatch("installed-pi", { missionMcp: { tools: ["request_input"] } });
  assert.equal(probes, 1, "preparation and launch must use one installation reading");
  assert.equal(verified, 1, "an extension still owes the existing bundle tool check");
  assert.equal(spawned, true, registry.getTask("installed-pi")!.error!);
});
