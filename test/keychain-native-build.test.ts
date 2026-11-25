import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { keychainBuildTarget } from "../scripts/build-keychain-native.mjs";

test("the native Keychain addon builds for both macOS host architectures", () => {
  assert.deepEqual(keychainBuildTarget("darwin", "arm64"), { kind: "build", arch: "arm64" });
  assert.deepEqual(keychainBuildTarget("darwin", "x64"), { kind: "build", arch: "x64" });
});

test("the native Keychain addon is a successful no-op away from macOS", () => {
  assert.deepEqual(keychainBuildTarget("linux", "x64"), { kind: "skip", platform: "linux" });
  assert.deepEqual(keychainBuildTarget("linux", "arm64"), { kind: "skip", platform: "linux" });
  assert.deepEqual(keychainBuildTarget("win32", "x64"), { kind: "skip", platform: "win32" });
});

test("an unknown Darwin architecture is refused instead of mislabeled", () => {
  assert.throws(() => keychainBuildTarget("darwin", "riscv64"), /Darwin riscv64/);
});

test("npm run build:native builds the Keychain addon", () => {
  const source = readFileSync(new URL("../scripts/build-native.mjs", import.meta.url), "utf8");
  assert.match(source, /"build-keychain-native\.mjs"/);
});
