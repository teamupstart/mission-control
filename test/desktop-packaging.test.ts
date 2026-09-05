import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the package command builds mac artifacts without publishing", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(
    manifest.scripts?.package,
    "npm run build && electron-builder --mac --publish never",
    "packaging a release tag must build the local artifacts without publishing them",
  );
});
