import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { withProcessEnv } from "./helpers/process-env.ts";

const home = mkdtempSync(join(tmpdir(), "mission-version-manager-path-"));
process.env.HARNESS_HOME = join(home, "state");

test("mise, relocated asdf, and relocated Volta shims survive login-shell failure", async () => {
  const miseShimDir = join(home, ".local", "share", "mise", "shims");
  const asdfDataDir = join(home, "tool-data", "asdf");
  const asdfShimDir = join(asdfDataDir, "shims");
  const voltaHome = join(home, "tool-data", "volta");
  const voltaBinDir = join(voltaHome, "bin");
  const misePi = join(miseShimDir, "pi");
  const asdfPi = join(asdfShimDir, "pi");
  const voltaPi = join(voltaBinDir, "pi");
  for (const pi of [misePi, asdfPi, voltaPi]) {
    mkdirSync(dirname(pi), { recursive: true });
    writeFileSync(pi, "#!/bin/sh\nexit 0\n");
    chmodSync(pi, 0o755);
  }

  try {
    await withProcessEnv(
      {
        HOME: home,
        PATH: "/usr/bin:/bin",
        SHELL: join(home, "missing-login-shell"),
        XDG_DATA_HOME: undefined,
        ASDF_DATA_DIR: asdfDataDir,
        VOLTA_HOME: voltaHome,
      },
      async () => {
        const { resolveBinPath } = await import("../src/server/util/exec.ts");
        assert.equal(await resolveBinPath("pi"), misePi);
        unlinkSync(misePi);
        assert.equal(await resolveBinPath("pi"), asdfPi);
        unlinkSync(asdfPi);
        assert.equal(await resolveBinPath("pi"), voltaPi);
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
