import assert from "node:assert/strict";
import test from "node:test";

import { nativeBuildTarget } from "../scripts/build-keep-awake-native.mjs";

test("native Keep Awake builds for both macOS host architectures", () => {
  assert.deepEqual(nativeBuildTarget("darwin", "arm64"), { kind: "build", arch: "arm64" });
  assert.deepEqual(nativeBuildTarget("darwin", "x64"), { kind: "build", arch: "x64" });
});

test("native Keep Awake remains a successful no-op away from macOS", () => {
  assert.deepEqual(nativeBuildTarget("linux", "x64"), { kind: "skip", platform: "linux" });
});

test("an unknown Darwin architecture is refused instead of mislabeled", () => {
  assert.throws(() => nativeBuildTarget("darwin", "riscv64"), /Darwin riscv64/);
});
