import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  refreshProcessPathFromLoginShell,
  resolveBinPath,
} from "../src/server/util/exec.ts";
import { withProcessEnv } from "./helpers/process-env.ts";

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

  try {
    await withProcessEnv(
      {
        HOME: root,
        PATH: "/usr/bin:/bin",
        SHELL: shell,
        XDG_DATA_HOME: undefined,
        MC_TEST_LOGIN_PATH: `${stale}${delimiter}/usr/bin${delimiter}/bin`,
        MC_TEST_SHELL_LOG: shellLog,
      },
      async () => {
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
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
