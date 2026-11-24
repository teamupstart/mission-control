// Headless mode phase 14: `mctl setup` and `mctl doctor` against a fake `claude`, a fake daemon and
// a temporary state directory. No model tokens, no real Claude Code, no real state home.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cp, rename } from "node:fs/promises";
import { findClaude, realExec } from "../src/cli/claude-cli.ts";
import { runCli } from "../src/cli/index.ts";
import type { CliIo } from "../src/cli/commands/index.ts";
import { calledPaths, recoveryCommands, shellArg } from "../src/cli/setup-steps/checks.ts";
import { run as runDoctorStep } from "../src/cli/setup-steps/doctor.ts";
import { run as runModStep } from "../src/cli/setup-steps/mod.ts";
import { stageMod } from "../src/server/mod-stage.ts";
import { createFakeClaude, createFakeDaemon, type FakeClaude, type FakeDaemon } from "./helpers/home-dispatch-fakes.ts";

const MOD_ID = "mission-control@mission-control";

/** A mod build with the layout `npm run build:mod` writes, at a chosen version. */
function writeModBuild(root: string, version: string, bundle = 'fetch("/api/health"); fetch("/dispatch/inbox");', record = true): void {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "mission-control", ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "mission-control", "hooks"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), "{}");
  writeFileSync(join(root, "mission-control", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "mission-control", version }));
  writeFileSync(join(root, "mission-control", "hooks", "register.js"), bundle);
  // What `build:mod` records once its source-aware mod-calls check has passed this bundle.
  if (!record) rmSync(join(root, "mission-control", "hooks", "mod-calls.json"), { force: true });
  else {
    writeFileSync(join(root, "mission-control", "hooks", "mod-calls.json"), JSON.stringify({ checked: true, bundleSha256: createHash("sha256").update(bundle).digest("hex") }));
  }
}

interface Rig {
  home: string;
  state: string;
  source: string;
  claude: FakeClaude;
  daemon: FakeDaemon;
  env: Record<string, string>;
  run: (...argv: string[]) => Promise<{ code: number; out: string; err: string }>;
  cleanup: () => Promise<void>;
}

