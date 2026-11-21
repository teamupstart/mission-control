import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mission-go-cache-test-"));
process.env.MISSION_HOME = join(root, "operator-state");
process.env.TMPDIR = root;
delete process.env.GOCACHE;
const { agentSubprocessEnv, cleanupAgentSubprocessEnv, isolatedAgentArgv } =
  await import("../src/server/agent-subprocess-env.ts");
const { codexAppServerEnv } = await import("../src/server/harness/codex/sdk-deps.ts");
const { sdkSubprocessEnv } = await import("../src/server/harness/claude/sdk-deps.ts");
after(() => rmSync(root, { recursive: true, force: true }));

test("Codex and Claude launches share a writable Go cache outside disposable session homes", () => {
  const first = codexAppServerEnv({}, join(root, "first"));
  const second = codexAppServerEnv({}, join(root, "second"));
  const claude = sdkSubprocessEnv({}, join(root, "third"));
  try {
    assert.ok(first.GOCACHE, "a fresh session must not fall back to the unwritable OS cache");
    assert.ok(isAbsolute(first.GOCACHE));
    assert.ok(!relative(root, first.GOCACHE).startsWith(".."), "the cache is under the writable temp root");
    assert.equal(second.GOCACHE, first.GOCACHE);
    assert.equal(claude.GOCACHE, first.GOCACHE);
    assert.equal(statSync(first.GOCACHE).mode & 0o777, 0o700);
    assert.notEqual(first.MISSION_HOME, second.MISSION_HOME);
    // Stand in for Go initializing and populating its own cache.
    mkdirSync(first.GOCACHE, { recursive: true });
    writeFileSync(join(first.GOCACHE, "cached-build"), "warm");
    cleanupAgentSubprocessEnv(first);
    cleanupAgentSubprocessEnv(second);
    assert.equal(readFileSync(join(first.GOCACHE, "cached-build"), "utf8"), "warm");
    const resumed = codexAppServerEnv({}, join(root, "resumed"));
    try { assert.equal(resumed.GOCACHE, first.GOCACHE); }
    finally { cleanupAgentSubprocessEnv(resumed); }
  } finally {
    for (const env of [first, second, claude]) cleanupAgentSubprocessEnv(env);
  }
});

test("a missing shared cache is recreated, but a symlink cannot redirect it", () => {
  const first = agentSubprocessEnv({});
  const cache = first.GOCACHE!;
  cleanupAgentSubprocessEnv(first);
  rmSync(cache, { recursive: true });
  const recreated = agentSubprocessEnv({});
  try { assert.ok(statSync(cache).isDirectory()); }
  finally { cleanupAgentSubprocessEnv(recreated); }
  rmSync(cache, { recursive: true });
  const target = join(root, "unrelated");
  mkdirSync(target);
  symlinkSync(target, cache);
  try {
    assert.throws(() => agentSubprocessEnv({}), /not an owned directory/);
    const explicit = agentSubprocessEnv({ GOCACHE: "off" });
    cleanupAgentSubprocessEnv(explicit);
  } finally { rmSync(cache); }
});

test("a shared cache directory owned by another user is rejected", { skip: userInfo().uid === -1 }, (t) => {
  const first = agentSubprocessEnv({});
  const cache = first.GOCACHE!;
  cleanupAgentSubprocessEnv(first);
  const lstat = fs.lstatSync;
  // Keep a real directory and change only its reported owner, without privileged chown.
  const foreignOwner = t.mock.method(fs, "lstatSync", (path: fs.PathLike) => {
    const info = lstat(path);
    if (String(path) === cache) {
      assert.ok(info.isDirectory());
      assert.equal(info.uid, userInfo().uid);
      info.uid += 1;
    }
    return info;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => agentSubprocessEnv({}), {
      name: "Error",
      message: `Go build cache is not an owned directory: ${cache}`,
    });
    assert.equal(foreignOwner.mock.callCount(), 1);
  } finally {
    foreignOwner.mock.restore();
    syncBuiltinESMExports();
  }
});

test("explicit Go cache settings win, including off; an empty value gets the default", () => {
  for (const value of [join(root, "custom cache"), "off"]) {
    const env = codexAppServerEnv({ GOCACHE: value }, root);
    const extra = agentSubprocessEnv({ GOCACHE: "inherited" }, { extraEnv: { GOCACHE: value } });
    try {
      assert.equal(env.GOCACHE, value);
      assert.equal(extra.GOCACHE, value);
    } finally {
      cleanupAgentSubprocessEnv(env);
      cleanupAgentSubprocessEnv(extra);
    }
  }
  const empty = agentSubprocessEnv({ GOCACHE: "" });
  try { assert.ok(empty.GOCACHE); }
  finally { cleanupAgentSubprocessEnv(empty); }
});

test("terminal wrappers reuse the SDK cache and preserve the terminal's explicit override", () => {
  const sdk = codexAppServerEnv({}, root);
  try {
    for (const inherited of [undefined, "", join(root, "shell cache 'quoted'"), "off"]) {
      const argv = isolatedAgentArgv([process.execPath, "-e", "process.stdout.write(process.env.GOCACHE ?? '')"]);
      const output = execFileSync(argv[0]!, argv.slice(1), {
        encoding: "utf8", env: { ...process.env, GOCACHE: inherited },
      });
      assert.ok(output);
      assert.equal(output, inherited || sdk.GOCACHE);
      assert.equal(existsSync(dirname(argv[1]!)), false, "session cleanup still runs");
    }
    const argv = isolatedAgentArgv([process.execPath, "-e", "process.stdout.write(process.env.GOCACHE ?? '')"],
      { extraEnv: { GOCACHE: "off" } });
    assert.equal(execFileSync(argv[0]!, argv.slice(1), {
      encoding: "utf8", env: { ...process.env, GOCACHE: "shell-setting" },
    }), "off", "an explicit launch override wins over the shell");
    process.env.GOCACHE = join(root, "daemon cache");
    try {
      const fromDaemon = isolatedAgentArgv([process.execPath, "-e", "process.stdout.write(process.env.GOCACHE ?? '')"]);
      assert.equal(execFileSync(fromDaemon[0]!, fromDaemon.slice(1), {
        encoding: "utf8", env: { ...process.env, GOCACHE: undefined },
      }), process.env.GOCACHE);
    } finally { delete process.env.GOCACHE; }
  } finally { cleanupAgentSubprocessEnv(sdk); }
});
