import assert from "node:assert/strict";
import test from "node:test";

import {
  clearDarwinProvenance,
  stateLockBuildTarget,
} from "../scripts/build-state-lock-native.mjs";
import {
  nativeStateLockAddonPath,
  validateNativeStateLockBinding,
} from "../src/server/state-ownership-native.ts";

test("the state ownership addon builds for the shipped daemon platforms", () => {
  assert.deepEqual(stateLockBuildTarget("darwin", "arm64"), {
    platform: "darwin",
    arch: "arm64",
  });
  assert.deepEqual(stateLockBuildTarget("darwin", "x64"), {
    platform: "darwin",
    arch: "x64",
  });
  assert.deepEqual(stateLockBuildTarget("linux", "x64"), {
    platform: "linux",
    arch: "x64",
  });
});

test("unsupported state ownership addon targets fail at build time", () => {
  assert.throws(() => stateLockBuildTarget("win32", "x64"), /does not support win32 x64/);
  assert.throws(() => stateLockBuildTarget("darwin", "riscv64"), /does not support darwin riscv64/);
});

test("the Darwin build removes inherited provenance from the copied addon", () => {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const execute = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
  }) as typeof import("node:child_process").execFileSync;

  assert.equal(clearDarwinProvenance("/dist/state-lock.node", "darwin", execute), true);
  assert.deepEqual(calls, [
    {
      bin: "/usr/bin/xattr",
      args: ["-d", "com.apple.provenance", "/dist/state-lock.node"],
    },
  ]);
  assert.equal(clearDarwinProvenance("/dist/state-lock.node", "linux", execute), false);
  assert.equal(calls.length, 1);
});

test("an already-clean Darwin addon is success, but another xattr failure is fatal", () => {
  const missing = (() => {
    throw Object.assign(new Error("No such xattr"), {
      status: 1,
      stderr: "xattr: /dist/state-lock.node: No such xattr: com.apple.provenance\n",
    });
  }) as typeof import("node:child_process").execFileSync;
  const denied = (() => {
    throw Object.assign(new Error("permission denied"), {
      status: 1,
      stderr: "xattr: /dist/state-lock.node: Permission denied\n",
    });
  }) as typeof import("node:child_process").execFileSync;

  assert.equal(clearDarwinProvenance("/dist/state-lock.node", "darwin", missing), false);
  assert.throws(
    () => clearDarwinProvenance("/dist/state-lock.node", "darwin", denied),
    /permission denied/,
  );
});

test("the native state lock resolves identically from source and bundle locations", () => {
  assert.equal(
    nativeStateLockAddonPath("file:///repo/src/server/state-ownership-native.ts"),
    nativeStateLockAddonPath("file:///repo/dist/server/index.mjs"),
  );
});

test("the native state lock requires both lifecycle functions", () => {
  assert.throws(
    () => validateNativeStateLockBinding({ acquire: () => ({}) }),
    /must export acquire and release functions/,
  );
  const binding = { acquire: () => ({}), release: () => {} };
  assert.equal(validateNativeStateLockBinding(binding), binding);
});
