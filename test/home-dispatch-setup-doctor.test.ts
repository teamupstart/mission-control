// Headless mode phase 14: `mctl setup` and `mctl doctor` against a fake `claude`, a fake daemon and
// a temporary state directory. No model tokens, no real Claude Code, no real state home.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { cp, rename } from "node:fs/promises";
import { findClaude, realExec } from "../src/cli/claude-cli.ts";
import { runCli } from "../src/cli/index.ts";
import type { CliIo } from "../src/cli/commands/index.ts";
import { checkDaemon, fetchHealth } from "../src/cli/setup-steps/checks.ts";
import { defaultModSource, resolveDeps } from "../src/cli/setup-steps/context.ts";
import { calledPaths, recoveryCommands, shellArg } from "../src/cli/setup-steps/checks.ts";
import { run as runDoctorStep } from "../src/cli/setup-steps/doctor.ts";
import { run as runModStep } from "../src/cli/setup-steps/mod.ts";
import { refuseCheckoutDestination, stageMod } from "../src/server/mod-stage.ts";
import { createFakeClaude, createFakeDaemon, type FakeClaude, type FakeDaemon } from "./helpers/home-dispatch-fakes.ts";
import { tempDir } from "./temp-root.mjs";

const MOD_ID = "mission-control@mission-control";

/** A mod build with the layout `npm run build:mod` writes, at a chosen version. */
function writeModBuild(root: string, version: string, bundle = 'fetch("/api/health"); fetch("/dispatch/inbox");', record = true): void {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "mission-control", ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "mission-control", "hooks"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: "mission-control", owner: { name: "Mission Control" }, plugins: [{ name: "mission-control", source: "./mission-control", version }] }),
  );
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
  const home = tempDir("mission-setup-");
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
    MISSION_API_TOKEN: "fake-token",
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
/** How a failed setup spells the discovered claude in the commands it prints. */
const bin = (r: Rig): string => shellArg(r.claude.path);

function pluginCalls(claude: FakeClaude): string[] {
  return claude.invocations().filter((i) => i.argv[0] === "plugin").map((i) => (i.argv[1] === "marketplace" ? "marketplace " + i.argv[2] : i.argv[1]!));
}

test("claude detection tries MISSION_CLAUDE_BIN, then PATH, then known places, and accepts only a claude with marketplaces", async () => {
  const viaEnv = createFakeClaude({ version: "2.1.400" });
  const viaPath = createFakeClaude({ version: "2.1.329" });
  const old = createFakeClaude({ marketplaceSupported: false });
  const home = tempDir("mission-detect-");
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

    const none = await findClaude({ env: { PATH: old.dir, HOME: tempDir("mission-empty-") }, exec });
    assert.equal(none.claude, null);
  } finally {
    for (const fake of [viaEnv, viaPath, old]) fake.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("staging publishes by rename: a new inode, no sibling left, and a bad build leaves the old one in place", async () => {
  const dir = tempDir("mission-stage-");
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
    assert.deepEqual(pluginCalls(r.claude).filter((c) => c !== "list" && c !== "validate" && c !== "--help"), ["marketplace list", "marketplace add", "marketplace list", "install", "marketplace list"]);
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

test("staging refuses inconsistent marketplace and plugin versions", async () => {
  const dir = tempDir("mission-stage-versions-");
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "2.3.0");
    await stageMod({ source, dest });
    writeModBuild(source, "2.4.0");
    const manifest = join(source, ".claude-plugin", "marketplace.json");
    const market = JSON.parse(readFileSync(manifest, "utf8"));
    market.plugins[0].version = "2.3.0";
    writeFileSync(manifest, JSON.stringify(market));
    await assert.rejects(stageMod({ source, dest }), /inconsistent marketplace and plugin versions/);
    assert.equal(JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "2.3.0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("staging refuses checkout destinations including symlinks", async () => {
  const dir = tempDir("mission-stage-checkout-");
  try {
    const checkout = join(dir, "checkout");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
    symlinkSync(checkout, join(dir, "link"));
    await assert.rejects(refuseCheckoutDestination(join(dir, "link", "state", "mod")), /inside a checkout/);
    await refuseCheckoutDestination(join(dir, "safe", "mod"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setup refuses a conflicting registered marketplace before staging or uninstalling", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    // A fresh machine: the refusal happens before anything is staged, so nothing is written.
    r.claude.update({ marketplaces: [join(r.home, "elsewhere")] });
    const fresh = await r.run("setup");
    assert.equal(fresh.code, 1);
    assert.match(fresh.out, /marketplace points to/);
    assert.equal(existsSync(join(r.state, "mod")), false, "nothing was staged");

    // A machine that was set up and then had its marketplace moved: the stale install is not uninstalled,
    // and doctor names the mismatch against the staged mod.
    r.claude.update({ marketplaces: [] });
    assert.equal((await r.run("setup")).code, 0);
    r.claude.setInstalledVersion("2.1.0");
    r.claude.update({ marketplaces: [join(r.home, "elsewhere")] });
    const result = await r.run("setup");
    assert.equal(result.code, 1);
    assert.match(result.out, /marketplace points to/);
    assert.ok(!pluginCalls(r.claude).includes("uninstall"));
    assert.match((await r.run("doctor")).out, /FAIL {2}mod-current: the registered marketplace source/);
  } finally { await r.cleanup(); }
});

test("setup retries an interrupted plugin install", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    r.claude.setInstalledVersion("2.1.0");
    r.claude.update({ failures: { install: { exitCode: 1, stderr: "temporary failure", times: 1 } } });
    const result = await r.run("setup");
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(pluginCalls(r.claude).filter((call) => call === "install").length, 2);
  } finally { await r.cleanup(); }
});

test("a reinstall that fails twice prints the cause and both recovery commands, still runs the other steps, and exits 1", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    r.claude.setInstalledVersion("2.1.0");
    r.claude.update({ failures: { install: { exitCode: 1, stderr: "marketplace unreachable", times: 5 } } });
    const result = await r.run("setup");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}mod: `claude plugin install` failed: marketplace unreachable/);
    assert.ok(result.out.includes(bin(r) + " plugin marketplace add " + join(r.state, "mod")));
    assert.ok(result.out.includes(bin(r) + " plugin install " + MOD_ID + " --scope user"));
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
    const added = r.claude.invocations().slice(calls).filter((i) => i.argv[0] === "plugin").map((i) => i.argv.slice(1).join(" "));
    assert.ok(added.every((c) => c === "list --json" || c.startsWith("validate ") || c === "--help" || c === "marketplace list --json"), added.join(","));
    assert.deepEqual(readdirSync(r.state), files);
  } finally {
    await r.cleanup();
  }
});