async function rig(options: { version?: string; flag?: boolean } = {}): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), "mission-setup-"));
  const state = join(home, "state");
  const source = join(home, "built-mod");
  mkdirSync(state, { recursive: true });
  const version = options.version ?? "2.2.0";
  writeModBuild(source, version);
  const claude = createFakeClaude({ stagedVersion: version });
  const daemon = createFakeDaemon({ flag: options.flag ?? true });
  const { port } = await daemon.listen();
  const env: Record<string, string> = {
    HOME: home,
    PATH: "",
    MISSION_HOME: state,
    MISSION_PORT: String(port),
    MISSION_CLAUDE_BIN: claude.path,
    MISSION_MOD_SOURCE: source,
  };
  return {
    home, state, source, claude, daemon, env,
    run: async (...argv) => {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env, cwd: home, stdinIsTty: false };
      const code = await runCli(argv, io);
      return { code, out: out.join(""), err: err.join("") };
    },
    cleanup: async () => {
      await daemon.close();
      claude.cleanup();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The `claude plugin ...` subcommands the fake saw, as `install`, `marketplace add` and so on. */
function pluginCalls(claude: FakeClaude): string[] {
  return claude.invocations().filter((i) => i.argv[0] === "plugin").map((i) => (i.argv[1] === "marketplace" ? "marketplace add" : i.argv[1]!));
}

test("claude detection tries MISSION_CLAUDE_BIN, then PATH, then known places, and accepts only a claude with marketplaces", async () => {
  const viaEnv = createFakeClaude({ version: "2.1.400" });
  const viaPath = createFakeClaude({ version: "2.1.329" });
  const old = createFakeClaude({ marketplaceSupported: false });
  const home = mkdtempSync(join(tmpdir(), "mission-detect-"));
  try {
    const exec = realExec;
    // The explicit override wins over PATH.
    const first = await findClaude({ env: { MISSION_CLAUDE_BIN: viaEnv.path, PATH: viaPath.dir }, exec });
    assert.equal(first.claude?.path, viaEnv.path);
    assert.equal(first.claude?.source, "MISSION_CLAUDE_BIN");
    assert.equal(first.claude?.version, "2.1.400");

    // Without the override, PATH is searched.
    const second = await findClaude({ env: { PATH: viaPath.dir, HOME: home }, exec });
    assert.equal(second.claude?.path, viaPath.path);
    assert.equal(second.claude?.source, "PATH");

    // A bad override is reported, never silently replaced by what is on PATH.
    const bad = await findClaude({ env: { MISSION_CLAUDE_BIN: join(home, "missing"), PATH: viaPath.dir }, exec });
    assert.equal(bad.claude, null);
    assert.match(bad.rejected.join(" "), /missing/);

    // A claude without `plugin marketplace` is refused with the reason, and the search goes on.
    const skipOld = await findClaude({ env: { PATH: [old.dir, viaPath.dir].join(":"), HOME: home }, exec });
    assert.equal(skipOld.claude?.path, viaPath.path);
    assert.match(skipOld.rejected.join(" "), /no `plugin marketplace`/);

    // A known place under HOME is the last resort.
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const known = join(home, ".local", "bin", "claude");
    writeFileSync(known, readFileSync(viaEnv.path));
    chmodSync(known, 0o755);
    // The copy reads its state beside itself, so give it its own.
    writeFileSync(join(home, ".local", "bin", "state.json"), readFileSync(join(viaEnv.dir, "state.json")));
    writeFileSync(join(home, ".local", "bin", "invocations.jsonl"), "");
    const third = await findClaude({ env: { PATH: "", HOME: home }, exec });
    assert.equal(third.claude?.path, known);
    assert.equal(third.claude?.source, "known place");

    const none = await findClaude({ env: { PATH: old.dir, HOME: mkdtempSync(join(tmpdir(), "mission-empty-")) }, exec });
    assert.equal(none.claude, null);
  } finally {
    for (const fake of [viaEnv, viaPath, old]) fake.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("staging publishes by rename: a new inode, no sibling left, and a bad build leaves the old one in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-stage-"));
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "1.0.0");
    const first = await stageMod({ source, dest });
    assert.equal(first.version, "1.0.0");
    const inodeBefore = statSync(dest).ino;
    const fileBefore = statSync(join(dest, "mission-control", "hooks", "register.js")).ino;

    writeModBuild(source, "1.1.0", 'fetch("/api/health");');
    const second = await stageMod({ source, dest });
    assert.equal(second.version, "1.1.0");
    assert.notEqual(statSync(dest).ino, inodeBefore, "the published folder is a new inode, never rewritten in place");
    assert.notEqual(statSync(join(dest, "mission-control", "hooks", "register.js")).ino, fileBefore);
    assert.deepEqual(readdirSync(join(dir, "state")), ["mod"], "no staging or old sibling is left behind");

    rmSync(join(source, "mission-control", "hooks", "register.js"));
    await assert.rejects(stageMod({ source, dest }), /not a mod build/);
    assert.equal(JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "1.1.0");
    assert.deepEqual(readdirSync(join(dir, "state")), ["mod"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup on a clean machine stages and installs the mod, runs the other steps, and skips the stubs", async () => {
  const r = await rig();
  try {
    const result = await r.run("setup");
    assert.equal(result.code, 0, result.out + result.err);
    assert.deepEqual(pluginCalls(r.claude).filter((c) => c !== "list" && c !== "validate" && c !== "--help"), ["marketplace add", "install"]);
    assert.deepEqual(r.claude.state().marketplaces, [join(r.state, "mod")]);
    assert.deepEqual(r.claude.state().plugins.map((p) => [p.id, p.scope, p.enabled, p.version]), [[MOD_ID, "user", true, "2.2.0"]]);
    assert.ok(existsSync(join(r.state, "mod", "mission-control", ".claude-plugin", "plugin.json")));
    assert.match(result.out, /ok {4}mod: installed the mod 2\.2\.0 at user scope/);
    assert.match(result.out, /- agents: step not available in this build/);
    assert.match(result.out, /- codex: step not available in this build/);
    assert.match(result.out, /ok {4}doctor: all 6 checks passed/);
    assert.deepEqual(readdirSync(r.state), ["mod"]);
  } finally {
    await r.cleanup();
  }
});

test("a second setup is idempotent: nothing is installed again", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    const before = pluginCalls(r.claude).length;
    const again = await r.run("setup");
    assert.equal(again.code, 0, again.out + again.err);
    assert.match(again.out, /the mod 2\.2\.0 is already installed/);
    const added = pluginCalls(r.claude).slice(before);
    assert.ok(!added.includes("install") && !added.includes("uninstall") && !added.includes("marketplace add"), added.join(","));
  } finally {
    await r.cleanup();
  }
});

