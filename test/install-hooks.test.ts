// The hook installer edits the user's Claude settings.json in place. These tests
// pin the contract that matters: it MERGES (never overwrites) - preserving other
// keys, the user's own hooks, and even comments - and is idempotent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";

const INSTALLER = join(import.meta.dirname, "..", "hooks", "install.mjs");
const MARKER = "harness-hook.mjs";
const STATUSLINE_MARKER = "harness-statusline.mjs";
// Under tsx, because that is the installer's real entry point (`npm run install-hooks`)
// and it imports the TypeScript reconciler to unwind the skill links. Running it under
// bare node here would test a way nobody invokes it.
//
// `--force`, because dev checkouts of this repo routinely ARE treehouse pool slots,
// where the installer now refuses outright - and these tests pin the merge contract,
// not the refusal. The guard has its own tests against a fake pool below, where the
// flag's absence is the point.
const RUN = ["--import", "tsx", INSTALLER, "--force"];

/**
 * The throwaway `~/.claude/skills` for a settings file, kept beside it so it is torn
 * down with it. Every run gets one: `--uninstall` really does remove skill symlinks
 * now, so a test that let `claudeSkillsDir()` fall through to the real homedir would
 * delete the skills off the machine of whoever ran the suite.
 *
 * This variable alone is NOT that isolation, and believing it was is what let this suite
 * uninstall the operator's live Codex and pi skills on every run for as long as those
 * harnesses have declared a `skills` spec. `--uninstall` walks `skillsDirs()` - one
 * directory per harness - so pinning Claude's redirected exactly one third of the walk and
 * left the rest pointed at the real home. `MISSION_HOME` below is the isolation; this
 * stays because the assertions want a path they can read back.
 */
const skillsDirFor = (settingsPath: string): string => join(settingsPath, "..", "claude-skills");

/** The throwaway `MISSION_HOME` for a settings file, likewise beside it. */
const homeDirFor = (settingsPath: string): string => join(settingsPath, "..", "home");

