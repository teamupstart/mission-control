import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the package command never invokes electron-builder publishing", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.match(
    manifest.scripts?.package ?? "",
    /\belectron-builder\b.*\s--publish(?:=|\s+)never(?:\s|$)/,
    "packaging a release tag must build the local artifacts without publishing them",
  );
});