test("a stale installed build is reinstalled by uninstall and install, never `plugin update`", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    r.claude.setInstalledVersion("2.1.0");
    const result = await r.run("setup");
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /replaced 2\.1\.0 with the mod 2\.3\.0/);
    const calls = pluginCalls(r.claude);
    assert.ok(calls.indexOf("uninstall") < calls.indexOf("install"));
    assert.ok(!calls.includes("update"));
    assert.equal(r.claude.state().plugins[0]?.version, "2.3.0");
  } finally {
    await r.cleanup();
  }
});

test("a reinstall that fails twice prints the cause and both recovery commands, still runs the other steps, and exits 1", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    r.claude.setInstalledVersion("2.1.0");
    r.claude.update({ failures: { install: { exitCode: 1, stderr: "marketplace unreachable", times: 5 } } });
    const result = await r.run("setup");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}mod: `claude plugin install` failed: marketplace unreachable/);
    assert.ok(result.out.includes("claude plugin marketplace add " + join(r.state, "mod")));
    assert.ok(result.out.includes("claude plugin install " + MOD_ID + " --scope user"));
    // The steps after the failed one still ran.
    assert.match(result.out, /- codex: step not available in this build/);
    assert.match(result.out, /FAIL {2}doctor: /);
    assert.match(result.err, /1 step failed|2 steps failed/);
  } finally {
    await r.cleanup();
  }
});

test("setup with no claude installs nothing, finishes the other steps and exits 1", async () => {
  const r = await rig();
  try {
    r.env.MISSION_CLAUDE_BIN = join(r.home, "no-such-claude");
    const result = await r.run("setup");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}mod: the claude CLI was not found/);
    assert.match(result.out, /ok {4}daemon: /);
    assert.equal(existsSync(join(r.state, "mod")), false, "nothing is staged without a claude to install it");
  } finally {
    await r.cleanup();
  }
});

test("doctor passes on an installed machine and changes nothing", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    const calls = r.claude.invocations().length;
    const files = readdirSync(r.state);
    const result = await r.run("doctor");
    assert.equal(result.code, 0, result.out + result.err);
    for (const name of ["claude", "daemon", "flag", "mod-enabled", "mod-current", "mod-calls"]) assert.match(result.out, new RegExp("ok {4}" + name + ": "));
    const added = r.claude.invocations().slice(calls).filter((i) => i.argv[0] === "plugin").map((i) => i.argv[1]);
    assert.ok(added.every((c) => c === "list" || c === "validate" || c === "--help"), added.join(","));
    assert.deepEqual(readdirSync(r.state), files);
  } finally {
    await r.cleanup();
  }
});

test("doctor names each failing check with its fix and exits 1", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    // Nothing installed yet: mod-enabled and mod-current cannot pass; the daemon is reachable.
    const fresh = await r.run("doctor");
    assert.equal(fresh.code, 1);
    assert.match(fresh.out, /FAIL {2}mod-enabled: mission-control@mission-control is not installed\n {8}fix: Run `mctl setup`/);
    assert.match(fresh.out, /FAIL {2}mod-calls: no mod bundle/);

    assert.equal((await r.run("setup")).code, 0);

    // Stale: the staged build moved on.
    r.claude.setInstalledVersion("2.1.0");
    const stale = await r.run("doctor");
    assert.equal(stale.code, 1);
    assert.match(stale.out, /FAIL {2}mod-current: the installed mod is 2\.1\.0 but the staged build is 2\.3\.0/);
    assert.match(stale.out, /fix: Run `mctl setup`, or by hand: claude plugin marketplace add /);

    // Disabled.
    r.claude.update({ plugins: [{ id: MOD_ID, version: "2.3.0", scope: "user", enabled: false }] });
    assert.match((await r.run("doctor")).out, /FAIL {2}mod-enabled: .* disabled at user scope/);

    // Flag off: the daemon is up but does not advertise the routes.
    r.claude.setInstalledVersion("2.3.0");
    r.daemon.setFlag(false);
    const off = await r.run("doctor");
    assert.equal(off.code, 1);
    assert.match(off.out, /ok {4}daemon: /);
    assert.match(off.out, /FAIL {2}flag: the headless-mode preview flag is off/);

    // Daemon down.
    r.daemon.setDown(true);
    const down = await r.run("doctor");
    assert.match(down.out, /FAIL {2}daemon: no Mission Control daemon answered/);
    assert.match(down.out, /FAIL {2}flag: the flag cannot be read/);
  } finally {
    await r.cleanup();
  }
});