/** Run the installer with an isolated state dir (for the status line sidecar). */
function runInstallerHome(settingsPath: string, homeDir: string, args: string[] = []): string {
  return execFileSync(process.execPath, [...RUN, ...args], {
    env: {
      ...process.env,
      CLAUDE_SETTINGS_PATH: settingsPath,
      CLAUDE_SKILLS_DIR: skillsDirFor(settingsPath),
      MISSION_HOME: homeDir,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** A settings file + an isolated state dir, both torn down afterwards. */
function withTempSettingsHome(initial: string, fn: (settingsPath: string, homeDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "harness-sl-"));
  const settingsPath = join(dir, "settings.json");
  const homeDir = join(dir, "home");
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(settingsPath, initial);
  try {
    fn(settingsPath, homeDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SETTINGS_WITH_STATUSLINE = `{
  "model": "opus",
  "statusLine": { "type": "command", "command": "npx -y ccstatusline@latest" }
}
`;

/**
 * Run the installer against a throwaway settings file.
 *
 * Delegates rather than assembling its own environment, so there is ONE answer to what an
 * isolated installer run looks like. The two used to differ in exactly the way that
 * mattered: this one named `CLAUDE_SKILLS_DIR` and no home, so `skillsDirs()` resolved
 * Codex's and pi's directories under the operator's real one and `--uninstall` cleared
 * their live skill links. `MISSION_HOME` isolates every harness at once, including the
 * ones that do not exist yet.
 */
function runInstaller(settingsPath: string, args: string[] = []): void {
  const home = homeDirFor(settingsPath);
  mkdirSync(home, { recursive: true });
  runInstallerHome(settingsPath, home, args);
}

function withTempSettings(initial: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "harness-hooks-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, initial);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const USER_SETTINGS = `{
  // keep this comment
  "model": "opus",
  "env": { "FOO": "bar" },
  "permissions": { "allow": ["Bash(ls:*)"] },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "my-own-hook" }] }
    ]
  }
}
`;

test("merges hooks without disturbing other keys, the user's hooks, or comments", () => {
  withTempSettings(USER_SETTINGS, (path) => {
    runInstaller(path);
    const text = readFileSync(path, "utf8");
    const s = parse(text) as any;

    // Unrelated settings survive untouched.
    assert.equal(s.model, "opus");
    assert.deepEqual(s.env, { FOO: "bar" });
    assert.deepEqual(s.permissions, { allow: ["Bash(ls:*)"] });
    // Comments are preserved (the old JSON.parse rewrite would have dropped them).
    assert.match(text, /keep this comment/);

    // Every lifecycle event now has our hook…
    assert.equal(Object.keys(s.hooks).length, 9);
    // …and the user's own PreToolUse hook still lives alongside ours.
    const cmds = s.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    assert.ok(cmds.some((c: string) => c === "my-own-hook"), "user hook preserved");
    assert.ok(cmds.some((c: string) => c.includes(MARKER)), "harness hook added");
  });
});

test("is idempotent: a second install changes nothing", () => {
  withTempSettings(USER_SETTINGS, (path) => {
    runInstaller(path);
    const first = readFileSync(path, "utf8");
    runInstaller(path);
    const second = readFileSync(path, "utf8");
    assert.equal(second, first, "re-running the installer must not rewrite the file");
  });
});

test("uninstall removes only our hooks and keeps the user's", () => {
  withTempSettings(USER_SETTINGS, (path) => {
    runInstaller(path);
    runInstaller(path, ["--uninstall"]);
    const text = readFileSync(path, "utf8");
    const s = parse(text) as any;

    assert.equal(s.model, "opus");
    assert.match(text, /keep this comment/);
    assert.ok(!text.includes(MARKER), "no harness hooks remain");
    const cmds = s.hooks.PreToolUse.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    assert.deepEqual(cmds, ["my-own-hook"], "user hook preserved after uninstall");
  });
});

test("refuses to touch a malformed settings file", () => {
  withTempSettings('{ "model": "opus", oops }', (path) => {
    const before = readFileSync(path, "utf8");
    assert.throws(() => runInstaller(path), "installer should exit non-zero on broken JSON");
    assert.equal(readFileSync(path, "utf8"), before, "malformed file left untouched");
  });
});

// ---- opt-in status line wrapper ----

test("a default install never touches the status line", () => {
  withTempSettingsHome(SETTINGS_WITH_STATUSLINE, (path, home) => {
    runInstallerHome(path, home, []);
    const s = parse(readFileSync(path, "utf8")) as any;
    assert.equal(s.statusLine.command, "npx -y ccstatusline@latest", "status line left untouched by default");
  });
});

test("--statusline wraps an existing status line and records the original", () => {
  withTempSettingsHome(SETTINGS_WITH_STATUSLINE, (path, home) => {
    runInstallerHome(path, home, ["--statusline"]);
    const s = parse(readFileSync(path, "utf8")) as any;
    assert.ok(s.statusLine.command.includes(STATUSLINE_MARKER), "status line points at our wrapper");
    // The original command is recorded so the forwarder delegates to it.
    assert.equal(readFileSync(join(home, "statusline-inner"), "utf8").trim(), "npx -y ccstatusline@latest");
    assert.equal(Object.keys(s.hooks).length, 9, "hooks are installed alongside");
  });
});

test("--uninstall restores the original status line and drops the wrapper + sidecar", () => {
  withTempSettingsHome(SETTINGS_WITH_STATUSLINE, (path, home) => {
    runInstallerHome(path, home, ["--statusline"]);
    runInstallerHome(path, home, ["--uninstall"]);
    const text = readFileSync(path, "utf8");
    const s = parse(text) as any;
    assert.equal(s.statusLine.command, "npx -y ccstatusline@latest", "original status line restored");
    assert.ok(!text.includes(STATUSLINE_MARKER), "wrapper gone");
    assert.ok(!existsSync(join(home, "statusline-inner")), "sidecar removed");
  });
});

test("--statusline with no prior status line wraps, and uninstall removes the key", () => {
  withTempSettingsHome(`{ "model": "opus" }\n`, (path, home) => {
    runInstallerHome(path, home, ["--statusline"]);
    let s = parse(readFileSync(path, "utf8")) as any;
    assert.ok(s.statusLine.command.includes(STATUSLINE_MARKER), "wrapper installed");
    assert.ok(!existsSync(join(home, "statusline-inner")), "no sidecar when there was nothing to record");
    runInstallerHome(path, home, ["--uninstall"]);
    s = parse(readFileSync(path, "utf8")) as any;
    assert.equal(s.statusLine, undefined, "status line key removed on uninstall");
  });
});

// ---- the opt-in cost telemetry env block ----
// Both failures pinned here are SILENT ones: telemetry that reports nothing, and
// telemetry switched off by an install that was never asked to switch it off.

/** Our six keys as they stand in the file, or `{}`. */
function otelEnv(settingsPath: string): Record<string, string> {
  const env = ((parse(readFileSync(settingsPath, "utf8")) as any)?.env ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("OTEL_") || k === "CLAUDE_CODE_ENABLE_TELEMETRY"));
}

test("--telemetry writes the block with a token it mints if the daemon never ran", () => {
  withTempSettingsHome(`{ "model": "opus" }\n`, (path, home) => {
    // `npm run setup` installs BEFORE the daemon has ever booted, so the token file is
    // normally absent here. Reading "" would bake `x-harness-token=` into the file, have
    // every export answered 401, and look exactly like a fresh install awaiting its
    // first session - nothing on screen would say otherwise.
    assert.ok(!existsSync(join(home, "token")), "no token before the install");
    runInstallerHome(path, home, ["--telemetry"]);
    const token = readFileSync(join(home, "token"), "utf8").trim();
    assert.ok(token.length > 0, "the installer minted one");
    assert.equal(otelEnv(path).OTEL_EXPORTER_OTLP_HEADERS, `x-harness-token=${token}`);
    assert.equal(otelEnv(path).CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  });
});

test("a default install never adds the block", () => {
  withTempSettingsHome(`{ "model": "opus" }\n`, (path, home) => {
    runInstallerHome(path, home, []);
    assert.deepEqual(otelEnv(path), {}, "telemetry is its own opt-in, like the status line");
  });
});

test("a later install without --telemetry leaves an existing block completely untouched", () => {
  withTempSettingsHome(`{ "model": "opus" }\n`, (path, home) => {
    runInstallerHome(path, home, ["--telemetry"]);
    const block = otelEnv(path);
    // Every one of these is a plain re-install someone runs for an unrelated reason.
    // Tearing the block down here would silently disable cost telemetry switched on in
    // Settings -> Cost and leave the daemon's stored `enabled` disagreeing with the file,
    // with nothing to reconcile the two.
    for (const args of [[], ["--statusline"], []]) runInstallerHome(path, home, args);
    assert.deepEqual(otelEnv(path), block, "the block survives verbatim");
    const after = parse(readFileSync(path, "utf8")) as any;
    assert.ok(after.statusLine.command.includes(STATUSLINE_MARKER), "and the runs it rode in on still did their job");
  });
});

test("the opt-in hints are offered only for the opt-ins that are actually off", () => {
  // A plain install no longer touches either opt-in, so "did this run change it?" is now
  // always no and says nothing about whether the thing is on. Hinting off that tells
  // someone who switched telemetry on in Settings -> Cost to go and switch on what they
  // already have, which reads as the feature not having worked.
  withTempSettingsHome(SETTINGS_WITH_STATUSLINE, (path, home) => {
    const fresh = runInstallerHome(path, home, []);
    assert.match(fresh, /npm run install-telemetry/, "offered while telemetry is off");
    assert.match(fresh, /npm run install-statusline/, "offered while the wrapper is off");

    runInstallerHome(path, home, ["--telemetry"]);
    runInstallerHome(path, home, ["--statusline"]);
    // Drop the hooks so the next plain install has real work to do and reaches the report
    // rather than the "already up to date" exit - which is what happens for real when an
    // install runs out of a different checkout and the hook script path has moved.
    const settings = parse(readFileSync(path, "utf8")) as any;
    delete settings.hooks;
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

    const after = runInstallerHome(path, home, []);
    assert.match(after, /Wired Mission Control hooks/, "this run really did reinstall the hooks");
    assert.doesNotMatch(after, /npm run install-telemetry/, "not offered once the env block is there");
    assert.doesNotMatch(after, /npm run install-statusline/, "not offered once the wrapper is there");
  });
});

test("--uninstall removes the block", () => {
  withTempSettingsHome(`{ "model": "opus", "env": { "EDITOR": "hx" } }\n`, (path, home) => {
    runInstallerHome(path, home, ["--telemetry"]);
    runInstallerHome(path, home, ["--uninstall"]);
    assert.deepEqual(otelEnv(path), {}, "ours are gone");
    // Leaving an env pointing at a daemon this checkout no longer runs would keep every
    // Claude session on the machine retrying an export forever - but only ours go.
    assert.equal((parse(readFileSync(path, "utf8")) as any).env.EDITOR, "hx");
  });
});

// ---- the skill symlinks ----
// The most invasive thing the harness puts in a home directory: they sit in Claude's
// native loading path for every session on the machine, so leaving them behind would
// outlive the uninstall meant to remove them.

/** A populated `~/.claude/skills`: one of ours, and two that are emphatically not. */
function seedSkills(settingsPath: string): string {
  const dir = skillsDirFor(settingsPath);
  mkdirSync(dir, { recursive: true });
  // Real targets, so `existsSync` on a link answers about the link rather than about a
  // dangling one - and so the assertions below can watch the targets survive.
  for (const target of ["src-alpha", "src-theirs"]) mkdirSync(join(dir, "..", target), { recursive: true });
  symlinkSync(join(dir, "..", "src-alpha"), join(dir, "fleet-alpha"), "dir");
  // The operator's hand-authored skill, and a real directory wearing our prefix.
  symlinkSync(join(dir, "..", "src-theirs"), join(dir, "handmade-skill"), "dir");
  mkdirSync(join(dir, "fleet-handmade"), { recursive: true });
  return dir;
}

test("--uninstall removes our skill links from ~/.claude/skills", () => {
  withTempSettings(USER_SETTINGS, (path) => {
    const dir = seedSkills(path);
    runInstaller(path);
    runInstaller(path, ["--uninstall"]);

    assert.ok(!existsSync(join(dir, "fleet-alpha")), "our link is gone - uninstall really uninstalls");
    // Unlinked, never recursed into: the skill's source lives in the app repo, and the
    // link is a pointer at it, not a copy of it.
    assert.ok(existsSync(join(dir, "..", "src-alpha")), "the link's target is not ours to delete");
    // Marker discipline survives the uninstall: the prefix scopes what we may remove,
    // it does not license deleting a directory of someone's work because the name matched.
    assert.ok(existsSync(join(dir, "handmade-skill")), "the operator's own skill is untouched");
    assert.ok(existsSync(join(dir, "fleet-handmade")), "a real directory is never removed, prefix or no prefix");
  });
});

test("--uninstall clears the links even when no hooks are left to strip", () => {
  withTempSettings(USER_SETTINGS, (path) => {
    const dir = seedSkills(path);
    // Never installed, so settings.json has nothing of ours and the run takes the
    // "nothing to remove" exit. Whether a hook survives says nothing about whether a
    // link does, and an early exit that skipped these would leave every session loading
    // skills from an app that has been uninstalled.
    runInstaller(path, ["--uninstall"]);

    assert.ok(!existsSync(join(dir, "fleet-alpha")), "the link is removed on the hooks-are-already-gone path");
    assert.ok(existsSync(join(dir, "handmade-skill")), "and still only ours");
  });
});

test("an install leaves the skills directory exactly as it found it", () => {
  withTempSettings(USER_SETTINGS, (path) => {
    const dir = seedSkills(path);
    runInstaller(path);
    // Installing is not a reconcile. Which skills are on is the operator's decision in
    // the panel, applied from the config by the daemon - an installer that added links
    // would switch skills on across every session because someone wired up hooks, and one that
    // removed them would switch them off for the same reason.
    assert.deepEqual(readdirSync(dir).sort(), ["fleet-alpha", "fleet-handmade", "handmade-skill"]);
  });
});

// ---- the transient-checkout guard ----
// An install run from a treehouse pool slot bakes a path the pool will reclaim, and
// when it does, every Claude session on the machine fails every hook event with
// MODULE_NOT_FOUND. That outage is why the guard exists; these tests are its repro.

/**
 * A fake pool slot holding this repo's installer, reached through symlinks.
 *
 * `--preserve-symlinks-main` (see `runFromFakePool`) keeps `import.meta.url` on the
 * symlinked path, so the installer sees itself inside the pool - the exact condition
 * under which the real outage installed - while every one of its imports still
 * resolves into this checkout. Only directory-level links for src/ and node_modules/:
 * child modules load by their realpaths, which is fine, because only the entry
 * point's own location feeds the guard and the baked script path.
 */
function fakePoolInstaller(dir: string): string {
  const repo = join(dir, "pool", "7", "repo");
  mkdirSync(join(repo, "hooks"), { recursive: true });
  writeFileSync(join(dir, "pool", "treehouse-state.json"), "{}\n");
  const checkout = join(import.meta.dirname, "..");
  for (const f of ["install.mjs", "install-checks.mjs"]) {
    symlinkSync(join(checkout, "hooks", f), join(repo, "hooks", f), "file");
  }
  symlinkSync(join(checkout, "src"), join(repo, "src"), "dir");
  symlinkSync(join(checkout, "node_modules"), join(repo, "node_modules"), "dir");
  return join(repo, "hooks", "install.mjs");
}

/** Run the fake-pool installer, capturing stderr; throws with status on refusal. */
function runFromFakePool(settingsPath: string, installer: string, args: string[] = []): string {
  const home = homeDirFor(settingsPath);
  mkdirSync(home, { recursive: true });
  return execFileSync(process.execPath, ["--preserve-symlinks-main", "--import", "tsx", installer, ...args], {
    env: {
      ...process.env,
      CLAUDE_SETTINGS_PATH: settingsPath,
      CLAUDE_SKILLS_DIR: skillsDirFor(settingsPath),
      MISSION_HOME: home,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("refuses to install from a checkout inside a treehouse pool", () => {
  withTempSettings(USER_SETTINGS, (path) => {
    const installer = fakePoolInstaller(join(path, ".."));
    const before = readFileSync(path, "utf8");
    let refusal: (Error & { status?: number; stderr?: string }) | null = null;
    try {
      runFromFakePool(path, installer);
    } catch (err) {
      refusal = err as Error & { status?: number; stderr?: string };
    }
    assert.ok(refusal, "installer must exit non-zero from a pool checkout");
    assert.equal(refusal.status, 1);
    assert.match(String(refusal.stderr), /treehouse worktree pool/);
    assert.match(String(refusal.stderr), /--force/, "the refusal names its own override");
    assert.equal(readFileSync(path, "utf8"), before, "a refused install writes nothing");
  });
});

test("--force overrides the guard, and --uninstall never needs it", () => {
  withTempSettings(USER_SETTINGS, (path) => {
    const installer = fakePoolInstaller(join(path, ".."));
    runFromFakePool(path, installer, ["--force"]);
    const s = parse(readFileSync(path, "utf8")) as any;
    const cmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    assert.ok(
      cmds.some((c: string) => c.includes(join("pool", "7", "repo"))),
      "a forced install bakes exactly the pool path it was warned about",
    );
    // Uninstalling FROM the doomed checkout is what someone abandoning it runs; a
    // guard in the way there would strand the hooks it exists to protect.
    runFromFakePool(path, installer, ["--uninstall"]);
    assert.ok(!readFileSync(path, "utf8").includes(MARKER), "uninstall runs unguarded");
  });
});
