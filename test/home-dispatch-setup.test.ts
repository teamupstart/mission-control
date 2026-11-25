// P14: installation must be repeatable, diagnose failure without editing settings, and never run a model.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { detectClaude } from "../src/cli/claude-cli.ts";
import { runCli } from "../src/cli/index.ts";
import { runSetup } from "../src/cli/commands/setup.ts";
import { doctorChecks } from "../src/cli/setup-checks.ts";
import { createSetupContext, MOD_ID, type SetupContext } from "../src/cli/setup-context.ts";
import { readClientToken, stateDir } from "../src/shared/harness-runtime.mjs";
import { stageMod } from "../src/server/mod-stage.ts";
import { createFakeClaude, createFakeDaemon } from "./helpers/home-dispatch-fakes.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mission-p14-"));
  const fake = createFakeClaude({ stagedVersion: "2.3.0" });
  t.after(async () => { fake.cleanup(); await rm(root, { recursive: true, force: true }); });
  const buildRoot = join(root, "build");
  const stateHome = join(root, "state");
  const files: Record<string, string> = {
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "mission-control", plugins: [{ name: "mission-control", source: "./mission-control", version: "2.3.0" }] }),
    "mission-control/.claude-plugin/plugin.json": JSON.stringify({ name: "mission-control", version: "2.3.0", modApi: 1 }),
    "mission-control/hooks/register.js": 'const health = "/api/health"; const inbox = "/dispatch/inbox";',
    "mission-control/allowed-calls.json": await readFile(new URL("../src/mod/allowed-calls.json", import.meta.url), "utf8"),
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(buildRoot, file)), { recursive: true });
    await writeFile(join(buildRoot, file), text);
  }
  const env = { ...process.env, MISSION_CLAUDE_BIN: fake.path };
  const output: string[] = [];
  let enabled = false;
  const requests: { path: string; body: unknown }[] = [];
  const context: SetupContext = {
    io: { stdout: (s) => output.push(s), stderr: (s) => output.push(s), env, cwd: root, stdinIsTty: false },
    stateHome, buildRoot, mode: "setup", off: false,
    detectClaude: () => detectClaude(env, root),
    request: async (path, body) => {
      requests.push({ path, body });
      if (path === "/api/health") return { service: "mission-control", capabilities: enabled ? ["home-dispatch-v1"] : [] };
      if (path === "/api/feature-flags") {
        if (body !== undefined) enabled = (body as { enabled: boolean }).enabled;
        return { config: { enableAll: false, overrides: { "headless-mode": enabled, "task-shaping": false } } };
      }
      throw new Error("unexpected route " + path);
    },
  };
  return { root, context, fake, output, requests };
}

test("finds the override before PATH, PATH before known locations, and validates marketplace support", async (t) => {
  const f = await fixture(t);
  const second = createFakeClaude();
  t.after(second.cleanup);
  const env = { HOME: f.root, PATH: `${second.dir}:${process.env.PATH}`, MISSION_CLAUDE_BIN: f.fake.path };
  assert.equal((await detectClaude(env, f.root))?.path, f.fake.path);
  assert.equal(second.invocations().length, 0);
  delete (env as Partial<typeof env>).MISSION_CLAUDE_BIN;
  assert.equal((await detectClaude(env, f.root))?.path, second.path);
  const home = join(f.root, "native-home");
  await mkdir(join(home, ".local/bin"), { recursive: true });
  // The fake uses __dirname for its state, so a symlink preserves its own fixture state.
  await symlink(f.fake.path, join(home, ".local/bin/claude"));
  const detected = await detectClaude({ HOME: home, PATH: dirname(process.execPath) }, f.root);
  assert.equal(detected?.path, join(home, ".local/bin/claude"));
  await mkdir(join(home, ".claude/local"), { recursive: true });
  await symlink(second.path, join(home, ".claude/local/claude"));
  assert.equal((await detectClaude({ HOME: home, PATH: dirname(process.execPath) }, f.root))?.path, join(home, ".claude/local/claude"));
  f.fake.update({ marketplaceSupported: false });
  assert.equal(await detectClaude({ ...env, MISSION_CLAUDE_BIN: f.fake.path }, f.root), null);
  assert.equal(await detectClaude({ ...env, MISSION_CLAUDE_BIN: join(f.root, "missing") }, f.root), null);
  assert.deepEqual(f.fake.launches(), []);
});

