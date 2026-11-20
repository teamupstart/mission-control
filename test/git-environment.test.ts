import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { bypassXcrunGitShim, developerDirectory, disableAutoMaintenance } from "./git-environment.mjs";

test("auto maintenance is disabled by appending to the environment's own git config", () => {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.editor", GIT_CONFIG_VALUE_0: "true" };
  disableAutoMaintenance(env);
  assert.deepEqual(env, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.editor", GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_KEY_1: "maintenance.auto", GIT_CONFIG_VALUE_1: "false",
  });
});

test("a test worker's commits start no `git maintenance` child", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "mission-git-environment-"));
  const trace = mkdtempSync(join(tmpdir(), "mission-git-environment-trace-"));
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(trace, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@test", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], {
    env: { ...process.env, GIT_TRACE2_EVENT: trace },
  });
  // One trace file per git process: the commit, and nothing it started.
  assert.equal(readdirSync(trace).length, 1);
});

test("the xcrun shim bypass is a no-op where git is not Apple's shim", () => {
  const env: NodeJS.ProcessEnv = { PATH: ["/nonexistent", "/also-missing"].join(delimiter) };
  bypassXcrunGitShim(env);
  assert.equal(env.PATH, ["/nonexistent", "/also-missing"].join(delimiter));
});

test("an empty PATH component is the current directory, so a git there keeps the shim bypass off", { skip: process.platform !== "darwin" }, (t) => {
  // `PATH=:/usr/bin` makes a shell run `./git` before Apple's. Reading that as "the first git is
  // /usr/bin/git" would put the developer-directory git in front of the one this PATH selects.
  const cwd = process.cwd();
  const here = mkdtempSync(join(tmpdir(), "mission-git-environment-cwd-"));
  t.after(() => {
    process.chdir(cwd);
    rmSync(here, { recursive: true, force: true });
  });
  writeFileSync(join(here, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.chdir(here);
  const env: NodeJS.ProcessEnv = { PATH: `${delimiter}/usr/bin` };
  bypassXcrunGitShim(env);
  assert.equal(env.PATH, `${delimiter}/usr/bin`);
});

test("the developer directory follows xcode-select's precedence and matches xcrun", { skip: process.platform !== "darwin" }, () => {
  const none = () => { throw new Error("no selection"); };
  assert.equal(developerDirectory({ DEVELOPER_DIR: "/chosen" }, () => true, none), "/chosen");
  // An app bundle, as `xcode-select --switch /Applications/Xcode.app` and DEVELOPER_DIR allow.
  assert.equal(developerDirectory({ DEVELOPER_DIR: "/Applications/Xcode.app" }, () => true, none), "/Applications/Xcode.app/Contents/Developer");
  assert.equal(developerDirectory({}, () => true, () => "/Applications/Xcode-beta.app"), "/Applications/Xcode-beta.app/Contents/Developer");
  assert.equal(developerDirectory({}, () => true, () => "/Applications/Beta.app/Contents/Developer"), "/Applications/Beta.app/Contents/Developer");
  assert.equal(developerDirectory({}, (path) => path.startsWith("/Library/"), none), "/Library/Developer/CommandLineTools");
  assert.equal(developerDirectory({}, () => false, none), null);
  // And on this machine, the git it names is the one Apple's own lookup names.
  const xcrun = spawnSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8" });
  if (xcrun.status === 0) assert.equal(join(developerDirectory()!, "usr", "bin", "git"), xcrun.stdout.trim());
});

test("on a Mac whose git is the xcrun shim, workers run the real git with its own layout", { skip: process.platform !== "darwin" }, (t) => {
  const env: NodeJS.ProcessEnv = { PATH: ["/usr/bin", "/bin"].join(delimiter) };
  bypassXcrunGitShim(env);
  const [prefixBin] = (env.PATH ?? "").split(delimiter);
  if (prefixBin === "/usr/bin") return t.skip("no developer-directory git to run directly");
  assert.deepEqual(readdirSync(prefixBin!), ["git"], "only git is shadowed");

  // The same git: version, helpers and templates resolve as they do through the shim.
  const run = (args: string[]) => spawnSync("git", args, { env: { ...process.env, PATH: env.PATH }, encoding: "utf8" });
  assert.equal(run(["--version"]).stdout, spawnSync("/usr/bin/git", ["--version"], { encoding: "utf8" }).stdout);
  assert.ok(existsSync(join(run(["--exec-path"]).stdout.trim(), "git-upload-pack")));
  const repo = mkdtempSync(join(tmpdir(), "mission-git-environment-layout-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  assert.equal(run(["init", "-q", repo]).status, 0);
  assert.ok(readdirSync(join(repo, ".git", "hooks")).length > 0, "the default template was found");
});
