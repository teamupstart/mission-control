import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  refreshProcessPathFromLoginShell,
  resolveBinPath,
} from "../src/server/util/exec.ts";

test("a bare binary installed on the login-shell PATH becomes visible without a daemon restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-login-path-"));
  const stale = join(root, "stale-bin");
  const installed = join(root, "installed-bin");
  const shell = join(root, "login-shell");
  const shellLog = join(root, "login-shell.log");
  const pi = join(installed, "pi");
  mkdirSync(stale);
  mkdirSync(installed);
  writeFileSync(
    shell,
    [
      "#!/bin/sh",
      'printf x >> "$MC_TEST_SHELL_LOG"',
      'printf \'__MISSION_PATH__%s__MISSION_PATH__\' "$MC_TEST_LOGIN_PATH"',
      "",
    ].join("\n"),
  );
  chmodSync(shell, 0o755);
  writeFileSync(pi, "#!/bin/sh\nexit 0\n");
  chmodSync(pi, 0o755);

  const original = {
    path: process.env.PATH,
    shell: process.env.SHELL,
    loginPath: process.env.MC_TEST_LOGIN_PATH,
    shellLog: process.env.MC_TEST_SHELL_LOG,
  };
  try {
    process.env.SHELL = shell;
    process.env.PATH = "/usr/bin:/bin";
    process.env.MC_TEST_LOGIN_PATH = `${stale}${delimiter}/usr/bin${delimiter}/bin`;
    process.env.MC_TEST_SHELL_LOG = shellLog;

    assert.deepEqual(
      await Promise.all([
        resolveBinPath("pi"),
        resolveBinPath("missing-terminal-one"),
        resolveBinPath("missing-terminal-two"),
      ]),
      [null, null, null],
    );
    assert.equal(readFileSync(shellLog, "utf8"), "x", "one batch shares one shell probe");

    assert.equal(await resolveBinPath("another-missing-terminal"), null);
    assert.equal(await resolveBinPath("pi"), null);
    assert.equal(readFileSync(shellLog, "utf8"), "x", "repeated misses stay on cooldown");

    process.env.MC_TEST_LOGIN_PATH = `${installed}${delimiter}/usr/bin${delimiter}/bin`;
    await refreshProcessPathFromLoginShell({ force: true });
    assert.equal(await resolveBinPath("pi"), pi);
    assert.equal((process.env.PATH ?? "").split(delimiter).includes(installed), true);
    assert.equal(readFileSync(shellLog, "utf8"), "xx", "an explicit re-check forces one read");
  } finally {
    if (original.path === undefined) delete process.env.PATH;
    else process.env.PATH = original.path;
    if (original.shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = original.shell;
    if (original.loginPath === undefined) delete process.env.MC_TEST_LOGIN_PATH;
    else process.env.MC_TEST_LOGIN_PATH = original.loginPath;
    if (original.shellLog === undefined) delete process.env.MC_TEST_SHELL_LOG;
    else process.env.MC_TEST_SHELL_LOG = original.shellLog;
    rmSync(root, { recursive: true, force: true });
  }
});