test("staging replaces by rename, preserves readers of the previous inode, and changes no bytes on rerun", async (t) => {
  const f = await fixture(t);
  const first = await stageMod(f.context.buildRoot, f.context.stateHome);
  assert.equal(first.changed, true);
  assert.equal(first.version, "2.3.0");
  const target = join(first.root, "mission-control/hooks/register.js");
  const before = await stat(target);
  assert.deepEqual(await stageMod(f.context.buildRoot, f.context.stateHome), { root: first.root, version: "2.3.0", changed: false });
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  const { open } = await import("node:fs/promises");
  const reader = await open(target);
  try {
    const old = await readFile(target, "utf8");
    await writeFile(join(f.context.buildRoot, "mission-control/hooks/register.js"), 'const changed = "/api/health";');
    assert.equal((await stageMod(f.context.buildRoot, f.context.stateHome)).changed, true);
    assert.equal(await reader.readFile("utf8"), old);
    assert.notEqual((await stat(target)).ino, before.ino);
  } finally { await reader.close(); }
  await symlink(f.root, join(f.context.buildRoot, "escape"));
  await assert.rejects(stageMod(f.context.buildRoot, f.context.stateHome), /symlink/);
  assert.equal(await readFile(target, "utf8"), 'const changed = "/api/health";');
});

test("Claude discovery accepts a frozen environment without changing caller or process PATH", async (t) => {
  const f = await fixture(t);
  const originalPath = process.env.PATH;
  for (const frozen of [false, true]) {
    const env = { HOME: f.root, PATH: dirname(process.execPath), MISSION_CLAUDE_BIN: f.fake.path };
    const before = { ...env };
    assert.equal((await detectClaude(frozen ? Object.freeze(env) : env, f.root))?.path, f.fake.path);
    assert.deepEqual(env, before);
    assert.equal(process.env.PATH, originalPath);
  }
});

test("an explicit home selects setup state and credentials without inheriting the process home", async (t) => {
  const f = await fixture(t);
  const env = { [process.platform === "win32" ? "USERPROFILE" : "HOME"]: f.root };
  assert.equal(stateDir(env), join(f.root, ".mission-control"));
  assert.equal(createSetupContext({ ...f.context.io, env }, "doctor").stateHome, join(f.root, ".mission-control"));
  const legacy = join(f.root, ".fleet-control");
  await mkdir(legacy);
  await writeFile(join(legacy, "token"), "caller-home-token\n");
  assert.equal(stateDir(env), legacy);
  assert.equal(readClientToken(env), "caller-home-token");
  const current = join(f.root, ".mission-control");
  await mkdir(current);
  await writeFile(join(current, "token"), "current-home-token\n");
  assert.equal(stateDir(env), current);
  assert.equal(readClientToken(env), "current-home-token");
  assert.equal(stateDir({ ...env, MISSION_HOME: f.context.stateHome }), f.context.stateHome);
});

test("setup installs once at a stable path and doctor is read-only; off touches only the flag", async (t) => {
  const f = await fixture(t);
  const settings = join(f.root, "settings.json");
  const planted = '{"disableAllHooks":true,"unrelated":"keep"}\n';
  await writeFile(settings, planted);
  assert.equal(await runSetup(f.context), 0, f.output.join(""));
  assert.match(f.output.join(""), /agents: step not available/);
  assert.match(f.output.join(""), /codex: step not available/);
  assert.deepEqual(f.fake.state().marketplaces, [join(f.context.stateHome, "mod")]);
  assert.equal(f.fake.state().plugins[0]?.scope, "user");
  const writes = () => f.fake.invocations().filter((i) => (["install", "uninstall", "enable"].includes(i.argv[1] ?? "") || i.argv[1] === "marketplace" && i.argv[2] === "add"));
  const initialWrites = writes().length;
  const flagWrites = f.requests.filter((r) => r.body !== undefined).length;
  const target = join(f.context.stateHome, "mod/mission-control/hooks/register.js");
  const initialStat = await stat(target);
  assert.equal(await runSetup(f.context), 0, f.output.join(""));
  assert.equal(writes().length, initialWrites);
  assert.equal(f.requests.filter((r) => r.body !== undefined).length, flagWrites);
  assert.equal((await stat(target)).mtimeMs, initialStat.mtimeMs);
  const checks = await doctorChecks({ ...f.context, mode: "doctor" });
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  assert.equal(writes().length, initialWrites);
  assert.equal(await readFile(settings, "utf8"), planted);
  const invocations = f.fake.invocations().length;
  assert.equal(await runSetup({ ...f.context, off: true }), 0);
  assert.equal(f.fake.invocations().length, invocations);
  assert.equal(f.fake.state().plugins[0]?.enabled, true);
  assert.equal((await doctorChecks(f.context)).find((c) => c.id === "flag")?.ok, false);
  assert.deepEqual(f.fake.launches(), []);
});

