import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { tempDir } from "./temp-root.mjs";

test("awaiting the native drag before teardown waits for mouse-up", { skip: process.platform !== "darwin" }, async t => {
  const directory = tempDir("window-drag-test-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const addon = join(directory, "drag.node");
  execFileSync("xcrun", ["clang++", "-std=c++17", "-bundle", "-undefined", "dynamic_lookup",
    "-framework", "AppKit", "-I", resolve(process.execPath, "../../include/node"),
    "test/fixtures/window-drag-release.mm", "-o", addon]);
  const drag = createRequire(import.meta.url)(addon) as {
    start(): Promise<true>; released(): boolean; failReleaseCreation(): Promise<true>;
  };
  assert.equal(await drag.start(), true);
  assert.equal(drag.released(), true, "teardown can begin only after mouse-up was posted");
  await t.test("an allocation failure on mouse-up rejects before posting mouse-down", async () => {
    await assert.rejects(drag.failReleaseCreation(), /Could not create native drag event/);
    assert.equal(drag.released(), true, "the previous mouse-up must still be the last posted event");
  });
});