/** Replaces the staged mod's bundle and its build-time record, as a hand edit or an older build would. */
function restage(r: Rig, bundle: string, record: boolean | "other"): void {
  const hooks = join(r.state, "mod", "mission-control", "hooks");
  writeFileSync(join(hooks, "register.js"), bundle);
  const sha = createHash("sha256").update(record === "other" ? "something else" : bundle).digest("hex");
  if (record) writeFileSync(join(hooks, "mod-calls.json"), JSON.stringify({ checked: true, bundleSha256: sha }));
  else rmSync(join(hooks, "mod-calls.json"), { force: true });
}

test("mod-calls fails on a staged bundle that reaches a daemon path outside the allowlist", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    restage(r, 'fetch("/api/health"); fetch("/api/sessions");', true);
    const result = await r.run("doctor");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}mod-calls: the staged mod calls daemon paths that are not allowed: \/api\/sessions/);
    assert.deepEqual(calledPaths('a("/api/health?x=1") + `/dispatch/inbox` + "/other"'), ["/api/health?x=1", "/dispatch/inbox"]);
  } finally {
    await r.cleanup();
  }
});

test("setup and doctor take no unknown arguments", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup", "--off")).code, 2);
    assert.equal((await r.run("doctor", "--frobnicate")).code, 2);
    // `--live` is accepted; nothing is installed in this rig, so the run itself reports failures.
    assert.equal((await r.run("doctor", "--live")).code, 1);
  } finally {
    await r.cleanup();
  }
});

test("a swap that fails after the old mod is moved aside puts the old mod back and leaves no sibling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-stage-swap-"));
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "1.0.0");
    await stageMod({ source, dest });
    writeModBuild(source, "1.1.0");
    let calls = 0;
    // The first rename moves the old mod aside; the second would publish the new one and fails.
    const failing: typeof rename = async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      return rename(from, to);
    };
    await assert.rejects(stageMod({ source, dest, rename: failing }), /disk full/);
    assert.equal(calls >= 3, true, "the old mod was renamed back after the failed publish");
    assert.equal(JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "1.0.0");
    assert.deepEqual(readdirSync(join(dir, "state")), ["mod"], "no staging or old sibling is left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a marketplace add that fails stops before any install and prints both recovery commands", async () => {
  const r = await rig();
  try {
    r.claude.update({ failures: { "marketplace add": { exitCode: 1, stderr: "cannot read marketplace", times: 5 } } });
    const result = await r.run("setup");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}mod: `claude plugin marketplace add` failed: cannot read marketplace/);
    assert.ok(result.out.includes("claude plugin install " + MOD_ID + " --scope user"));
    assert.ok(!pluginCalls(r.claude).includes("install"));
    assert.deepEqual(r.claude.state().plugins, []);
  } finally {
    await r.cleanup();
  }
});

test("a marketplace that is already added is not a failure", async () => {
  const r = await rig();
  try {
    r.claude.update({ failures: { "marketplace add": { exitCode: 1, stderr: "marketplace already added", times: 5 } } });
    const result = await r.run("setup");
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(r.claude.state().plugins[0]?.version, "2.2.0");
  } finally {
    await r.cleanup();
  }
});

test("a stale build whose uninstall fails stays installed, nothing is installed over it, and setup exits 1", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    r.claude.setInstalledVersion("2.1.0");
    r.claude.update({ failures: { uninstall: { exitCode: 1, stderr: "plugin is in use", times: 5 } } });
    const result = await r.run("setup");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}mod: `claude plugin uninstall` failed: plugin is in use/);
    assert.ok(result.out.includes("claude plugin marketplace add " + join(r.state, "mod")));
    assert.ok(!pluginCalls(r.claude).includes("install"));
    assert.deepEqual(r.claude.state().plugins.map((p) => p.version), ["2.1.0"]);
  } finally {
    await r.cleanup();
  }
});

