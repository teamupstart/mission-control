import assert from "node:assert/strict";
import test from "node:test";
import { isNewerVersion } from "../src/shared/update.ts";

test("only strictly newer versions are eligible with or without a leading v", () => {
  const candidates = ["1.2.4", "v1.2.4", "1.2.3", "v1.2.3", "1.2.2", "v1.2.2"];

  assert.deepEqual(
    candidates.map((candidate) => isNewerVersion("1.2.3", candidate)),
    [true, true, false, false, false, false],
  );
});
