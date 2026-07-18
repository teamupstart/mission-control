import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, sessionLabel, deriveTitle } from "../src/server/dispatcher.ts";
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

test("sessionLabel keeps a title readable but tmux-safe", () => {
  // Spaces and capitals survive, so the card reads like a heading, not a slug.
  assert.equal(sessionLabel("Add a Dark Mode Toggle"), "Add a Dark Mode Toggle");
  // The tmux target separators '.' and ':' are dropped - they'd split `session:window.pane`.
  assert.equal(sessionLabel("Fix bug: retry.now"), "Fix bug retry now");
  // A leading '$' is tmux's session-ID sigil, so it can't lead the name.
  assert.equal(sessionLabel("$HOME cleanup"), "HOME cleanup");
  // Nor can any other target-spec sigil lead it: '=' (exact-match), '$' (session ID) and
  // '{' (special token) would each make a `-t` target resolve to the wrong session or none.
  for (const title of ["=Foo", "$bar", "{last}", "={$mixed"]) {
    assert.equal(/^[=${]/.test(sessionLabel(title)), false);
  }
  assert.equal(sessionLabel("=Foo"), "Foo");
  // Control characters (a pasted tab / newline) collapse to spaces.
  assert.equal(sessionLabel("a\tb\nc"), "a b c");
  // Nothing usable falls back rather than spawning an unnamed session.
  assert.equal(sessionLabel("  ::  "), "task");
  assert.equal(sessionLabel(""), "task");
  // Never carries a character a tmux name rejects, and is bounded.
  assert.equal(/[.:\u0000-\u001f\u007f]/.test(sessionLabel("Weird: a.b\tc")), false);
  assert.equal(sessionLabel("$x").startsWith("$"), false);
  assert.ok(sessionLabel("word ".repeat(40)).length <= 60);
});

test("deriveTitle takes the first non-empty line, title-cased, capped at 60", () => {
  // Title-cased so an untitled dispatch reads like a heading, with minor words left low.
  assert.equal(deriveTitle("\n\n  do the thing  \nmore"), "Do the Thing");
  // Words already carrying a capital (acronyms, camelCase, file names) are left as typed.
  assert.equal(deriveTitle("fix the useEffect in App.tsx"), "Fix the useEffect in App.tsx");
  assert.equal(deriveTitle(""), "Task");
  const long = "x".repeat(80);
  assert.equal(deriveTitle(long).length, 60); // 59 + ellipsis
  assert.ok(deriveTitle(long).endsWith("…"));
});

test("an untitled dispatch names its card like a heading, not a slug", () => {
  // The exact complaint: with no title entered, the name comes from the prompt. It must
  // read like a title - spaced and capitalized - not `add-a-dark-mode-toggle`. This is
  // the composition the dispatcher runs: sessionLabel over the derived default title.
  const intent = "add a dark mode toggle to the settings page";
  const label = sessionLabel(deriveTitle(intent));
  assert.equal(label, "Add a Dark Mode Toggle to the Settings Page");
  assert.equal(label.includes("-"), false);
});

test("DispatchSchema fills defaults and requires repo + intent", () => {
  const ok = DispatchSchema.safeParse({ repoRoot: "/x", intent: "do it" });
  assert.equal(ok.success, true);
  if (ok.success) {
    assert.equal(ok.data.kind, "ship");
    assert.equal(ok.data.agent, "claude");
    assert.equal(ok.data.backlog, false);
  }
  assert.equal(DispatchSchema.safeParse({ intent: "x" }).success, false);
  assert.equal(DispatchSchema.safeParse({ repoRoot: "/x" }).success, false);
  assert.equal(
    DispatchSchema.safeParse({ repoRoot: "/x", intent: "y", kind: "bogus" }).success,
    false,
  );
});