test("setup enables the preview and setup --off disables it without uninstalling", async () => {
  const r = await rig({ flag: false });
  try {
    const setup = await r.run("setup");
    assert.equal(setup.code, 0, setup.out + setup.err);
    assert.equal((await r.run("doctor")).code, 0);
    const before = pluginCalls(r.claude).length;
    const off = await r.run("setup", "--off");
    assert.equal(off.code, 0, off.out + off.err);
    assert.match(off.out, /flag is off/);
    assert.equal(pluginCalls(r.claude).length, before);
    assert.equal((await r.run("doctor")).code, 1);
  } finally { await r.cleanup(); }
});

test("setup reports an unauthorized preview flag change", async () => {
  const r = await rig({ flag: false });
  try {
    r.env.MISSION_API_TOKEN = "wrong-token";
    const result = await r.run("setup");
    assert.equal(result.code, 1);
    assert.match(result.out, /FAIL {2}flag: could not change the headless-mode flag: HTTP 401/);
    assert.equal((await r.run("doctor")).code, 1);
  } finally { await r.cleanup(); }
});

test("doctor and setup report enabled plugin load errors", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    assert.equal((await r.run("setup")).code, 0);
    r.claude.update({ plugins: [{ id: MOD_ID, version: "2.3.0", scope: "user", enabled: true, errors: ["hook failed"] }] });
    for (const command of ["doctor", "setup"] as const) {
      const result = await r.run(command);
      assert.equal(result.code, 1, result.out + result.err);
      assert.match(result.out, /FAIL {2}mod-enabled: .*failed to load: hook failed/);
    }
    r.claude.update({ plugins: [{ id: MOD_ID, version: "2.3.0", scope: "user", enabled: true, errors: [] }] });
    assert.equal((await r.run("doctor")).code, 0);
  } finally { await r.cleanup(); }
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
    assert.ok(
      stale.out.includes("fix: Run `mctl setup`, or by hand: " + bin(r) + " plugin uninstall " + MOD_ID + " --scope user && " + bin(r) + " plugin marketplace add "),
      "the by-hand fix for a stale mod starts with the uninstall",
    );
    assert.ok(stale.out.includes("&& " + bin(r) + " plugin install " + MOD_ID + " --scope user"));

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
    assert.equal((await r.run("setup", "--frobnicate")).code, 2);
    assert.equal((await r.run("doctor", "--frobnicate")).code, 2);
    // `--live` is accepted; nothing is installed in this rig, so the run itself reports failures.
    assert.equal((await r.run("doctor", "--live")).code, 1);
  } finally {
    await r.cleanup();
  }
});

test("a swap that fails after the old mod is moved aside puts the old mod back and leaves no sibling", async () => {
  const dir = tempDir("mission-stage-swap-");
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
    assert.ok(result.out.includes(bin(r) + " plugin install " + MOD_ID + " --scope user"));
    assert.ok(!pluginCalls(r.claude).includes("install"));
    assert.deepEqual(r.claude.state().plugins, []);
  } finally {
    await r.cleanup();
  }
});

