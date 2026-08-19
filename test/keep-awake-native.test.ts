import assert from "node:assert/strict";
import test from "node:test";

import {
  nativeKeepAwakeAddonPath,
  validateNativeKeepAwakeBinding,
} from "../src/server/keep-awake-native.ts";

test("native loader resolves the same dist artifact from source and bundled module URLs", () => {
  assert.equal(
    nativeKeepAwakeAddonPath("file:///repo/dist/server/index.mjs"),
    nativeKeepAwakeAddonPath("file:///repo/src/server/keep-awake-native.ts"),
  );
});

test("native loader rejects a module without both lifecycle functions", () => {
  assert.throws(
    () => validateNativeKeepAwakeBinding({ create: () => ({}) }),
    /must export create and release functions/,
  );
});

test("native loader accepts a side-effect-free create and release surface", () => {
  const binding = { create: () => ({}), release: () => {} };
  assert.equal(validateNativeKeepAwakeBinding(binding), binding);
});
