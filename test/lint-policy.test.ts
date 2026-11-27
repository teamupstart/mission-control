import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function lint(source: string, extension = "ts") {
  const root = mkdtempSync(join(tmpdir(), "mission-lint-policy-"));
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

test("hooks and accessibility findings fail lint, with noisy role preference excluded", () => {
  const result = lint(`import { useEffect } from "react";
export function Example({ enabled }: { enabled: boolean }) {
  if (enabled) useEffect(() => {}, []);
  return <div role="button"><img src="image.png" /></div>;
}`, "tsx");
  assert.equal(result.status, 1);
  assert.ok(result.diagnostics.some((d) => d.code === "react-hooks(rules-of-hooks)"));
  assert.ok(result.diagnostics.some((d) => d.code === "jsx-a11y(alt-text)"));
  assert.ok(result.diagnostics.every((d) => d.severity === "error"));
  assert.ok(result.diagnostics.every((d) => d.code !== "jsx-a11y(prefer-tag-over-role)"));
});

test("control-byte exceptions do not disable the rule for other files", () => {
  const result = lint('export const accidentalControl = /\\x00/;');
  assert.equal(result.status, 1);
  assert.ok(result.diagnostics.some((d) => d.code === "eslint(no-control-regex)" && d.severity === "error"));
});

test("a labelled scroll region may keep its tab stop; a bare one may not", () => {
  const region = lint('export const R = () => <div role="region" aria-label="Output" tabIndex={0}>x</div>;', "tsx");
  assert.equal(region.status, 0);
  const bare = lint("export const B = () => <span tabIndex={0}>x</span>;", "tsx");
  assert.equal(bare.status, 1);
  assert.ok(bare.diagnostics.some((d) => d.code === "jsx-a11y(no-noninteractive-tabindex)"));
});

test("an exhaustive-deps finding fails lint", () => {
  const result = lint(`import { useEffect } from "react";
export function Example({ id, load }: { id: string; load: (id: string) => void }) {
  useEffect(() => load(id), []);
  return null;
}`, "tsx");
  assert.equal(result.status, 1);
  assert.ok(result.diagnostics.some((d) => d.code === "react-hooks(exhaustive-deps)" && d.severity === "error"));
});