test("a marketplace that is already added is not a failure", async () => {
  const r = await rig();
  try {
    r.claude.update({ marketplaces: [join(r.state, "mod")], failures: { "marketplace add": { exitCode: 1, stderr: "marketplace already added", times: 5 } } });
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
    assert.ok(result.out.includes(bin(r) + " plugin marketplace add " + join(r.state, "mod")));
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
    assert.match(result.out, /FAIL {2}mod: the install finished but `claude plugin list` shows version 9\.9\.9 instead of the staged 2\.3\.0/);
    assert.ok(result.out.includes(bin(wrongVersion) + " plugin install " + MOD_ID + " --scope user"));
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
    assert.match(result.message, /shows project scope instead of user scope/);
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
    assert.ok(setup.out.includes(bin(r) + " plugin install " + MOD_ID + " --scope user"));
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
    assert.ok(setup.message.includes(bin(r) + " plugin marketplace add " + join(r.state, "mod")));
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
  const dir = tempDir("mission-stage-version-");
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

// Removal is made to fail by a read-only folder, which root ignores; the test also proves it failed.
test("a failed cleanup of the staging copy does not stop the old mod being put back", { skip: process.getuid?.() === 0 }, async () => {
  const dir = tempDir("mission-stage-cleanup-");
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
    // The precondition: cleanup really failed, so the staging copy is still there.
    const leftovers = readdirSync(join(dir, "state")).filter((name) => name.includes(".staging-"));
    assert.equal(leftovers.length, 1, "the staging copy could not be removed, so the restore ran despite a failed cleanup");
    for (const name of leftovers) chmodSync(join(dir, "state", name, "mission-control", "hooks"), 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a build that is invalid once copied is refused before the swap, and the old mod stays published", async () => {
  const dir = tempDir("mission-stage-copy-");
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
  const dir = tempDir("mission-stage-restore-");
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
    assert.ok(result.out.includes("  " + bin(r) + " plugin marketplace add " + shellArg(join(odd, "mod"))));
    assert.ok(result.out.includes("'\\''"), "the embedded quote is escaped");
  } finally {
    await r.cleanup();
  }
});

test("with HOME unset in the environment, the known places under the resolved home are still searched", async () => {
  const fake = createFakeClaude({ version: "2.1.400" });
  const home = tempDir("mission-detect-home-");
  try {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    for (const name of ["claude", "state.json"]) writeFileSync(join(home, ".local", "bin", name), readFileSync(join(name === "claude" ? fake.path : join(fake.dir, name))));
    chmodSync(join(home, ".local", "bin", "claude"), 0o755);
    writeFileSync(join(home, ".local", "bin", "invocations.jsonl"), "");
    // `env` has no HOME and a restricted PATH; the dependency layer resolved the home separately.
    const found = await findClaude({ env: { PATH: "/nonexistent" }, exec: realExec, home });
    assert.equal(found.claude?.path, join(home, ".local", "bin", "claude"));
    assert.equal(found.claude?.source, "known place");
    assert.equal((await findClaude({ env: { PATH: "/nonexistent" }, exec: realExec, executable: () => false })).claude, null, "without a home there is nowhere to look");
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

test("a marketplace add that fails for a reason that merely contains the word already is a failure", async () => {
  for (const stderr of ["marketplace directory already locked by another process", "path already exists but is not readable", "Marketplace 'x' already exists but its manifest is invalid"]) {
    const r = await rig();
    try {
      r.claude.update({ failures: { "marketplace add": { exitCode: 1, stderr, times: 5 } } });
      const result = await r.run("setup");
      assert.equal(result.code, 1, stderr);
      assert.ok(result.out.includes("`claude plugin marketplace add` failed: " + stderr), stderr);
      assert.ok(!pluginCalls(r.claude).includes("install"), "nothing is installed against a marketplace that was never added");
    } finally {
      await r.cleanup();
    }
  }
  for (const stderr of ["Marketplace 'mission-control' already exists", "marketplace already added", "already registered"]) {
    const r = await rig();
    try {
      r.claude.update({ marketplaces: [join(r.state, "mod")], failures: { "marketplace add": { exitCode: 1, stderr, times: 5 } } });
      assert.equal((await r.run("setup")).code, 0, stderr);
    } finally {
      await r.cleanup();
    }
  }
});

test("the daemon check says what actually happened: refused, timed out, an error status, not JSON, or someone else", async () => {
  const withFetch = (fetchImpl: ReturnType<typeof resolveDeps>["fetch"]) => resolveDeps({ env: { MISSION_PORT: "7317" }, fetch: fetchImpl, stateDir: "/x", modSource: "/x", home: "/x" });
  const reading = async (fetchImpl: ReturnType<typeof resolveDeps>["fetch"]) => {
    const deps = withFetch(fetchImpl);
    return checkDaemon(await fetchHealth(deps), deps);
  };
  const refused = await reading(async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) }); });
  assert.match(refused.message, /no Mission Control daemon answered at .*\(ECONNREFUSED\)/);
  assert.match(refused.fix!, /^Start Mission Control/);

  const slow = await reading(async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
  assert.match(slow.message, /did not give a usable answer \(no answer within 3 s\)/);
  assert.doesNotMatch(slow.fix!, /^Start Mission Control/, "a daemon that is running is not told to start");
  assert.match(slow.fix!, /busy or stuck/);

  const broken = await reading(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.match(broken.message, /\(HTTP 500\)/);
  const stalledBody = await reading(async () => ({ ok: true, status: 200, json: async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); } }));
  assert.match(stalledBody.message, /did not give a usable answer \(the reply did not finish within 3 s\)/, "a stalled body is a timeout, not bad JSON");
  assert.match(stalledBody.fix!, /busy or stuck/);
  const garbled = await reading(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } }));
  assert.match(garbled.message, /\(the reply was not JSON\)/);
  const other = await reading(async () => ({ ok: true, status: 200, json: async () => ({ service: "something-else" }) }));
  assert.match(other.message, /answered, but not as Mission Control/);
  assert.match(other.fix!, /MISSION_PORT/);
  const fine = await reading(async () => ({ ok: true, status: 200, json: async () => ({ service: "mission-control" }) }));
  assert.equal(fine.status, "ok");
});

test("recovery commands name the discovered claude, and one setup run reads the daemon once", async () => {
  const r = await rig();
  try {
    r.claude.update({ failures: { install: { exitCode: 1, stderr: "nope", times: 5 } } });
    const result = await r.run("setup");
    assert.ok(result.out.includes(r.claude.path + " plugin marketplace add "), "the commands use the claude that was found, not a bare `claude`");
    assert.ok(result.out.includes(r.claude.path + " plugin install " + MOD_ID + " --scope user"));
    assert.equal(r.daemon.requests.filter((q) => q.path === "/api/health").length, 1, "daemon, flag and doctor steps share one /api/health reading");
    const doctor = await r.run("doctor");
    assert.equal(doctor.code, 1);
    assert.equal(r.daemon.requests.filter((q) => q.path === "/api/health").length, 2, "doctor alone reads it once more");
  } finally {
    await r.cleanup();
  }
});

