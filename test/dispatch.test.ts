import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, deriveTitle } from "../src/server/dispatcher.ts";
import { DispatchSchema } from "../src/shared/protocol.ts";

test("slugify produces tmux-safe, bounded slugs", () => {
  assert.equal(slugify("Fix the Login Bug!"), "fix-the-login-bug");
  assert.equal(slugify("Refactor: auth/session (v2)"), "refactor-auth-session-v2");
  assert.equal(slugify("   ...   "), "task");
  assert.equal(slugify(""), "task");
  // Only lowercase alnum + dashes ever survive.
  assert.equal(/[^a-z0-9-]/.test(slugify("Añadir café ☕ & more")), false);
  // Bounded to 32 chars with no trailing dash after truncation.
  const long = slugify("abcdefghij klmnopqrst uvwxyz 12 34567");
  assert.ok(long.length <= 32);
  assert.equal(long.endsWith("-"), false);
});

test("deriveTitle takes the first non-empty line, capped at 60", () => {
  assert.equal(deriveTitle("\n\n  Do the thing  \nmore"), "Do the thing");
  assert.equal(deriveTitle(""), "task");
  const long = "x".repeat(80);
  assert.equal(deriveTitle(long).length, 60); // 59 + ellipsis
  assert.ok(deriveTitle(long).endsWith("…"));
});

test("DispatchSchema fills defaults and requires repo + intent", () => {
  const ok = DispatchSchema.safeParse({ repoRoot: "/x", intent: "do it" });
  assert.equal(ok.success, true);
  if (ok.success) {
    assert.equal(ok.data.kind, "ship");
    assert.equal(ok.data.agent, "claude");
    assert.equal(ok.data.queue, false);
  }
  assert.equal(DispatchSchema.safeParse({ intent: "x" }).success, false);
  assert.equal(DispatchSchema.safeParse({ repoRoot: "/x" }).success, false);
  assert.equal(
    DispatchSchema.safeParse({ repoRoot: "/x", intent: "y", kind: "bogus" }).success,
    false,
  );
});