test("an install that exits 0 but lists the wrong version, or the wrong scope, is reported as a failure", async () => {
  // Wrong version: the fake records 9.9.9 for the install, not the staged 2.3.0.
  const wrongVersion = await rig({ version: "2.3.0" });
  try {
    wrongVersion.claude.update({ stagedVersion: "9.9.9" });
    const result = await wrongVersion.run("setup");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}mod: the install finished but `claude plugin list` shows 9\.9\.9, not 2\.3\.0/);
    assert.ok(result.out.includes("claude plugin install " + MOD_ID + " --scope user"));
  } finally {
    await wrongVersion.cleanup();
  }

  // Wrong scope: the listing after the install says the plugin is at project scope.
  const wrongScope = await rig();
  try {
    let installed = false;
    const result = await runModStep({
      live: false,
      deps: {
        env: wrongScope.env,
        exec: async (file, args, options) => {
          const real = await realExec(file, args, options);
          if (args[1] === "install") installed = true;
          if (installed && args[1] === "list") {
            const rows = JSON.parse(real.stdout) as { scope: string }[];
            return { ...real, stdout: JSON.stringify(rows.map((row) => ({ ...row, scope: "project" }))) };
          }
          return real;
        },
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.message, /shows 2\.2\.0, project scope, not 2\.2\.0/);
  } finally {
    await wrongScope.cleanup();
  }
});

test("doctor fails mod-calls, with the fix, when `claude plugin validate` refuses the staged mod", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    r.claude.update({ failures: { validate: { exitCode: 1, stderr: "plugin.json: unknown field", times: 5 } } });
    const result = await r.run("doctor");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}mod-calls: `claude plugin validate` refused the staged mod: plugin\.json: unknown field\n {8}fix: Rebuild with `npm run build`, then run `mctl setup`\./);
    assert.match(result.out, /ok {4}mod-enabled: /, "the other checks still report");
  } finally {
    await r.cleanup();
  }
});

test("a plugin listing that fails is reported by setup (with recovery commands) and by doctor, both exit 1", async () => {
  const r = await rig();
  try {
    r.claude.update({ failures: { list: { exitCode: 1, stderr: "settings.json is unreadable", times: 20 } } });
    const setup = await r.run("setup");
    assert.equal(setup.code, 1);
    assert.match(setup.out, /FAIL {2}mod: `claude plugin list` failed: settings\.json is unreadable/);
    assert.ok(setup.out.includes("claude plugin install " + MOD_ID + " --scope user"));
    assert.ok(!pluginCalls(r.claude).includes("install"), "nothing is installed on an unreadable listing");
    const doctor = await r.run("doctor");
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, /FAIL {2}mod-enabled: `claude plugin list` failed: settings\.json is unreadable\n {8}fix: Run `mctl setup`\./);
  } finally {
    await r.cleanup();
  }
});

test("a plugin listing that is not JSON is reported by setup and by doctor", async () => {
  const r = await rig();
  try {
    const garbled = async (file: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
      const real = await realExec(file, args, options);
      return args[1] === "list" ? { ...real, stdout: "Installed plugins:\n  mission-control" } : real;
    };
    const deps = { env: r.env, exec: garbled };
    const setup = await runModStep({ live: false, deps });
    assert.equal(setup.status, "failed");
    assert.match(setup.message, /`claude plugin list --json` printed something that is not JSON/);
    assert.ok(setup.message.includes("claude plugin marketplace add " + join(r.state, "mod")));
    const doctor = await runDoctorStep({ live: false, deps });
    assert.equal(doctor.status, "failed");
    const check = doctor.checks!.find((c) => c.name === "mod-enabled")!;
    assert.equal(check.status, "fail");
    assert.match(check.message, /not JSON/);
    assert.equal(check.fix, "Run `mctl setup`.");
  } finally {
    await r.cleanup();
  }
});