test("a mod-calls record that is null, an array or a scalar is a failed check, not a crash", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    const record = join(r.state, "mod", "mission-control", "hooks", "mod-calls.json");
    for (const contents of ["null", "[]", "7", '"checked"']) {
      writeFileSync(record, contents);
      const doctor = await r.run("doctor");
      assert.equal(doctor.code, 1, contents);
      assert.match(doctor.out, /FAIL {2}mod-calls: the staged mod has no build-time mod-calls record/, contents);
    }
  } finally {
    await r.cleanup();
  }
});

test("a backup folder that cannot be removed after a successful publish does not turn it into a failure", { skip: process.getuid?.() === 0 }, async () => {
  const dir = tempDir("mission-stage-backup-");
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "1.0.0");
    await stageMod({ source, dest });
    writeModBuild(source, "1.1.0");
    // The old build cannot be deleted: its hooks folder is read-only.
    const hooks = join(dest, "mission-control", "hooks");
    chmodSync(hooks, 0o500);
    try {
      const staged = await stageMod({ source, dest });
      assert.equal(staged.version, "1.1.0", "the publish is reported as the success it was");
      // The precondition: removal really failed, so the backup is still beside the published mod.
      assert.equal(readdirSync(join(dir, "state")).filter((name) => name.startsWith("mod.old-")).length, 1, "the backup could not be removed");
      assert.equal(JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "1.1.0");
    } finally {
      for (const name of readdirSync(join(dir, "state"))) {
        const old = join(dir, "state", name, "mission-control", "hooks");
        if (name.startsWith("mod.old-") && existsSync(old)) chmodSync(old, 0o700);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plugin listing that is JSON but not a list is reported, never read as nothing installed", async () => {
  const r = await rig();
  try {
    const wrapped = async (file: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
      const real = await realExec(file, args, options);
      return args[1] === "list" ? { ...real, stdout: JSON.stringify({ plugins: JSON.parse(real.stdout) }) } : real;
    };
    const deps = { env: r.env, exec: wrapped };
    const setup = await runModStep({ live: false, deps });
    assert.equal(setup.status, "failed");
    assert.match(setup.message, /not a list of plugins/);
    assert.ok(!pluginCalls(r.claude).includes("install"), "setup does not keep reinstalling on a format it cannot read");
    const doctor = await runDoctorStep({ live: false, deps });
    const check = doctor.checks!.find((c) => c.name === "mod-enabled")!;
    assert.equal(check.status, "fail");
    assert.match(check.message, /not a list of plugins/);
    for (const value of ["null", "7", '"x"']) {
      const odd = async (file: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
        const real = await realExec(file, args, options);
        return args[1] === "list" ? { ...real, stdout: value } : real;
      };
      assert.match((await runModStep({ live: false, deps: { env: r.env, exec: odd } })).message, /not a list of plugins/, value);
    }
  } finally {
    await r.cleanup();
  }
});

test("the state home resolves through the one shared rule, whichever environment it is given", async () => {
  const { resolveStateDir, envVar } = await import("../src/shared/harness-runtime.mjs");
  assert.equal(envVar("HOME", { FLEET_HOME: "/f", HARNESS_HOME: "/h" }), "/f", "MISSION_ then FLEET_ then HARNESS_");
  assert.equal(resolveStateDir({ MISSION_HOME: "/m", FLEET_HOME: "/f" }, "/home/u"), "/m");
  assert.equal(resolveStateDir({ HARNESS_HOME: "/h" }, "/home/u"), "/h");
  assert.equal(resolveStateDir({}, "/nonexistent-home-for-test"), "/nonexistent-home-for-test/.mission-control");
});

test("a passing mod-calls check lists the daemon paths the bundle actually names", async () => {
  const r = await rig();
  try {
    writeModBuild(r.source, "2.2.0", 'fetch("/dispatch/answers"); fetch("/dispatch/inbox?x=1");');
    assert.equal((await r.run("setup")).code, 0);
    const doctor = await r.run("doctor");
    assert.equal(doctor.code, 0, doctor.out + doctor.err);
    assert.match(doctor.out, /ok {4}mod-calls: the staged mod calls only these daemon paths, all allowed: \/dispatch\/answers, \/dispatch\/inbox\?x=1\n/);
    const line = doctor.out.split("\n").find((l) => l.includes("mod-calls:"))!;
    assert.doesNotMatch(line, /\/api\/health/, "a path the bundle never names is not claimed");
  } finally {
    await r.cleanup();
  }
});

test("doctor always prints all six checks, saying so when one cannot run", async () => {
  const names = ["claude", "daemon", "flag", "mod-enabled", "mod-current", "mod-calls"];
  const lines = (out: string) => names.map((n) => out.split("\n").find((l) => l.includes(" " + n + ": ")));
  const r = await rig();
  try {
    // Nothing installed: mod-current cannot be checked.
    const fresh = await r.run("doctor");
    assert.ok(lines(fresh.out).every(Boolean), fresh.out);
    assert.match(fresh.out, /FAIL {2}mod-current: cannot be checked: the mod is not installed/);
    assert.match(fresh.err, /of 6 checks failed/);

    // An unreadable listing.
    r.claude.update({ failures: { list: { exitCode: 1, stderr: "boom", times: 5 } } });
    const broken = await r.run("doctor");
    assert.ok(lines(broken.out).every(Boolean), broken.out);
    assert.match(broken.out, /FAIL {2}mod-current: cannot be checked: the installed mods could not be listed/);

    // No claude at all.
    r.env.MISSION_CLAUDE_BIN = join(r.home, "no-such-claude");
    const none = await r.run("doctor");
    assert.ok(lines(none.out).every(Boolean), none.out);
    assert.match(none.out, /FAIL {2}mod-current: cannot be checked without claude/);
    assert.match(none.err, /of 6 checks failed/);
  } finally {
    await r.cleanup();
  }
});

test("an installed mod whose staged copy is missing or unreadable fails mod-current instead of dropping it", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    const staged = join(r.state, "mod");
    const pluginJson = join(staged, "mission-control", ".claude-plugin", "plugin.json");

    // Unreadable: the staged plugin.json is not JSON.
    writeFileSync(pluginJson, "{ not json");
    const unreadable = await r.run("doctor");
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.out, /ok {4}mod-enabled: /, "the mod is installed and enabled");
    assert.match(unreadable.out, new RegExp("FAIL {2}mod-current: no staged mod at " + staged.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(unreadable.out, /fix: Run `mctl setup`\./);

    // Missing: the whole staged folder is gone.
    rmSync(staged, { recursive: true, force: true });
    const missing = await r.run("doctor");
    assert.equal(missing.code, 1);
    for (const name of ["claude", "daemon", "flag", "mod-enabled", "mod-current", "mod-calls"]) {
      assert.ok(missing.out.split("\n").some((l) => l.includes(" " + name + ": ")), name + " is still reported");
    }
    assert.match(missing.out, /ok {4}mod-enabled: /);
    assert.match(missing.out, /FAIL {2}mod-current: no staged mod at /);
    assert.match(missing.err, /2 of 6 checks failed/, "mod-current and mod-calls both fail");
  } finally {
    await r.cleanup();
  }
});

