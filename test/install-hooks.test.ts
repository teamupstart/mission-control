// The hook installer edits the user's Claude settings.json in place. These tests
// pin the contract that matters: it MERGES (never overwrites) - preserving other
// keys, the user's own hooks, and even comments - and is idempotent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";

const INSTALLER = join(import.meta.dirname, "..", "hooks", "install.mjs");
const MARKER = "harness-hook.mjs";

/** Run the installer against a throwaway settings file and return its text. */
function runInstaller(settingsPath: string, args: string[] = []): void {
  execFileSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, CLAUDE_SETTINGS_PATH: settingsPath },
    stdio: "ignore",
  });
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