test("doctor refuses an enabled plugin with load errors without changing its installation", async (t) => {
  const f = await fixture(t);
  assert.equal(await runSetup(f.context), 0);
  f.fake.update({ plugins: [{ id: MOD_ID, version: "2.3.0", enabled: true, scope: "user", errors: ["hook module failed to load"] }] });
  const before = f.fake.state();
  const checks = await doctorChecks(f.context);
  const enabled = checks.find((check) => check.id === "mod-enabled")!;
  assert.equal(enabled.ok, false);
  assert.match(enabled.message, /hook module failed to load/);
  assert.deepEqual(f.fake.state(), before);
  assert.equal(await runSetup(f.context), 1, "setup's final doctor report must also fail");
  f.fake.update({ plugins: [{ ...before.plugins[0]!, enabled: false }] });
  const disabled = (await doctorChecks(f.context)).find((check) => check.id === "mod-enabled")!;
  assert.equal(disabled.ok, false);
  assert.match(disabled.message, /missing or disabled at user scope/);
  f.fake.update({ plugins: [{ ...before.plugins[0]!, errors: [] }] });
  assert.equal((await doctorChecks(f.context)).find((check) => check.id === "mod-enabled")!.ok, true);
});

test("staging rejects mismatched snapshot versions before replacing a working stage", async (t) => {
  const f = await fixture(t);
  const staged = await stageMod(f.context.buildRoot, f.context.stateHome);
  const manifestPath = "mission-control/.claude-plugin/plugin.json";
  const published = await readFile(join(staged.root, manifestPath), "utf8");
  await writeFile(join(f.context.buildRoot, manifestPath), published.replace("2.3.0", "2.4.0"));
  await assert.rejects(stageMod(f.context.buildRoot, f.context.stateHome), /versions differ/);
  assert.equal(await readFile(join(staged.root, manifestPath), "utf8"), published);
  await assert.rejects(stat(join(f.context.stateHome, ".mod-stage-lock")), { code: "ENOENT" });
});

