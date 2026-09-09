import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  refreshProcessPathFromLoginShell,
  resolveBinPath,
  run,
} from "../src/server/util/exec.ts";
import { withProcessEnv } from "./helpers/process-env.ts";

/**
 * A command name no machine can already have, which is what makes this test about the
 * daemon rather than about the developer.
 *
 * It used to be `pi`. The lookup ladder's last rung is the platform's OS defaults -
 * `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and friends - and that rung is
 * unconditional by design, because the daemon must find a tool a login shell forgot to
 * export. So every `resolveBinPath("pi") === null` below was really asserting "the person
 * running this suite has not installed Pi": true on CI, false on a laptop that has, where
 * this failed against a real binary at /opt/homebrew/bin/pi.
 *
 * Nothing the test is about is lost. Its subject is the probe/cooldown/refresh cycle, which
 * `commandSpec` runs identically for a catalog id and an operator command - and every other
 * name in this case was already an ad hoc one. The CATALOG spec's extra rungs (supported
 * locations, per-tool overrides, dropEnv) are covered rung by rung in
 * `test/executable-locator.test.ts`, which injects a root-confined lookup for this same reason.
 */
const FIXTURE_BIN = "mission-test-agent";

test("a bare binary installed on the login-shell PATH becomes visible without a daemon restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-login-path-"));
  const stale = join(root, "stale-bin");
  const installed = join(root, "installed-bin");
  const shell = join(root, "login-shell");
  const shellLog = join(root, "login-shell.log");
  const agent = join(installed, FIXTURE_BIN);
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
  writeFileSync(agent, "#!/bin/sh\nexit 0\n");
  chmodSync(agent, 0o755);

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
            resolveBinPath(FIXTURE_BIN),
            resolveBinPath("missing-terminal-one"),
            resolveBinPath("missing-terminal-two"),
          ]),
          [null, null, null],
        );
        assert.equal(readFileSync(shellLog, "utf8"), "xx", "one batch shares initialization and first-miss probes");

        assert.equal(await resolveBinPath("another-missing-terminal"), null);
        assert.equal(await resolveBinPath(FIXTURE_BIN), null);
        assert.equal(readFileSync(shellLog, "utf8"), "xx", "repeated misses stay on cooldown");

        process.env.MC_TEST_LOGIN_PATH = `${installed}${delimiter}/usr/bin${delimiter}/bin`;
        await refreshProcessPathFromLoginShell({ force: true });
        assert.equal(await resolveBinPath(FIXTURE_BIN), agent);
        assert.equal((process.env.PATH ?? "").split(delimiter).includes(installed), true);
        assert.equal(readFileSync(shellLog, "utf8"), "xxx", "an explicit re-check forces one read");
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run uses the catalog child environment for terminal-specific scrubbing", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-run-drop-env-"));
  const cmux = join(root, "cmux");
  writeFileSync(
    cmux,
    [
      "#!/bin/sh",
      'printf "%s|%s|%s" "$CMUX_WORKSPACE_ID" "$CMUX_SURFACE_ID" "$CMUX_TAB_ID"',
      "",
    ].join("\n"),
  );
  chmodSync(cmux, 0o755);

  try {
    await withProcessEnv(
      {
        MISSION_CMUX_BIN: cmux,
        CMUX_WORKSPACE_ID: "workspace",
        CMUX_SURFACE_ID: "surface",
        CMUX_TAB_ID: "tab",
      },
      async () => {
        const result = await run("cmux", [], { env: { ...process.env } });
        assert.equal(result.code, 0);
        assert.equal(result.stdout, "||");
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run resolves and launches a bare command from the explicit child PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-run-child-path-"));
  const binDir = join(root, "bin");
  const node = join(binDir, "node");
  mkdirSync(binDir);
  writeFileSync(node, "#!/bin/sh\nprintf '%s\\n%s\\n' \"$0\" \"$PATH\"\n");
  chmodSync(node, 0o755);

  try {
    await withProcessEnv(
      {
        MISSION_NODE_BIN: undefined,
        FLEET_NODE_BIN: undefined,
        HARNESS_NODE_BIN: undefined,
      },
      async () => {
        const result = await run("node", ["-p", "process.execPath"], {
          env: { ...process.env, PATH: binDir },
        });
        assert.equal(result.code, 0);
        assert.deepEqual(result.stdout.trim().split("\n"), [node, binDir]);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("relative command paths resolve absolutely and execute from the requested cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-run-relative-path-"));
  const canonicalRoot = realpathSync(root);
  const binDir = join(canonicalRoot, "bin");
  const tool = join(binDir, "local-tool");
  const previousCwd = process.cwd();
  mkdirSync(binDir);
  writeFileSync(tool, "#!/bin/sh\nprintf '%s\\n%s\\n' \"$0\" \"$PWD\"\n");
  chmodSync(tool, 0o755);

  try {
    process.chdir(canonicalRoot);
    assert.equal(await resolveBinPath("./bin/local-tool"), tool);
    process.chdir(previousCwd);

    const result = await run("bin/local-tool", [], { cwd: canonicalRoot });
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdout.trim().split("\n"), [tool, canonicalRoot]);
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