test("a build whose plugin.json has no usable version is refused before anything is replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-stage-version-"));
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "1.0.0");
    await stageMod({ source, dest });
    const pluginJson = join(source, "mission-control", ".claude-plugin", "plugin.json");
    for (const [contents, reason] of [
      [JSON.stringify({ name: "mission-control" }), /no version/],
      [JSON.stringify({ name: "mission-control", version: "" }), /no version/],
      ["{ not json", /not valid JSON/],
    ] as const) {
      writeFileSync(pluginJson, contents);
      await assert.rejects(stageMod({ source, dest }), reason);
      assert.equal(JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "1.0.0", "the working mod is still published");
      assert.deepEqual(readdirSync(join(dir, "state")), ["mod"], "no staging or old sibling is left behind");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plugin listing entry without its scope or enabled state is a failure, never readiness", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    for (const drop of ["scope", "enabled"]) {
      const trimmed = async (file: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
        const real = await realExec(file, args, options);
        if (args[1] !== "list") return real;
        const rows = JSON.parse(real.stdout) as Record<string, unknown>[];
        return { ...real, stdout: JSON.stringify(rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== drop)))) };
      };
      const deps = { env: r.env, exec: trimmed };
      const setup = await runModStep({ live: false, deps });
      assert.equal(setup.status, "failed", "setup does not skip the install on an incomplete listing (" + drop + ")");
      assert.match(setup.message, /without its version, scope or enabled state/);
      const doctor = await runDoctorStep({ live: false, deps });
      const check = doctor.checks!.find((c) => c.name === "mod-enabled")!;
      assert.equal(check.status, "fail");
      assert.match(check.message, /without its version, scope or enabled state/);
    }
  } finally {
    await r.cleanup();
  }
});

test("mod-calls fails closed when the staged bundle is not the one the build checked, or has no record", async () => {
  // A route built at run time leaves no literal for the scan to see; only the build's record can vouch for the bundle.
  const constructed = 'const p = ["/", "api", "/", "sessions"].join(""); fetch(p); fetch("/api/health");';
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    // No record at all (an older build, or one made without the check).
    restage(r, constructed, false);
    assert.match((await r.run("doctor")).out, /FAIL {2}mod-calls: the staged mod has no build-time mod-calls record, so its daemon calls cannot be established/);
    // A record for a different bundle (the bundle was edited after the check).
    restage(r, constructed, "other");
    const doctor = await r.run("doctor");
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, /FAIL {2}mod-calls: the staged bundle is not the one the build checked, so its daemon calls cannot be established/);
    assert.match(doctor.out, /fix: Rebuild with `npm run build`, then run `mctl setup`\./);
  } finally {
    await r.cleanup();
  }
});

test("a build that setup's own checks reject never replaces the working mod or its installation", async () => {
  const constructed = 'const p = ["/", "api", "/", "sessions"].join(""); fetch(p);';
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    const stagedBundle = join(r.state, "mod", "mission-control", "hooks", "register.js");
    const working = readFileSync(stagedBundle, "utf8");
    const calls = pluginCalls(r.claude).length;
    const refuse = async (why: string, pattern: RegExp, prepare: () => void) => {
      prepare();
      const result = await r.run("setup");
      assert.equal(result.code, 1, why);
      assert.match(result.out, /FAIL {2}mod: could not stage the mod; the mod already installed was left as it was: /);
      assert.match(result.out, pattern, why);
      assert.equal(readFileSync(stagedBundle, "utf8"), working, why + ": the published mod is untouched");
      assert.deepEqual(readdirSync(r.state), ["mod"], why + ": no staging sibling");
      const added = pluginCalls(r.claude).slice(calls).filter((c) => c === "install" || c === "uninstall" || c === "marketplace add");
      assert.deepEqual(added, [], why + ": the installation is untouched");
      assert.equal(r.claude.state().plugins[0]?.version, "2.2.0");
    };
    // 1. A bundle with no build-time record.
    await refuse("no record", /no build-time mod-calls record/, () => writeModBuild(r.source, "2.9.0", constructed, false));
    // 2. A bundle that calls a route outside the allowlist.
    await refuse("disallowed route", /not allowed: \/api\/sessions/, () => writeModBuild(r.source, "2.9.0", 'fetch("/api/sessions");'));
    // 3. A bundle `claude plugin validate` refuses.
    await refuse("validate refused", /refused the staged mod: bad manifest/, () => {
      writeModBuild(r.source, "2.9.0");
      r.claude.update({ failures: { validate: { exitCode: 1, stderr: "bad manifest", times: 1 } } });
    });
  } finally {
    await r.cleanup();
  }
});

