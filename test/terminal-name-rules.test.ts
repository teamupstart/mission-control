import { test } from "node:test";
import assert from "node:assert/strict";
import { PLAIN_NAMES, plainName } from "../src/server/terminal/names.ts";
import { TMUX_NAMES } from "../src/server/terminal/tmux.ts";

// What is at stake: that the two halves of a naming rule cannot drift apart again.
//
// A backend's name rules are asked in two directions - REJECT what a human typed, COERCE
// what a task title gave us - and those two halves lived in different files with nothing
// connecting them. `validateSessionName` (`actions.ts`) barred '.', ':' and a leading '$';
// `sessionLabel` (`dispatcher.ts`) stripped those AND a leading '=' or '{'. So a name a
// dispatch would never have produced could still be typed into the rename box, and neither
// file mentioned the other. They are one `NameRules` on the adapter now, and the property
// that matters is the round trip: whatever `sanitize` produces, `validate` must accept.
//
// Asserted against the rule objects directly rather than through a live server, because
// these are claims about a target GRAMMAR and a test that needed tmux installed to check
// them would simply not run on CI.

/** Titles that between them touch every rule either half has. */
const TITLES = [
  "Add a Dark Mode Toggle",
  "Fix bug: retry.now",
  "$HOME cleanup",
  "=Foo",
  "{last}",
  "={$mixed",
  "a\tb\nc",
  "  ::  ",
  "",
  "word ".repeat(40),
  "Weird: a.b\tc",
  "cost$$ report",
];

test("what a backend sanitizes, the same backend accepts", () => {
  // The round trip, over every rule set that exists. This is the property the split into
  // one object buys: a `sanitize` that stopped stripping something its own `validate` bars
  // fails here rather than in a 500 from a rename nobody could have typed.
  for (const rules of [PLAIN_NAMES, TMUX_NAMES]) {
    for (const title of TITLES) {
      const name = rules.sanitize(title);
      assert.equal(
        rules.validate(name),
        null,
        `sanitize produced a name its own validate rejects: ${JSON.stringify(name)}`,
      );
      assert.ok(name.length > 0, "a sanitized name is never empty");
    }
  }
});

test("the neutral rules bar what no display name can hold, and invent nothing else", () => {
  // A newline submits, splits or truncates depending on which of a title bar, a status line
  // and a card reads it first - so it is refused rather than silently rewritten.
  assert.ok(PLAIN_NAMES.validate("a\nb"));
  assert.ok(PLAIN_NAMES.validate("a\tb"));
  // And nothing further: a tab title has no target grammar behind it, so punctuation that
  // one backend cannot express is perfectly fine here.
  assert.equal(PLAIN_NAMES.validate("a.b:c"), null);
  assert.equal(PLAIN_NAMES.validate("$0"), null);
});

test("plainName collapses rather than deletes, and stays bounded", () => {
  // Controls become SPACES, so `a\tb` reads as two words instead of `ab`.
  assert.equal(plainName("a\tb\nc"), "a b c");
  assert.equal(plainName("  lots   of   space  "), "lots of space");
  assert.equal(plainName(""), "task");
  assert.equal(plainName("\t\n"), "task");
  assert.ok(plainName("word ".repeat(40)).length <= 60);
});

test("tmux rejects only what its own target grammar cannot express", () => {
  // Separators in `session:window.pane`.
  assert.ok(TMUX_NAMES.validate("api.v2"));
  assert.ok(TMUX_NAMES.validate("api:v2"));
  // The session-ID sigil: `-t '$0'` resolves by ID and never falls back to a name lookup,
  // so focus and kill would target whichever session holds ID 0.
  assert.ok(TMUX_NAMES.validate("$0"));
  assert.ok(TMUX_NAMES.validate("$work"));
  // Only a LEADING '$' aliases an id - one inside the name is just a character.
  assert.equal(TMUX_NAMES.validate("cost$$"), null);
  assert.equal(TMUX_NAMES.validate("api-v2"), null);
  // The shared half applies inside every backend's rules, never instead of them.
  assert.ok(TMUX_NAMES.validate("a\nb"));
});

test("tmux sanitizes a title into something readable that its targets can hold", () => {
  // Spaces and capitals survive, so the card reads like a heading rather than a slug.
  assert.equal(TMUX_NAMES.sanitize("Add a Dark Mode Toggle"), "Add a Dark Mode Toggle");
  assert.equal(TMUX_NAMES.sanitize("Fix bug: retry.now"), "Fix bug retry now");
  assert.equal(TMUX_NAMES.sanitize("$HOME cleanup"), "HOME cleanup");
  assert.equal(TMUX_NAMES.sanitize("=Foo"), "Foo");
  assert.equal(TMUX_NAMES.sanitize("  ::  "), "task");
  assert.equal(TMUX_NAMES.sanitize("a\tb\nc"), "a b c");
});

test("sanitize strips every target-spec sigil that could lead a name, not just the one validate bars", () => {
  // The asymmetry, on purpose and now in one place where it can be read as one. '=' is
  // exact-match, '$' is a session ID and '{' opens a special token: a name leading with any
  // of them makes every `-t` we aim at it - has-session, kill-session, the `name:0.0` split
  // and select - resolve to the wrong session or to none. tmux itself refuses none of them,
  // so widening `validate` would change what a human is allowed to type; widening a
  // coercion nobody sees is free.
  for (const title of ["=Foo", "$bar", "{last}", "={$mixed"]) {
    assert.equal(/^[=${]/.test(TMUX_NAMES.sanitize(title)), false);
  }
});
