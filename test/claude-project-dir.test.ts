import { test } from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { claudeProjectDir } from "../src/server/harness/claude/project-dir.ts";

// Every expected name here is what Claude Code's own encoder returned for the same cwd, read
// out of `@anthropic-ai/claude-agent-sdk` 0.3.283 (`vc`, shared with the bundled CLI). They are
// literals on purpose: a test that re-derived them would agree with any rule at all.

const name = (cwd: string): string => basename(claudeProjectDir(cwd, "/projects"));

test("a cwd of letters, digits, dots and slashes encodes as it always did", () => {
  assert.equal(name("/Users/me/.treehouse/x/4/app"), "-Users-me--treehouse-x-4-app");
  assert.equal(name("/private/var/folders/ab/T"), "-private-var-folders-ab-T");
});

test("every other non-alphanumeric character becomes a dash too", () => {
  // The case the old `[/.]` rule missed: it kept `_`, the space and `+`, naming a directory
  // Claude never writes, so the transcript was not found.
  assert.equal(name("/Users/me/my_app v2+x"), "-Users-me-my-app-v2-x");
});

test("the encoding is lossy, so different cwds can share one directory", () => {
  // Claude's behaviour, not ours to fix: the headless pruner's comment records what it means.
  assert.equal(name("/tmp/a_b"), "-tmp-a-b");
  assert.equal(name("/tmp/a-b"), "-tmp-a-b");
  assert.equal(name("/tmp/a b"), "-tmp-a-b");
});

test("the name is one directory under the projects root", () => {
  assert.equal(claudeProjectDir("/Users/me/my_app", "/projects"), join("/projects", "-Users-me-my-app"));
});

test("a name of exactly 200 characters is kept whole, and one more is cut and hashed", () => {
  const exact = "/" + "a".repeat(199);
  assert.equal(name(exact), "-" + "a".repeat(199));
  const over = "/" + "a".repeat(200);
  assert.equal(name(over), `-${"a".repeat(199)}-b6ymvl`);
});

test("a name past 200 characters is cut and suffixed with Claude's hash of the cwd", () => {
  const long = "/" + "deep/".repeat(60) + "app";
  const encoded = long.replace(/[^a-zA-Z0-9]/g, "-");
  assert.equal(name(long), `${encoded.slice(0, 200)}-flo65q`);

  // Hashed over UTF-16 code units of the unencoded cwd, so two cwds that encode alike past
  // the cut still get their own directory.
  const unicode = "/" + "Ünïcode/".repeat(30);
  assert.equal(name(unicode), `${unicode.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-62aiuz`);
});
