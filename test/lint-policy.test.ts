import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { tempDir } from "./temp-root.mjs";

function lint(source: string, extension = "ts") {
  const root = tempDir("mission-lint-policy-");
  try {
    const file = join(root, `fixture.${extension}`);
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [
      resolve("node_modules/oxlint/bin/oxlint"), "--config", resolve(".oxlintrc.json"),
      "--no-ignore", "--format", "json", file,
    ], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return { status: result.status, diagnostics: JSON.parse(result.stdout).diagnostics as Array<{ code: string; severity: string }> };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("lint rejects correctness defects and accepts valid console output", () => {
  const bad = lint("const x = 1; x = 2; debugger;");
  assert.equal(bad.status, 1);
  assert.ok(bad.diagnostics.some((d) => d.code === "eslint(no-debugger)" && d.severity === "error"));
  assert.ok(bad.diagnostics.some((d) => d.code === "eslint(no-const-assign)" && d.severity === "error"));
  assert.equal(lint('console.log("CLI output");').status, 0);
});

test("hooks and accessibility remain warnings, with noisy role preference excluded", () => {
  const result = lint(`import { useEffect } from "react";
export function Example({ enabled }: { enabled: boolean }) {
  if (enabled) useEffect(() => {}, []);
  return <div role="button"><img src="image.png" /></div>;
}`, "tsx");
  assert.equal(result.status, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "react-hooks(rules-of-hooks)"));
  assert.ok(result.diagnostics.some((d) => d.code === "jsx-a11y(alt-text)"));
  assert.ok(result.diagnostics.every((d) => d.severity === "warning"));
  assert.ok(result.diagnostics.every((d) => d.code !== "jsx-a11y(prefer-tag-over-role)"));
});

test("control-byte exceptions do not disable the rule for other files", () => {
  const result = lint('export const accidentalControl = /\\x00/;');
  assert.equal(result.status, 1);
  assert.ok(result.diagnostics.some((d) => d.code === "eslint(no-control-regex)" && d.severity === "error"));
});