test("staging never returns metadata from an earlier build than the published snapshot", async (t) => {
  const f = await fixture(t);
  const marketplacePath = join(f.context.buildRoot, ".claude-plugin/marketplace.json");
  const manifestPath = join(f.context.buildRoot, "mission-control/.claude-plugin/plugin.json");
  const originalRead = fsPromises.readFile;
  let rebuilt = false;
  t.mock.method(fsPromises, "readFile", async (...args: Parameters<typeof originalRead>) => {
    const bytes = await originalRead(...args);
    if (args[0] === marketplacePath && !rebuilt) {
      rebuilt = true;
      // A build publishes after the metadata read, before the remaining staging reads.
      for (const path of [marketplacePath, manifestPath]) {
        const source = await originalRead(path, "utf8");
        await writeFile(path, source.replaceAll("2.3.0", "2.4.0"));
      }
    }
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let staged: Awaited<ReturnType<typeof stageMod>>;
  try { staged = await stageMod(f.context.buildRoot, f.context.stateHome); }
  catch (error) {
    assert.match(String(error), /changed during staging/);
    return;
  }
  assert.equal(rebuilt, true);
  const manifest = JSON.parse(await originalRead(join(staged.root, "mission-control/.claude-plugin/plugin.json"), "utf8"));
  assert.equal(staged.version, manifest.version);
});

test("setup refuses a checkout or symlink into it as the persisted marketplace destination", async (t) => {
  const f = await fixture(t);
  const checkout = join(f.root, "checkout");
  await mkdir(checkout);
  await writeFile(join(checkout, ".git"), "gitdir: /some/pooled/metadata\n");
  const alias = join(f.root, "alias");
  await symlink(checkout, alias);
  for (const base of [checkout, alias]) {
    await assert.rejects(stageMod(f.context.buildRoot, join(base, "operator-state")), /outside the checkout/);
  }
  assert.deepEqual(f.fake.state().marketplaces, []);
});

test("stale installs are uninstalled and reinstalled at user scope; disabled installs are enabled", async (t) => {
  const f = await fixture(t);
  f.fake.setInstalledVersion("1.0.0");
  await stageMod(f.context.buildRoot, f.context.stateHome);
  assert.equal((await doctorChecks(f.context)).find((c) => c.id === "mod-current")?.ok, false);
  assert.equal(await runSetup(f.context), 0, f.output.join(""));
  const commands = f.fake.invocations().map((i) => i.argv);
  assert.ok(commands.some((argv) => argv.join(" ") === `plugin uninstall ${MOD_ID} --scope user`));
  assert.ok(commands.some((argv) => argv.join(" ") === `plugin install ${MOD_ID} --scope user`));
  assert.ok(commands.every((argv) => !argv.includes("update")));
  f.fake.update({ plugins: [{ id: MOD_ID, version: "2.3.0", enabled: false, scope: "user" }] });
  assert.equal(await runSetup(f.context), 0);
  assert.equal(f.fake.state().plugins[0]?.enabled, true);
});

test("reinstall retries once; double failure prints recovery, finishes the report and exits 1", async (t) => {
  const f = await fixture(t);
  f.fake.setInstalledVersion("1.0.0");
  f.fake.update({ failures: { install: { exitCode: 1, stderr: "installation refused", times: 2 } } });
  assert.equal(await runSetup(f.context), 1);
  assert.equal(f.fake.invocations().filter((i) => i.argv[1] === "install").length, 2);
  assert.equal(f.fake.state().plugins.length, 0);
  const output = f.output.join("");
  assert.match(output, /installation refused/);
  assert.ok(output.includes(`claude plugin marketplace add '${join(f.context.stateHome, "mod")}'`));
  assert.ok(output.includes(`claude plugin install ${MOD_ID} --scope user`));
  assert.match(output, /FAIL mod-enabled/);
  assert.match(output, /agents: step not available/);
  assert.equal(await runSetup(f.context), 0, f.output.join(""));
  assert.deepEqual(f.fake.launches(), []);
});

test("a single failed install recovers on retry and a foreign marketplace is refused", async (t) => {
  const f = await fixture(t);
  f.fake.setInstalledVersion("1.0.0");
  f.fake.update({ failures: { install: { exitCode: 1, stderr: "temporary install failure" } } });
  assert.equal(await runSetup(f.context), 0, f.output.join(""));
  assert.equal(f.fake.invocations().filter((i) => i.argv[1] === "install").length, 2);
  f.fake.update({ marketplaces: [join(f.root, "pooled-checkout/mod")] });
  const before = f.fake.invocations().filter((i) => i.argv[1] === "uninstall").length;
  assert.equal(await runSetup(f.context), 1);
  assert.equal(f.fake.invocations().filter((i) => i.argv[1] === "uninstall").length, before);
  assert.match(f.output.join(""), /marketplace points elsewhere/);
  assert.equal((await doctorChecks(f.context)).find((c) => c.id === "mod-current")?.ok, false);
});

test("doctor names missing Claude, daemon failures and disallowed calls without writes", async (t) => {
  const f = await fixture(t);
  assert.equal(await runSetup(f.context), 0);
  await writeFile(join(f.context.stateHome, "mod/mission-control/hooks/register.js"), 'fetch("/api/sessions");');
  const checks = await doctorChecks(f.context);
  assert.equal(checks.find((c) => c.id === "mod-calls")?.ok, false);
  const missing = await doctorChecks({ ...f.context, detectClaude: async () => null, request: async () => { throw new Error("daemon down"); } });
  assert.deepEqual(missing.filter((c) => !c.ok).map((c) => c.id), ["daemon", "flag", "home-dispatch-v1", "claude", "mod-enabled", "mod-current", "mod-calls"]);
  assert.match(missing[0]!.message, /Open the Mission Control app/);
  f.fake.update({ plugins: [{ id: MOD_ID, version: "2.3.0", scope: "project", enabled: true }] });
  assert.equal((await doctorChecks(f.context)).find((c) => c.id === "mod-enabled")?.ok, false);
  for (const args of [["setup", "--service"], ["doctor", "--live"], ["setup", "--anything"]]) {
    assert.equal(await runCli(args, f.context.io), 2);
  }
});

test("missing Claude skips installation, finishes every check and exits 1", async (t) => {
  const f = await fixture(t);
  const context = { ...f.context, detectClaude: async () => null };
  assert.equal(await runSetup(context), 1);
  assert.match(f.output.join(""), /claude CLI not found: install Claude Code/);
  assert.match(f.output.join(""), /FAIL mod-enabled/);
  assert.deepEqual(f.fake.invocations(), []);
  const checks = await doctorChecks({ ...context, detectClaude: async () => { throw new Error("detection unavailable"); } });
  assert.equal(checks.length, 7);
  assert.match(checks.find((c) => c.id === "claude")!.message, /detection unavailable/);
});

test("the built CLI uses authenticated HTTP, reports exit codes, and never rewrites planted settings", async (t) => {
  const f = await fixture(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const { cp } = await import("node:fs/promises");
  const dist = join(f.root, "dist");
  await mkdir(join(dist, "cli"), { recursive: true });
  await cp(f.context.buildRoot, join(dist, "mod"), { recursive: true });
  const bundle = join(dist, "cli/mctl.mjs");
  await execute("npm", ["run", "build:cli", "--", `--outfile=${bundle}`], { cwd: process.cwd() });
  let enabled = false;
  const flags = () => ({ config: { enableAll: false, overrides: { "headless-mode": enabled } } });
  const token = "p14-fixture-token";
  const daemon = createFakeDaemon({ flag: false, routes: {
    "GET /api/feature-flags": (request) => request.headers["x-harness-token"] === token ? { body: flags() } : { status: 401 },
    "PUT /api/feature-flags": (request) => {
      if (request.headers["x-harness-token"] !== token) return { status: 401 };
      const body = request.body as { kind: string; id: string; enabled: boolean };
      assert.equal(body.kind, "flag");
      assert.equal(body.id, "headless-mode");
      enabled = body.enabled;
      daemon.setFlag(enabled);
      return { body: flags() };
    },
  } });
  const address = await daemon.listen();
  t.after(() => daemon.close());
  await mkdir(f.context.stateHome, { recursive: true });
  await writeFile(join(f.context.stateHome, "token"), token, { mode: 0o600 });
  const plantedFiles = [".claude/settings.json", ".claude/settings.local.json", "project/.claude/settings.json", "managed/managed-settings.json"];
  const contents = '{"disableAllHooks":true,"unrelated":"keep"}\n';
  for (const path of plantedFiles) {
    await mkdir(dirname(join(f.root, path)), { recursive: true });
    await writeFile(join(f.root, path), contents);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, MISSION_HOME: f.context.stateHome, MISSION_PORT: new URL(address.url).port, MISSION_CLAUDE_BIN: f.fake.path };
  delete env.MISSION_API_TOKEN;
  delete env.MISSION_API_TOKEN_FILE;
  const run = async (...args: string[]) => {
    try {
      const result = await execute(process.execPath, [bundle, ...args], { env, cwd: f.root });
      return { code: 0, ...result };
    } catch (error) {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  };
  assert.equal((await run("doctor")).code, 1);
  const setup = await run("setup");
  assert.equal(setup.code, 0, setup.stdout + setup.stderr);
  const doctor = await run("doctor");
  assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /ok mod-current: Installed and staged version 2.3.0/);
  // The in-process API uses CliIo.env too, without replacing the worker's process environment.
  const operatorHome = process.env.MISSION_HOME;
  assert.equal(await runCli(["doctor"], { ...f.context.io, env }), 0);
  assert.equal(process.env.MISSION_HOME, operatorHome);
  await writeFile(join(f.context.stateHome, "token"), "wrong-token");
  const unauthorized = await run("doctor");
  assert.equal(unauthorized.code, 1);
  assert.match(unauthorized.stdout, /HTTP 401/);
  for (const path of plantedFiles) assert.equal(await readFile(join(f.root, path), "utf8"), contents);
  assert.deepEqual(f.fake.launches(), []);
});
