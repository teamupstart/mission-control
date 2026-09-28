import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { refreshProcessPathFromLoginShell, run } from "../src/server/util/exec.ts";
import { withProcessEnv } from "./helpers/process-env.ts";

function script(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

test("run passes manager precedence through to child hooks with env shebangs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-hook-path-"));
  // A unique interpreter name models the system Ruby collision without running host Ruby.
  const interpreter = "mission-test-hook-runtime";
  const inherited = join(root, "system-bin");
  script(join(inherited, interpreter), "#!/bin/sh\nprintf 'system runtime has no hook gems' >&2\nexit 64\n");
  const runner = script(join(root, "hook-runner"), '#!/bin/sh\n"$1"\n');
  const hook = script(join(root, "post-checkout"), `#!/usr/bin/env ${interpreter}\n`);
  try {
    await withProcessEnv({
      HOME: root,
      PATH: [inherited, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
      SHELL: join(root, "missing-login-shell"),
      MISSION_EXECUTABLE_PATHS: undefined,
      FLEET_EXECUTABLE_PATHS: undefined,
      HARNESS_EXECUTABLE_PATHS: undefined,
      XDG_DATA_HOME: undefined,
      MISE_DATA_DIR: undefined,
      MISE_SHIMS_DIR: undefined,
      ASDF_DATA_DIR: undefined,
      VOLTA_HOME: undefined,
    }, async () => {
      for (const location of [
        [".local", "share", "mise", "shims"],
        [".asdf", "shims"],
        [".volta", "bin"],
      ]) {
        await t.test(location.join("/"), async () => {
          const shim = script(join(root, ...location, interpreter), "#!/bin/sh\nprintf 'managed runtime\\n'\n");
          try {
            await refreshProcessPathFromLoginShell({ force: true });
            const result = await run(runner, [hook], { cwd: root });
            assert.equal(result.code, 0, result.stderr);
            assert.equal(result.stdout, "managed runtime\n");
            assert.equal(result.outcomeUnknown, false);
          } finally {
            unlinkSync(shim);
          }
        });
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
