import assert from "node:assert/strict";
import test from "node:test";

import { stateLockBuildTarget } from "../scripts/build-state-lock-native.mjs";
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
