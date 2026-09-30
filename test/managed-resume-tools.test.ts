// Transport must be usable before stop; a terminal's credentials outlive daemon uncertainty.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { managedResumeFixture } from "./helpers/managed-resume-fixture.ts";
import { writeMcpFixture } from "./helpers/mcp-fixture.ts";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "managed-resume-"));
process.env.MISSION_HOME = home;
process.env.MISSION_CLAUDE_BIN = process.execPath;
process.env.MISSION_CODEX_BIN = process.execPath;
process.env.MISSION_PI_BIN = process.execPath;
await managedResumeFixture(home);
const { prepareTerminalResume, managedResumeRoot } = await import("../src/server/harness/resume.ts");
const { resumeContext } = await import("../src/server/resume-context.ts");
const { MISSION_MCP_TOOLS, verifyMissionMcpTools } = await import("../src/server/mission-mcp.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { claimResumeLease, completeResumeLease, createResumeLease, beginResumeLaunch, readResumeLease,
  resumeLeaseRoot, resumeLeaseStatus, revokeResumeLease, reconcileResumeLeases, RESUME_START_MS } = await import("../src/server/terminal/resume-lease.ts");
const { launchManagedAgentTerminal } = await import("../src/server/terminal/targets.ts");
const { spawnManagedResume } = await import("../src/server/dispatcher.ts");
const { TerminalLaunchError } = await import("../src/server/terminal/launch-error.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const session = (id: string) => mkSession({ id, runtime: "sdk", agentSessionId: id, cwd: home, terminals: [] });
const context = { managed: true, requiredTools: [], extraDirs: [] } as const;

test("Claude config is private, isolated and actually serves the required MCP protocol", async () => {
  process.env.MISSION_SESSION_ID = "stale-sdk";
  process.env.TMUX_PANE = "%unrelated";
  const attachedCheckout = join(home, "attached");
  const [a, b] = await Promise.all([
    prepareTerminalResume(session("one"), { ...context, extraDirs: [attachedCheckout] }),
    prepareTerminalResume(session("two"), context),
  ]);
  try {
    assert.notEqual(a.stateHome, b.stateHome);
    assert.deepEqual(a.requiredTools, [...MISSION_MCP_TOOLS]);
    const config = a.argv[a.argv.indexOf("--mcp-config") + 1]!;
    assert.ok(config.startsWith(a.stateHome + "/"));
    assert.equal(lstatSync(config).mode & 0o077, 0);
    const parsed = JSON.parse(readFileSync(config, "utf8")).mcpServers["mission-control"];
    assert.equal(parsed.env.MISSION_HOME, a.stateHome);
    assert.equal(parsed.env.MISSION_SESSION_ID, undefined);
    assert.equal(parsed.env.TMUX_PANE, undefined);
    assert.deepEqual(a.argv.flatMap((arg, index) => arg === "--allowed-tools" ? [a.argv[index + 1]] : []),
      [MISSION_MCP_TOOLS.map((tool) => `mcp__mission-control__${tool}`).join(",")]);
    assert.deepEqual(a.argv.flatMap((arg, index) => arg === "--add-dir" ? [a.argv[index + 1]] : []),
      [attachedCheckout]);
    assert.ok(!a.argv.includes("--append-system-prompt"));
    assert.ok(!a.argv.includes("--disallowed-tools"));
    // A new fixture path forces a fresh real handshake through the rendered registration.
    parsed.args = [writeMcpFixture(join(home, "rendered-roundtrip.mjs"), MISSION_MCP_TOOLS)];
    assert.deepEqual(await verifyMissionMcpTools(a.requiredTools, { ...parsed, serverName: "mission-control" }), { ok: true });
    assert.equal(JSON.parse(readFileSync(b.argv[b.argv.indexOf("--mcp-config") + 1]!, "utf8")).mcpServers["mission-control"].env.MISSION_HOME, b.stateHome);
  } finally {
    delete process.env.MISSION_SESSION_ID;
    delete process.env.TMUX_PANE;
    a.dispose(); b.dispose();
  }
});

test("Codex resumes retain each permission posture, exact scope and coupled hooks", async () => {
  const bridge = join(home, "codex-hook.mjs");
  writeFileSync(bridge, "");
  process.env.MISSION_CODEX_HOOK = bridge;
  try {
    for (const permissionMode of ["readOnly", "askForApproval", "approveForMe", "fullAccess"] as const) {
      const source = { ...session(`codex-${permissionMode}`), agent: "codex" as const, permissionMode };
      const prepared = await prepareTerminalResume(source, { ...context, extraDirs: ["/exact/attached-checkout"] });
      const grammar = HARNESSES.codex.resume!.argv(source.agentSessionId!, permissionMode);
      assert.deepEqual(prepared.argv.slice(1, grammar.length + 1), grammar);
      assert.ok(prepared.argv.includes('sandbox_workspace_write.writable_roots=["/exact/attached-checkout"]'));
      assert.equal(prepared.argv.filter((arg) => arg === "--sandbox").length, 1);
      assert.ok(prepared.argv.includes("--dangerously-bypass-hook-trust"));
      assert.ok(prepared.argv.some((arg) => arg.startsWith("hooks.")));
      assert.ok(prepared.argv.some((arg) => arg.startsWith("mcp_servers.")));
      assert.ok(!prepared.argv.includes("--model"));
      prepared.dispose();
    }
  } finally { delete process.env.MISSION_CODEX_HOOK; }
});

test("Pi uses its extension capability and refuses an unavailable installation", async () => {
  assert.deepEqual(HARNESSES.pi.resumeTools({ descriptor: null, stateHome: home, requiredTools: MISSION_MCP_TOOLS }),
    { args: [], instrumented: true });
  process.env.PI_EXTENSIONS_DIR = join(home, "missing-pi-extensions");
  try {
    await assert.rejects(prepareTerminalResume({ ...session("pi"), agent: "pi" }, context), /not installed/i);
    assert.equal(reconcileResumeLeases(managedResumeRoot()).filter((s) => s.state === "preparing").length, 0);
  } finally { delete process.env.PI_EXTENSIONS_DIR; }
});

test("Pi prepares a native resume through a verified installed extension", async () => {
  const { writePiIntegration } = await import("./helpers/pi-integration.ts");
  const previous = { ...process.env };
  const integration = join(home, "installed-pi-integration");
  const extensions = join(home, "installed-pi-extensions");
  writePiIntegration(integration);
  mkdirSync(extensions);
  symlinkSync(join(integration, "extension.js"), join(extensions, "mission-control.js"));
  process.env.PI_EXTENSIONS_DIR = extensions;
  process.env.MISSION_PI_EXTENSION = join(integration, "extension.js");
  // Probe the installed extension's own bridge, not the MCP-client fixture override.
  for (const prefix of ["MISSION", "FLEET", "HARNESS"]) delete process.env[`${prefix}_MCP_SERVER`];
  try {
    const nativeId = join(home, "pi-conversation.jsonl");
    const prepared = await prepareTerminalResume({ ...session(nativeId), agent: "pi" }, context);
    try {
      assert.deepEqual(prepared.argv, [process.execPath, "--session", nativeId]);
      assert.equal(prepared.descriptor, null, "Pi uses its installed extension instead of MCP-client registration");
      assert.equal(prepared.instrumented, true);
      assert.deepEqual(prepared.requiredTools, [...MISSION_MCP_TOOLS]);
      const launch = JSON.parse(readFileSync(join(prepared.stateHome, "launch.json"), "utf8"));
      assert.deepEqual(launch.argv, prepared.argv);
      assert.equal(launch.env.MISSION_HOME, prepared.stateHome);
      assert.equal(launch.env.MISSION_AGENT_SESSION_ID, nativeId);
    } finally { prepared.dispose(); }
  } finally { process.env = previous; }
});

test("requirements union live Persona and ensemble obligations with task kind and attached scopes", () => {
  const source = session("requirements");
  const task = mkTask({ kind: "plan", workflowId: null, worktreePath: home, extraRepos: [
    { repoRoot: "/repo-b", worktreePath: "/repo-b/exact-tree", branch: null,
      provider: null, worktreeLeaseId: null, baseSha: null, prUrl: null, prState: null, mergedAt: null },
  ] });
  const requirements = resumeContext(source, task, true, true);
  for (const tool of ["request_plan_decisions", "submit_workflow_evidence", "submit_ensemble_result"])
    assert.ok(requirements.requiredTools.includes(tool as typeof requirements.requiredTools[number]));
  assert.deepEqual(requirements.extraDirs, ["/repo-b/exact-tree"]);
  assert.deepEqual(resumeContext(source, null, true, false).requiredTools, ["submit_workflow_evidence"]);
  assert.ok(resumeContext(source, mkTask({ kind: "scout" }), false, false).requiredTools.includes("submit_scout_artifacts"));
});

test("missing tools and renderer exceptions revoke preparation without retaining secrets", async (t) => {
  const mcp = process.env.MISSION_MCP_SERVER;
  process.env.MISSION_MCP_SERVER = writeMcpFixture(join(home, "stale.mjs"), ["request_input"]);
  try { await assert.rejects(prepareTerminalResume(session("stale"), context), /does not publish/); }
  finally { process.env.MISSION_MCP_SERVER = mcp; }
  t.mock.method(HARNESSES.claude, "resumeTools", () => { throw new Error("invalid config path"); });
  await assert.rejects(prepareTerminalResume(session("invalid-config"), context), /invalid config path/);
  for (const status of reconcileResumeLeases(managedResumeRoot())) assert.equal(existsSync(status.lease.home), false);
});

test("an unusable guard fails before provisioning any lease", async () => {
  const prior = process.env.MISSION_RESUME_GUARD;
  process.env.MISSION_RESUME_GUARD = join(home, "invalid-guard.mjs");
  writeFileSync(process.env.MISSION_RESUME_GUARD, "process.exit(0);");
  try { await assert.rejects(prepareTerminalResume(session("bad-guard"), context), /guard is unusable/); }
  finally { process.env.MISSION_RESUME_GUARD = prior; }
});

test("selected 504 with no wrapper expires across restart and fences every late claim", async () => {
  const prepared = await prepareTerminalResume(session("never-launched"), context);
  // Provisioning/drain time does not consume the external launch budget.
  assert.equal(resumeLeaseStatus(prepared.lease).deadline, null);
  const response = await launchManagedAgentTerminal("ghostty", { name: "test", prepared },
    async () => ({ ok: false, label: "Ghostty", status: 504 }));
  assert.equal(response.status, 504);
  assert.ok(existsSync(prepared.stateHome));
  await assert.rejects(prepareTerminalResume(session("never-launched"), context), /No additional terminal/);
  const restored = readResumeLease(prepared.lease.root, prepared.lease.id);
  const deadline = resumeLeaseStatus(restored).deadline!;
  reconcileResumeLeases(restored.root, deadline + 1);
  assert.equal(existsSync(restored.home), false);
  assert.equal(claimResumeLease(restored, process.pid, Date.now(), deadline - 1), false);
  assert.equal(reconcileResumeLeases(restored.root, deadline + 10).find((s) => s.lease.id === restored.id)?.state, "revoked");
});

test("a claimed or ambiguous owner retains credentials indefinitely and prevents duplicate resumes", async () => {
  const prepared = await prepareTerminalResume(session("claimed"), context);
  prepared.beginLaunch();
  assert.equal(claimResumeLease(prepared.lease, 1234567, 100), true);
  assert.equal(prepared.dispose(), false);
  reconcileResumeLeases(prepared.lease.root, Date.now() + 100 * RESUME_START_MS);
  assert.ok(existsSync(prepared.stateHome), "PID absence, reuse, and unavailable inventory grant no cleanup authority");
  await assert.rejects(prepareTerminalResume(session("claimed"), context), /may still be using/);
  assert.throws(() => completeResumeLease(prepared.lease, 1234567, 101), /does not own/);
  completeResumeLease(prepared.lease, 1234567, 100);
  assert.equal(existsSync(prepared.stateHome), false);
});

test("definite refusal revokes an unused home but a conflicting wrapper claim becomes unknown", async () => {
  for (const claimed of [false, true]) {
    const p = await prepareTerminalResume(session(`refused-${claimed}`), context);
    const result = await launchManagedAgentTerminal("tmux", { name: "test", prepared: p }, async () => {
      if (claimed) assert.equal(claimResumeLease(p.lease, 22, 33), true);
      return { ok: false, label: "tmux", status: 502 };
    });
    assert.equal(result.status, claimed ? 504 : 502);
    assert.equal(existsSync(p.stateHome), claimed);
    if (claimed) completeResumeLease(p.lease, 22, 33);
  }
});

for (const path of ["default", "selected"] as const) {
  for (const outcome of ["success", "refused", "timeout", "exception", "claimed-refusal", "intent-failure"] as const) {
    test(`${path} managed launcher owns the prepared command and lease for ${outcome}`, async () => {
      const { fakeMultiplexer, fakeEmulator, fakeTerminals, muxPane, OK } = await import("./helpers/terminal-fakes.ts");
      const { PLAIN_NAMES } = await import("../src/server/terminal/names.ts");
      const prepared = await prepareTerminalResume(session(`${path}-${outcome}`), context);
      const seen: Array<{ argv: readonly string[]; cwd: string; state: string }> = [];
      let begins = 0;
      let disposals = 0;
      const begin = prepared.beginLaunch;
      const dispose = prepared.dispose;
      prepared.beginLaunch = () => {
        begins++;
        if (outcome === "intent-failure") throw new Error("fixture intent write failure");
        begin();
      };
      prepared.dispose = () => { disposals++; return dispose(); };
      const backend = async (command: { argv: readonly string[]; cwd: string }) => {
        seen.push({ argv: command.argv, cwd: command.cwd, state: resumeLeaseStatus(prepared.lease).state });
        if (outcome === "exception") throw new Error("fixture transport disconnected");
        if (outcome === "claimed-refusal") assert.equal(claimResumeLease(prepared.lease, 42, 52), true);
        return { ok: outcome === "success", status: outcome === "success" ? 200 : outcome === "timeout" ? 504 : 502,
          outcomeUnknown: outcome === "timeout", label: "tmux", error: "fixture terminal response" };
      };
      const deps = fakeTerminals(fakeMultiplexer({
        // Exercise one attempt under an already unique name, without real terminal I/O.
        list: async () => [muxPane({ sessionName: "managed" })],
        sessions: { spawnDetached: backend, attachArgv: () => [], rename: async () => OK,
          kill: async () => OK, alive: null, closeIfOnlyPane: null, names: PLAIN_NAMES },
      }), fakeEmulator());
      const launch = () => path === "default"
        ? spawnManagedResume({ name: "managed", shortId: "attempt", prepared }, deps).then(() => 200)
        : launchManagedAgentTerminal("tmux", { name: "managed", prepared }, (_backend, command) => backend(command)).then((result) => result.status);
      try {
        let status: number;
        try { status = await launch(); } catch (error) {
          assert.ok(error instanceof TerminalLaunchError);
          status = error.outcomeUnknown ? 504 : 502;
        }
        const refused = outcome === "refused" || outcome === "intent-failure";
        assert.equal(status, outcome === "success" ? 200 : refused ? 502 : 504);
        assert.equal(begins, 1, "the launcher records intent exactly once");
        assert.deepEqual(seen, outcome === "intent-failure" ? [] : [{
          argv: prepared.wrappedArgv, cwd: prepared.cwd, state: "pending",
        }], "backend I/O sees only the prepared command, after durable launch intent");
        assert.equal(disposals, refused || outcome === "claimed-refusal" ? 1 : 0);
        assert.equal(existsSync(prepared.stateHome), !refused);
        if (outcome === "success") {
          await assert.rejects(launch(), (error) => error instanceof TerminalLaunchError && error.outcomeUnknown);
          assert.equal(seen.length, 1, "a repeated managed launch cannot spawn again");
          assert.equal(disposals, 0, "a repeat cannot revoke the first pending launch");
          assert.ok(existsSync(prepared.stateHome));
        }
      } finally {
        if (outcome === "claimed-refusal") completeResumeLease(prepared.lease, 42, 52);
        else dispose();
      }
    });
  }
}

test("interrupted provisioning, revocation and deletion reconcile idempotently", () => {
  const preparing = new Set<string>();
  const lease = createResumeLease(managedResumeRoot(), "crashed-provisioning", preparing);
  writeFileSync(join(lease.home, "loopback-token"), "fixture-only");
  reconcileResumeLeases(lease.root); // New daemon has no in-flight provisioning set.
  assert.equal(existsSync(lease.home), false);
  reconcileResumeLeases(lease.root);
  mkdirSync(lease.home, { mode: 0o700 }); // Deletion interrupted after its durable revoke.
  writeFileSync(join(lease.home, "leftover"), "fixture");
  reconcileResumeLeases(lease.root);
  assert.equal(existsSync(lease.home), false);
});

for (const crash of [false, true]) test(`real wrapper ${crash ? "crash retains a surviving child" : "completion releases its home"}`, async () => {
  const nativeId = `real-wrapper-${crash}`;
  const p = await prepareTerminalResume(session(nativeId), context);
  const marker = join(home, `agent-started-${crash}.json`);
  const stop = join(home, `agent-stop-${crash}`);
  const script = join(home, "agent.mjs");
  writeFileSync(script, `import {writeFileSync,renameSync,existsSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker + ".tmp")},JSON.stringify({pid:process.pid,home:process.env.MISSION_HOME,native:process.env.MISSION_AGENT_SESSION_ID,sdk:process.env.MISSION_SESSION_ID}));
renameSync(${JSON.stringify(marker + ".tmp")},${JSON.stringify(marker)});
const t=setInterval(()=>{if(existsSync(${JSON.stringify(stop)}))clearInterval(t)},30);`);
  const configPath = join(p.stateHome, "launch.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  writeFileSync(configPath, JSON.stringify({ ...config, argv: [process.execPath, script] }));
  p.beginLaunch();
  // A terminal gives the command its own foreground process group. Do not share the test
  // runner's group, where unrelated parallel test subprocesses correctly prevent cleanup.
  const child = spawn(p.wrappedArgv[0]!, p.wrappedArgv.slice(1), { env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    for (let i = 0; i < 100 && !existsSync(marker) && child.exitCode === null; i++) await delay(50);
    assert.ok(existsSync(marker), stderr);
    const observed = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(observed.home, p.stateHome);
    assert.equal(observed.native, nativeId);
    assert.equal(observed.sdk, undefined);
    reconcileResumeLeases(p.lease.root, Date.now() + RESUME_START_MS * 100);
    assert.ok(existsSync(configPath));
    if (crash) {
      child.kill("SIGKILL");
      await exited;
      process.kill(observed.pid, 0);
      reconcileResumeLeases(p.lease.root, Date.now() + RESUME_START_MS * 100);
      assert.ok(existsSync(configPath), "a dead wrapper cannot authorize removal of its live child's credentials");
      writeFileSync(stop, "stop");
      for (let i = 0; i < 100; i++) {
        try { process.kill(observed.pid, 0); } catch { break; }
        await delay(50);
      }
      assert.ok(existsSync(configPath), "child absence alone is not a completion receipt");
      return;
    }
    writeFileSync(stop, "stop");
    assert.equal(await exited, 0, stderr);
    assert.equal(existsSync(p.stateHome), false, "normal wrapper completion releases its home");
  } finally {
    writeFileSync(stop, "stop");
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  }
});

test("symlinks, foreign locators and corrupt records cannot authorize deletion", () => {
  const state = join(home, "foreign-state"); mkdirSync(state);
  const root = resumeLeaseRoot(state);
  try {
    const lease = createResumeLease(root, "foreign", new Set());
    const outside = join(home, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "safe");
    assert.throws(() => revokeResumeLease({ ...lease, home: outside }), /foreign/);
    rmSync(lease.home, { recursive: true });
    symlinkSync(outside, lease.home);
    assert.throws(() => revokeResumeLease(lease), /unsafe/);
    assert.equal(readFileSync(join(outside, "keep"), "utf8"), "safe");
    writeFileSync(join(root, "leases", lease.id, "lease.json"), JSON.stringify({ ...lease, home: outside }));
    assert.throws(() => reconcileResumeLeases(root), /malformed/);
    assert.throws(() => readResumeLease(root, "../../outside"), /invalid/);
    assert.ok(existsSync(join(outside, "keep")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("claim versus revoke is exclusive across processes", async () => {
  const module = pathToFileURL(join(process.cwd(), "src/server/terminal/resume-lease.ts")).href;
  const contender = join(home, "contender.mjs");
  writeFileSync(contender, `import { readResumeLease, claimResumeLease, revokeResumeLease } from ${JSON.stringify(module)};
const [root,id,action]=process.argv.slice(2); const l=readResumeLease(root,id);
const won=action==='claim'?claimResumeLease(l,process.pid,123):revokeResumeLease(l);
process.stdout.write(String(won));`);
  for (let i = 0; i < 8; i++) {
    const lease = createResumeLease(managedResumeRoot(), `race-${i}`, new Set());
    beginResumeLaunch(lease);
    const run = (action: string) => childOutput(process.execPath, ["--import", "tsx", contender, lease.root, lease.id, action]);
    const [claim, revoke] = await Promise.all([run("claim"), run("revoke")]);
    assert.equal(Number(claim.stdout === "true") + Number(revoke.stdout === "true"), 1);
    const status = resumeLeaseStatus(lease);
    if (status.state === "claimed") {
      assert.ok(existsSync(lease.home));
      completeResumeLease(lease, status.owner!.pid, status.owner!.startMs);
    } else assert.equal(existsSync(lease.home), false);
  }
});

async function childOutput(bin: string, args: string[]) {
  const child = spawn(bin, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
  assert.equal(code, 0, stderr);
  return { stdout, stderr };
}
