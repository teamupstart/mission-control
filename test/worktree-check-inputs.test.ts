// A clean Git status must not vouch for ignored source left in a reusable check slot.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { inspectPooledCheckInputs } from "../src/server/worktrees/check-inputs.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";

function fixture(t: TestContext) {
  const repo = mkOriginAndClone("mission-check-inputs-");
  t.after(() => rmSync(repo.root, { recursive: true, force: true }));
  writeFileSync(join(repo.clone, ".gitignore"), ".local/\n.pipeline/\ndeps/\n*.go\n");
  gitIn(repo.clone, "add", ".gitignore");
  gitIn(repo.clone, "commit", "-qm", "ignore fixtures");
  return repo.clone;
}

test("tracked Go and ignored non-source caches do not contaminate a check", async (t) => {
  const path = fixture(t);
  writeFileSync(join(path, "main.go"), "package main\n");
  gitIn(path, "add", "-f", "main.go");
  gitIn(path, "commit", "-qm", "tracked Go");
  mkdirSync(join(path, "deps"));
  writeFileSync(join(path, "deps/cache"), "warm");
  assert.deepEqual(await inspectPooledCheckInputs(path), { ok: true });
  assert.equal(readFileSync(join(path, "deps/cache"), "utf8"), "warm");
});

test("ignored source is detected anywhere, including dependencies, with bounded quoted diagnostics", async (t) => {
  const path = fixture(t);
  mkdirSync(join(path, "deps"));
  for (let i = 0; i < 12; i++) writeFileSync(join(path, `deps/${String(i).padStart(2, "0")}.go`), "package old\n");
  // Sort the unusual filename into the sample so escaping is actually observable.
  writeFileSync(join(path, "00-line\nbreak.go"), "package old\n");
  const result = await inspectPooledCheckInputs(path);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.category, "state");
  assert.match(result.reason, /13 ignored Go source/);
  assert.ok(result.reason.includes('"00-line\\nbreak.go"'), "the filename newline must be escaped");
  assert.equal(result.reason.includes("\n"), false, "a filename must not introduce a raw diagnostic line");
  assert.deepEqual(result.reason.match(/"[^"]*"/g), [
    '"00-line\\nbreak.go"',
    '"deps/00.go"', '"deps/01.go"', '"deps/02.go"', '"deps/03.go"',
    '"deps/04.go"', '"deps/05.go"', '"deps/06.go"',
  ], "the diagnostic must list exactly the first eight paths, stopping before deps/07.go");
  assert.doesNotMatch(result.reason, /deps\/(?:07|08|09|10|11)\.go/);
  assert.match(result.reason, /\.\.\./);
  assert.ok(result.reason.length < 2500);
  assert.equal(readFileSync(join(path, "00-line\nbreak.go"), "utf8"), "package old\n");
});

test("an unreadable checkout is an observation failure, never clean", async (t) => {
  const path = fixture(t);
  const result = await inspectPooledCheckInputs(join(path, "missing"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.category, "observation");
  assert.match(result.reason, /inspection could not complete/);
});

test("an unreadable ignored directory rejects Git's successful but incomplete scan", async (t) => {
  const path = fixture(t);
  const hidden = join(path, ".local");
  mkdirSync(hidden);
  writeFileSync(join(hidden, "diagnostic.go"), "package old\n");
  chmodSync(hidden, 0);
  try {
    const result = await inspectPooledCheckInputs(path);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.category, "observation");
    assert.match(result.reason, /inspection could not complete/);
    assert.match(result.reason, /Permission denied/i);
  } finally {
    chmodSync(hidden, 0o700);
  }
  assert.equal(readFileSync(join(hidden, "diagnostic.go"), "utf8"), "package old\n");
});

for (const variable of ["GIT_LITERAL_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) {
  test(`inherited ${variable} cannot change the Go source scan`, async (t) => {
    const path = fixture(t);
    mkdirSync(join(path, ".local"));
    writeFileSync(join(path, ".local/diagnostic.go"), "package old\n");
    const previous = process.env[variable];
    process.env[variable] = "1";
    try {
      const result = await inspectPooledCheckInputs(path);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.category, "state");
      assert.match(result.reason, /\.local\/diagnostic\.go/);
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });
}

test("inherited Git selectors cannot redirect the contamination scan", async (t) => {
  const path = fixture(t);
  writeFileSync(join(path, "diagnostic.go"), "broken\n");
  const previous = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = join(path, "missing-index");
  const previousDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(path, "missing-git-dir");
  try {
    const result = await inspectPooledCheckInputs(path);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.category, "state");
      assert.match(result.reason, /diagnostic\.go/);
    }
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
    if (previousDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousDir;
  }
});
