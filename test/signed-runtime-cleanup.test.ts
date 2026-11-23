import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { binaryPublisherPolicy } from "../src/shared/binary-publisher-policy.mjs";
import type { BinaryBuildMetadata } from "../src/shared/binary-distribution.mjs";
import { qualifySignedRuntime } from "../scripts/qualify-signed-runtime.mjs";

for (const cleanupFails of [false, true]) {
  test(`signed-runtime qualification preserves the original failure when cleanup ${cleanupFails ? "also fails" : "succeeds"}`, async (t) => {
    const original = new Error("fixture copy failed");
    let root = "";
    t.mock.method(childProcess, "execFileSync", (_command: string, args: string[]) => {
      root = dirname(args[2]!);
      if (cleanupFails) {
        const attempt = join(root, "state/update-runtimes/attempt");
        mkdirSync(attempt, { recursive: true });
        writeFileSync(join(attempt, "owner.json"), "{}");
      }
      throw original;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (root) rmSync(root, { recursive: true, force: true });
    });
    const metadata: BinaryBuildMetadata = {
      protocol: 1, receiptSchema: 2, repo: "fixture/repo", channel: "stable", releaseTag: "v1.0.0",
      version: "1.0.0", commit: "a".repeat(40), platform: "darwin", arch: "arm64",
      bundleId: "fixture.app", minimumSystemVersion: "14.0", helperProtocol: { min: 1, max: 1 },
    };
    await assert.rejects(qualifySignedRuntime("/fixture/app", metadata, binaryPublisherPolicy()), (error: unknown) => {
      if (cleanupFails) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], original);
        assert.match(error.errors[1].message, /helper ownership is unknown/);
        assert.ok(existsSync(root), "an unowned runtime must be retained");
      } else {
        assert.equal(error, original);
        assert.equal(existsSync(root), false, "successful cleanup removes the probe directory");
      }
      return true;
    });
  });
}