test("a marketplace manifest that is unreadable or does not list the mod is refused before anything is replaced", async () => {
  const dir = tempDir("mission-stage-market-");
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "1.0.0");
    await stageMod({ source, dest });
    const manifest = join(source, ".claude-plugin", "marketplace.json");
    for (const [contents, reason] of [
      ["{ not json", /marketplace\.json that is missing or not valid JSON/],
      ["{}", /not the mission-control marketplace/],
      [JSON.stringify({ name: "mission-control", plugins: [] }), /not the mission-control marketplace/],
      [JSON.stringify({ name: "other", plugins: [{ name: "mission-control" }] }), /not the mission-control marketplace/],
      ["null", /not the mission-control marketplace/],
    ] as const) {
      writeModBuild(source, "1.1.0");
      writeFileSync(manifest, contents);
      await assert.rejects(stageMod({ source, dest }), reason, contents);
      assert.equal(JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "1.0.0", "the working mod stays");
      assert.deepEqual(readdirSync(join(dir, "state")), ["mod"]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup has claude validate the marketplace before the swap, and a refusal leaves the working mod and its installation alone", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    r.claude.setInstalledVersion("2.1.0");
    // Refuse only the marketplace root; the plugin folder inside it validates.
    const refuseMarketplace = async (file: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
      if (args[1] === "validate" && !String(args[2]).endsWith("mission-control")) return { code: 1, stdout: "", stderr: "marketplace.json: unknown field" };
      return realExec(file, args, options);
    };
    const result = await runModStep({ live: false, deps: { env: r.env, exec: refuseMarketplace } });
    assert.equal(result.status, "failed");
    assert.match(result.message, /refused the marketplace: marketplace\.json: unknown field/);
    assert.ok(!existsSync(join(r.state, "mod")), "nothing was published");
    const calls = pluginCalls(r.claude);
    assert.ok(!calls.includes("uninstall") && !calls.includes("install") && !calls.includes("marketplace add"));
    assert.equal(r.claude.state().plugins[0]?.version, "2.1.0");
  } finally {
    await r.cleanup();
  }
});

test("a marketplace error that merely mentions it is already registered does not count, and the working install is not uninstalled", async () => {
  for (const stderr of [
    "marketplace already registered but manifest is unreadable",
    "Marketplace 'x' already exists but is invalid",
    "already added, however the manifest could not be read",
    "marketplace already registered; unable to read manifest",
    "already added\nfailed to refresh marketplace contents",
    "marketplace already registered (manifest has a syntax problem)",
  ]) {
    const r = await rig({ version: "2.3.0" });
    try {
      r.claude.setInstalledVersion("2.1.0");
      r.claude.update({ failures: { "marketplace add": { exitCode: 1, stderr, times: 5 } } });
      const result = await r.run("setup");
      assert.equal(result.code, 1, stderr);
      assert.match(result.out, /FAIL {2}mod: `claude plugin marketplace add` failed: /);
      assert.ok(!pluginCalls(r.claude).includes("uninstall"), "the stale install is not removed on a failed add: " + stderr);
      assert.equal(r.claude.state().plugins[0]?.version, "2.1.0");
    } finally {
      await r.cleanup();
    }
  }
});