test("a failed cleanup of the staging copy does not stop the old mod being put back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-stage-cleanup-"));
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "1.0.0");
    await stageMod({ source, dest });
    writeModBuild(source, "1.1.0");
    let calls = 0;
    // Publishing fails, and so does everything that would tidy up after it, until the old mod is back.
    const failing: typeof rename = async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      return rename(from, to);
    };
    // Make the staging copy impossible to remove: a read-only directory inside it.
    const blocked: typeof cp = async (from, to, opts) => {
      await cp(from, to, opts);
      const { chmodSync } = await import("node:fs");
      chmodSync(join(String(to), "mission-control", "hooks"), 0o500);
    };
    await assert.rejects(stageMod({ source, dest, rename: failing, copy: blocked }), /disk full/);
    assert.equal(JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "1.0.0", "the old mod is back");
    for (const name of readdirSync(join(dir, "state"))) {
      if (name.includes("staging")) chmodSync(join(dir, "state", name, "mission-control", "hooks"), 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a build that is invalid once copied is refused before the swap, and the old mod stays published", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-stage-copy-"));
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "1.0.0");
    await stageMod({ source, dest });
    writeModBuild(source, "1.1.0");
    // The source changed while it was copied: the copy's plugin.json is not what was read before.
    const racing: typeof cp = async (from, to, opts) => {
      await cp(from, to, opts);
      writeFileSync(join(String(to), "mission-control", ".claude-plugin", "plugin.json"), "{ truncated");
    };
    await assert.rejects(stageMod({ source, dest, copy: racing }), /not valid JSON/);
    assert.equal(JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "1.0.0");
    assert.deepEqual(readdirSync(join(dir, "state")), ["mod"], "no staging or old sibling is left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when publishing fails and putting the old mod back fails too, both errors and the old build's location are reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mission-stage-restore-"));
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "1.0.0");
    await stageMod({ source, dest });
    writeModBuild(source, "1.1.0");
    let calls = 0;
    const failing: typeof rename = async (from, to) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      if (calls === 3) throw new Error("permission denied");
      return rename(from, to);
    };
    await assert.rejects(stageMod({ source, dest, rename: failing }), (error: Error) => {
      assert.match(error.message, /publishing the new mod failed \(disk full\)/);
      assert.match(error.message, /putting the previous mod back failed too \(permission denied\)/);
      const old = readdirSync(join(dir, "state")).find((name) => name.startsWith("mod.old-"))!;
      assert.ok(old, "the previous build is kept");
      assert.ok(error.message.includes(join(dir, "state", old)), "its location is named");
      assert.ok(error.message.includes("moved back to " + dest));
      assert.equal(JSON.parse(readFileSync(join(dir, "state", old, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "1.0.0");
      return true;
    });
    assert.equal(existsSync(dest), false);
    assert.equal(readdirSync(join(dir, "state")).some((n) => n.includes("staging")), false, "the staging copy is removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery commands quote a state directory with spaces or shell characters", async () => {
  assert.equal(shellArg("/Users/a/.mission-control/mod"), "/Users/a/.mission-control/mod");
  assert.equal(shellArg("/Users/a b/state"), "'/Users/a b/state'");
  assert.equal(shellArg("/tmp/x; rm -rf ~"), "'/tmp/x; rm -rf ~'");
  assert.equal(shellArg("/tmp/it's $HOME"), "'/tmp/it'\\''s $HOME'");
  assert.deepEqual(recoveryCommands("/Users/a b"), ["claude plugin marketplace add '/Users/a b/mod'", "claude plugin install " + MOD_ID + " --scope user"]);

  // And in what a failed setup prints, for a real state directory with a space and a quote in it.
  const r = await rig();
  try {
    const odd = join(r.home, "my state's dir");
    mkdirSync(odd, { recursive: true });
    r.env.MISSION_HOME = odd;
    r.claude.update({ failures: { install: { exitCode: 1, stderr: "nope", times: 5 } } });
    const result = await r.run("setup");
    assert.equal(result.code, 1);
    assert.ok(result.out.includes("  claude plugin marketplace add " + shellArg(join(odd, "mod"))));
    assert.ok(result.out.includes("'\\''"), "the embedded quote is escaped");
  } finally {
    await r.cleanup();
  }
});

test("with HOME unset in the environment, the known places under the resolved home are still searched", async () => {
  const fake = createFakeClaude({ version: "2.1.400" });
  const home = mkdtempSync(join(tmpdir(), "mission-detect-home-"));
  try {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    for (const name of ["claude", "state.json"]) writeFileSync(join(home, ".local", "bin", name), readFileSync(join(name === "claude" ? fake.path : join(fake.dir, name))));
    chmodSync(join(home, ".local", "bin", "claude"), 0o755);
    writeFileSync(join(home, ".local", "bin", "invocations.jsonl"), "");
    // `env` has no HOME and a restricted PATH; the dependency layer resolved the home separately.
    const found = await findClaude({ env: { PATH: "/nonexistent" }, exec: realExec, home });
    assert.equal(found.claude?.path, join(home, ".local", "bin", "claude"));
    assert.equal(found.claude?.source, "known place");
    assert.equal((await findClaude({ env: { PATH: "/nonexistent" }, exec: realExec })).claude, null, "without a home there is nowhere to look");
  } finally {
    fake.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a project-scope entry listed before the user-scope one is neither mistaken for it nor uninstalled", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    assert.equal((await r.run("setup")).code, 0);
    const projectFirst = async (file: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
      const real = await realExec(file, args, options);
      if (args[1] !== "list") return real;
      const rows = JSON.parse(real.stdout) as Record<string, unknown>[];
      return { ...real, stdout: JSON.stringify([{ ...rows[0], scope: "project", version: "1.0.0" }, ...rows]) };
    };
    const deps = { env: r.env, exec: projectFirst };
    const before = pluginCalls(r.claude).length;
    // The current user-scope install is found behind the project entry, so setup does nothing.
    const again = await runModStep({ live: false, deps });
    assert.equal(again.status, "ok", again.message);
    assert.match(again.message, /already installed/);
    const doctor = await runDoctorStep({ live: false, deps });
    assert.equal(doctor.checks!.find((c) => c.name === "mod-enabled")!.status, "ok");
    assert.equal(doctor.checks!.find((c) => c.name === "mod-current")!.status, "ok");
    assert.ok(!pluginCalls(r.claude).slice(before).some((c) => c === "uninstall" || c === "install"));

    // A stale user-scope install is replaced at user scope only, never at the project entry's scope.
    r.claude.setInstalledVersion("2.1.0");
    const stale = await runModStep({ live: false, deps });
    assert.equal(stale.status, "ok", stale.message);
    const uninstalls = r.claude.invocations().filter((i) => i.argv[1] === "uninstall").map((i) => i.argv.slice(2));
    assert.deepEqual(uninstalls.at(-1), [MOD_ID, "--scope", "user"]);

    // With only a project-scope entry, nothing is uninstalled and the user-scope install is added.
    r.claude.update({ plugins: [{ id: MOD_ID, version: "2.3.0", scope: "project", enabled: true }] });
    const uninstallsBefore = r.claude.invocations().filter((i) => i.argv[1] === "uninstall").length;
    const onlyProject = await runModStep({ live: false, deps: { env: r.env } });
    assert.equal(onlyProject.status, "ok", onlyProject.message);
    assert.equal(r.claude.invocations().filter((i) => i.argv[1] === "uninstall").length, uninstallsBefore);
    assert.ok(r.claude.invocations().some((i) => i.argv[1] === "install"));
  } finally {
    await r.cleanup();
  }
});

test("mod-calls does not pass when plugin validation could not be run for want of a usable claude", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    r.env.MISSION_CLAUDE_BIN = join(r.home, "no-such-claude");
    const result = await r.run("doctor");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}mod-calls: `claude plugin validate` could not be run because no usable claude was found, so the staged mod was not validated\n {8}fix: Fix the claude check first/);
    assert.match(result.out, /FAIL {2}claude: /, "the other failed checks still report on their own");
    assert.match(result.out, /ok {4}daemon: /);
  } finally {
    await r.cleanup();
  }
});