test("the by-hand recovery for a stale build starts with the user-scope uninstall, whichever step failed", async () => {
  // Uninstall itself failed, and a marketplace add failed while a stale user install is in place.
  const failures: Record<string, { exitCode: number; stderr: string; times: number }>[] = [
    { uninstall: { exitCode: 1, stderr: "plugin is in use", times: 5 } },
    { "marketplace add": { exitCode: 1, stderr: "cannot read marketplace", times: 5 } },
  ];
  for (const failure of failures) {
    const r = await rig({ version: "2.3.0" });
    try {
      r.claude.setInstalledVersion("2.1.0");
      r.claude.update({ failures: failure });
      const result = await r.run("setup");
      assert.equal(result.code, 1);
      const steps = result.out.split("To finish by hand, run:\n")[1]!.split("\n").slice(0, 3).map((l) => l.trim());
      assert.equal(steps[0], bin(r) + " plugin uninstall " + MOD_ID + " --scope user");
      assert.ok(steps[1]!.startsWith(bin(r) + " plugin marketplace add "));
      assert.equal(steps[2], bin(r) + " plugin install " + MOD_ID + " --scope user");
    } finally {
      await r.cleanup();
    }
  }
  // A fresh machine has nothing to uninstall, so its recovery is just add and install.
  const fresh = await rig();
  try {
    fresh.claude.update({ failures: { install: { exitCode: 1, stderr: "nope", times: 5 } } });
    const result = await fresh.run("setup");
    assert.ok(!result.out.includes(" plugin uninstall "));
  } finally {
    await fresh.cleanup();
  }
});

test("the built mod is found beside the bundle or in a source checkout, and MISSION_MOD_SOURCE wins", () => {
  const dir = tempDir("mission-modsrc-");
  try {
    const layout = (root: string) => {
      mkdirSync(join(root, "dist", "mod", ".claude-plugin"), { recursive: true });
      writeFileSync(join(root, "dist", "mod", ".claude-plugin", "marketplace.json"), "{}");
    };
    // The bundle layout: dist/cli/mctl.mjs next to dist/mod.
    const packaged = join(dir, "packaged");
    layout(packaged);
    mkdirSync(join(packaged, "dist", "cli"), { recursive: true });
    const bundleUrl = pathToFileURL(join(packaged, "dist", "cli", "mctl.mjs")).href;
    assert.equal(defaultModSource({}, bundleUrl), join(packaged, "dist", "mod"));

    // The source layout: src/cli/setup-steps/context.ts with dist/mod at the checkout root.
    const checkout = join(dir, "checkout");
    layout(checkout);
    mkdirSync(join(checkout, "src", "cli", "setup-steps"), { recursive: true });
    const sourceUrl = pathToFileURL(join(checkout, "src", "cli", "setup-steps", "context.ts")).href;
    assert.equal(defaultModSource({}, sourceUrl), join(checkout, "dist", "mod"));

    // The override wins over both; with no build anywhere, the first candidate is named so the error says where it looked.
    assert.equal(defaultModSource({ MISSION_MOD_SOURCE: "/somewhere/else" }, bundleUrl), "/somewhere/else");
    const bare = pathToFileURL(join(dir, "bare", "dist", "cli", "mctl.mjs")).href;
    assert.equal(defaultModSource({}, bare), join(dir, "bare", "dist", "mod"));

    // An unbuilt source checkout names its dist/mod, not a folder beside the source file.
    const unbuilt = pathToFileURL(join(dir, "unbuilt", "src", "cli", "setup-steps", "context.ts")).href;
    assert.equal(defaultModSource({}, unbuilt), join(dir, "unbuilt", "dist", "mod"));

    // This repository's own source layout resolves to its dist/mod, whether or not it has been built.
    assert.ok(defaultModSource({}).endsWith(join("dist", "mod")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup does not ask claude the same questions twice, while doctor on its own still does", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    const argvs = r.claude.invocations().map((i) => i.argv.slice(0, 2).join(" "));
    const count = (what: string) => argvs.filter((a) => a === what).length;
    // The mod step lists before and after installing and validates the plugin and the marketplace; the closing doctor step reuses all of it.
    assert.equal(count("plugin list"), 2, argvs.join(" | "));
    assert.equal(count("plugin validate"), 2, argvs.join(" | "));

    const before = r.claude.invocations().length;
    assert.equal((await r.run("doctor")).code, 0);
    const added = r.claude.invocations().slice(before).map((i) => i.argv.slice(0, 2).join(" "));
    assert.equal(added.filter((a) => a === "plugin list").length, 1);
    assert.equal(added.filter((a) => a === "plugin validate").length, 1);
  } finally {
    await r.cleanup();
  }
});

test("a later stage sweeps the staging copies and backups an earlier run left, but never the only copy of the mod", async () => {
  const dir = tempDir("mission-stage-sweep-");
  try {
    const source = join(dir, "build");
    const state = join(dir, "state");
    const dest = join(state, "mod");
    writeModBuild(source, "1.0.0");
    const plant = (name: string) => {
      mkdirSync(join(state, name), { recursive: true });
      writeFileSync(join(state, name, "marker"), "x");
    };
    // Nothing is published yet, and an earlier run left a backup: it may be the only copy, so it stays. Its staging copy goes.
    mkdirSync(state, { recursive: true });
    plant("mod.old-2147483646-aaaa");
    plant("mod.staging-2147483646-bbbb");
    await stageMod({ source, dest });
    assert.deepEqual(readdirSync(state).sort(), ["mod", "mod.old-2147483646-aaaa"]);

    // Now a mod is published, so the dead run's backup and staging copy are stale. A running process's, and unrelated folders, stay.
    plant("mod.staging-2147483646-cccc");
    plant("mod.old-" + process.ppid + "-dddd");
    plant("modest.old-2147483646-eeee");
    plant("mod.staging-notapid-ffff");
    writeModBuild(source, "1.1.0");
    await stageMod({ source, dest });
    assert.deepEqual(readdirSync(state).sort(), ["mod", "mod.old-" + process.ppid + "-dddd", "mod.staging-notapid-ffff", "modest.old-2147483646-eeee"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mod-calls verdict is shared with the closing doctor only after the build was published", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    r.claude.setInstalledVersion("2.1.0");
    // The plugin folder validates, then claude refuses the marketplace: nothing is published.
    const refuseMarketplace = async (file: string, args: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => {
      if (args[1] === "validate" && !String(args[2]).endsWith("mission-control")) return { code: 1, stdout: "", stderr: "marketplace refused" };
      return realExec(file, args, options);
    };
    const runCache: NonNullable<Parameters<typeof runModStep>[0]["deps"]>["runCache"] = {};
    const deps = { env: r.env, exec: refuseMarketplace, runCache };
    const mod = await runModStep({ live: false, deps });
    assert.equal(mod.status, "failed");
    assert.equal(runCache!.modCalls, undefined, "the verdict on a copy that was never published is not kept");
    assert.equal(runCache!.installed, undefined);

    // So the closing doctor step checks what is really there, and finds nothing published.
    const doctor = await runDoctorStep({ live: false, deps: { env: r.env, runCache } });
    const check = doctor.checks!.find((c) => c.name === "mod-calls")!;
    assert.equal(check.status, "fail");
    assert.match(check.message, /no mod bundle at/);

    // A setup whose publish succeeds does keep it.
    const ok = await runModStep({ live: false, deps: { env: r.env, runCache: {} } });
    assert.equal(ok.status, "ok", ok.message);
    // A changed build is published again, so its verdict is kept; an unchanged one is not staged at all.
    writeModBuild(r.source, "2.3.0", 'fetch("/api/health"); fetch("/dispatch/inbox"); // rebuilt');
    const kept: NonNullable<Parameters<typeof runModStep>[0]["deps"]>["runCache"] = {};
    await runModStep({ live: false, deps: { env: r.env, runCache: kept } });
    assert.equal(kept!.modCalls?.status, "ok");
  } finally {
    await r.cleanup();
  }
});

test("two overlapping stages of the same mod are serialized, so neither removes the other's published build", async () => {
  const dir = tempDir("mission-stage-race-");
  try {
    const first = join(dir, "build-a");
    const second = join(dir, "build-b");
    const dest = join(dir, "state", "mod");
    writeModBuild(first, "1.0.0");
    writeModBuild(second, "1.1.0");
    await stageMod({ source: first, dest });
    // Each run's validation pauses, so without a lock the two would interleave their renames.
    let inside = 0;
    let peak = 0;
    const slow = async () => {
      inside += 1;
      peak = Math.max(peak, inside);
      await new Promise((resolve) => setTimeout(resolve, 150));
      inside -= 1;
    };
    const results = await Promise.all([
      stageMod({ source: first, dest, validate: slow }),
      stageMod({ source: second, dest, validate: slow }),
      stageMod({ source: second, dest, validate: slow }),
    ]);
    assert.equal(peak, 1, "only one run is staging at a time");
    assert.deepEqual(results.map((r) => r.version).sort(), ["1.0.0", "1.1.0", "1.1.0"]);
    const published = JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version;
    assert.ok(["1.0.0", "1.1.0"].includes(published), "a complete build is published");
    assert.deepEqual(readdirSync(join(dir, "state")), ["mod"], "no lock, staging or backup folder is left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock left by a dead run is taken over, and one held by a running run is waited for and then reported", async () => {
  const dir = tempDir("mission-stage-lock-");
  try {
    const source = join(dir, "build");
    const dest = join(dir, "state", "mod");
    writeModBuild(source, "1.0.0");
    const plantLock = (pid: number) => {
      mkdirSync(dest + ".lock", { recursive: true });
      writeFileSync(join(dest + ".lock", "owner"), String(pid));
    };
    // A run that was killed: its lock names a process that is gone.
    plantLock(2147483646);
    assert.equal((await stageMod({ source, dest })).version, "1.0.0");
    assert.deepEqual(readdirSync(join(dir, "state")), ["mod"]);

    // A run that is still going (this test's parent process stands in for it): wait, then say so, and touch nothing.
    plantLock(process.ppid);
    await assert.rejects(stageMod({ source, dest, lockTimeoutMs: 300 }), new RegExp("another mctl setup \\(process " + process.ppid + "\\) is staging the mod"));
    assert.equal(JSON.parse(readFileSync(join(dest, "mission-control", ".claude-plugin", "plugin.json"), "utf8")).version, "1.0.0");
    assert.ok(existsSync(dest + ".lock"), "the other run's lock is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a setup run whose mod is already published and installed stages nothing, and a changed build is staged again", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    const dest = join(r.state, "mod");
    const inode = statSync(dest).ino;
    const before = r.claude.invocations().length;
    const again = await r.run("setup");
    assert.equal(again.code, 0, again.out + again.err);
    assert.match(again.out, /the mod 2\.2\.0 is already installed/);
    assert.equal(statSync(dest).ino, inode, "the published mod was not swapped");
    // The mod step asked claude to validate nothing; the closing doctor's one validate is all that ran.
    const added = r.claude.invocations().slice(before).map((i) => i.argv.slice(0, 2).join(" "));
    assert.equal(added.filter((a) => a === "plugin validate").length, 1, added.join(" | "));
    assert.deepEqual(readdirSync(r.state), ["mod"]);

    // The same version rebuilt with different bytes is not "current": it is staged and published again.
    writeModBuild(r.source, "2.2.0", 'fetch("/api/health"); // rebuilt');
    assert.equal((await r.run("setup")).code, 0);
    assert.notEqual(statSync(dest).ino, inode, "a changed build is swapped in");
    assert.match(readFileSync(join(dest, "mission-control", "hooks", "register.js"), "utf8"), /rebuilt/);
  } finally {
    await r.cleanup();
  }
});

test("two overlapping setups share one install sequence: the stale build is uninstalled and installed once, and both report success", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    r.claude.setInstalledVersion("2.1.0");
    const results = await Promise.all([runModStep({ live: false, deps: { env: r.env } }), runModStep({ live: false, deps: { env: r.env } }), runModStep({ live: false, deps: { env: r.env } })]);
    assert.deepEqual(results.map((x) => x.status), ["ok", "ok", "ok"], results.map((x) => x.message).join(" | "));
    const calls = pluginCalls(r.claude);
    assert.equal(calls.filter((c) => c === "uninstall").length, 1, "only the first run removes the stale build: " + calls.join(","));
    assert.equal(calls.filter((c) => c === "install").length, 1);
    assert.equal(r.claude.state().plugins.length, 1);
    assert.equal(r.claude.state().plugins[0]?.version, "2.3.0");
    assert.equal(results.filter((x) => /already installed/.test(x.message)).length, 2, "the others find it current once the first finishes");
    assert.deepEqual(readdirSync(r.state), ["mod"], "the lock is released");
  } finally {
    await r.cleanup();
  }
});

test("an unexpected setup argument is reported with usage, and only --service is explained as the Foreman service", async () => {
  const r = await rig();
  try {
    const typo = await r.run("setup", "--of");
    assert.equal(typo.code, 2);
    assert.match(typo.err, /unexpected argument --of\nusage: mctl setup/);
    assert.doesNotMatch(typo.err, /Foreman/, "a typo is not blamed on the Foreman service");
    const service = await r.run("setup", "--service");
    assert.equal(service.code, 2);
    assert.match(service.err, /unexpected argument --service \(the Foreman service is not available in this build\)/);
    assert.equal((await r.run("setup", "--off", "--of")).code, 2);
  } finally {
    await r.cleanup();
  }
});

test("an install at the right version that failed to load is reported as failed to load, not as already installed, and is not reinstalled", async () => {
  const r = await rig();
  try {
    assert.equal((await r.run("setup")).code, 0);
    r.claude.update({ plugins: [{ id: MOD_ID, version: "2.2.0", scope: "user", enabled: true, errors: ["hook failed"] }] });
    const before = pluginCalls(r.claude).length;
    const mod = await runModStep({ live: false, deps: { env: r.env } });
    assert.equal(mod.status, "failed");
    assert.match(mod.message, /installed at user scope but failed to load: hook failed/);
    assert.doesNotMatch(mod.message, /already installed/);
    const calls = pluginCalls(r.claude).slice(before);
    assert.ok(!calls.includes("uninstall") && !calls.includes("install"), "the same build is not installed again: " + calls.join(","));
  } finally {
    await r.cleanup();
  }
});

test("the checkout guard stops at the user's home, so a git-tracked home does not block the default state directory", async () => {
  const dir = tempDir("mission-guard-");
  try {
    const gitDir = (root: string) => {
      mkdirSync(join(root, ".git"), { recursive: true });
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    };
    // A home directory that is itself a git repository (dotfiles), with the default state dir under it.
    const home = join(dir, "home");
    gitDir(home);
    await refuseCheckoutDestination(join(home, ".mission-control", "mod"), home);
    // A project checkout inside that home is still refused, and so is one above a destination outside home.
    const project = join(home, "code", "project");
    gitDir(project);
    await assert.rejects(refuseCheckoutDestination(join(project, "state", "mod"), home), /inside a checkout/);
    const elsewhere = join(dir, "elsewhere");
    gitDir(elsewhere);
    await assert.rejects(refuseCheckoutDestination(join(elsewhere, "state", "mod"), home), /inside a checkout/);
    // stageMod applies the same guard with the home it is given.
    const source = join(dir, "build");
    writeModBuild(source, "1.0.0");
    assert.equal((await stageMod({ source, dest: join(home, ".mission-control", "mod"), home })).version, "1.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a marketplace registered somewhere else is refused before the mod is staged, so nothing is overwritten", async () => {
  const r = await rig({ version: "2.3.0" });
  try {
    assert.equal((await r.run("setup")).code, 0);
    const dest = join(r.state, "mod");
    const inode = statSync(dest).ino;
    writeModBuild(r.source, "2.3.0", 'fetch("/api/health"); // a new build');
    r.claude.update({ marketplaces: ["/somewhere/else/mod"] });
    const result = await r.run("setup");
    assert.equal(result.code, 1);
    assert.match(result.out, /marketplace points to \/somewhere\/else\/mod/);
    assert.equal(statSync(dest).ino, inode, "the published mod was not touched by the refusal");
    assert.doesNotMatch(readFileSync(join(dest, "mission-control", "hooks", "register.js"), "utf8"), /a new build/);
  } finally {
    await r.cleanup();
  }
});
