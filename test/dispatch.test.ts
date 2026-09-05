import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, sessionLabel, deriveTitle } from "../src/server/dispatcher.ts";
import { DispatchSchema } from "../src/shared/protocol.ts";
import { fullTaskTitle, stripTitlePreamble, TITLE_DETAIL_MAX_CHARS } from "../src/shared/title.ts";

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

test("sessionLabel keeps a title readable, whatever backend will hold it", () => {
  // Only the rules EVERY backend's names share are asserted here, because `sessionLabel`
  // now asks whichever backend a dispatch would land on (`homeNameRules`) and CI may have
  // none of them installed. tmux's own grammar - the '.' and ':' separators, the leading
  // target-spec sigils - is asserted directly against `TMUX_NAMES` in
  // `terminal-name-rules.test.ts`, where it does not need a tmux to be true.

  // Spaces and capitals survive, so the card reads like a heading, not a slug.
  assert.equal(sessionLabel("Add a Dark Mode Toggle"), "Add a Dark Mode Toggle");
  // Control characters (a pasted tab / newline) collapse to spaces rather than vanishing,
  // so `a\tb` reads as two words instead of `ab`.
  assert.equal(sessionLabel("a\tb\nc"), "a b c");
  // Nothing usable falls back rather than spawning an unnamed session.
  assert.equal(sessionLabel(""), "task");
  assert.equal(sessionLabel("   "), "task");
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

test("a generated title names the work, not the request for it", () => {
  // The operator's own two examples, which is what this exists for: a card says what the task
  // IS, and the framing it was dictated in is the part every card in the column shares.
  assert.equal(stripTitlePreamble("Implement Herdr Multiplexer"), "Herdr Multiplexer");
  assert.equal(
    stripTitlePreamble("We should implement the Herdr multiplexer"),
    "The Herdr multiplexer",
    "a stacked preamble loses all of it, not the outermost layer",
  );

  // The rest of the framing an operator dictates in.
  assert.equal(stripTitlePreamble("I want to add a dark mode toggle"), "Add a dark mode toggle");
  assert.equal(stripTitlePreamble("I need the parser to stop hanging"), "The parser to stop hanging");
  assert.equal(
    stripTitlePreamble("Can you please fix the flaky worktree cleanup"),
    "Fix the flaky worktree cleanup",
  );
  assert.equal(stripTitlePreamble("Let's migrate the registry comparators"), "Migrate the registry comparators");
  assert.equal(
    stripTitlePreamble("I'd like you to remove the second eviction path"),
    "Remove the second eviction path",
  );
  // Stranded punctuation goes with the phrase that stranded it.
  assert.equal(stripTitlePreamble("  we should   implement:  the parser  "), "The parser");

  // What must survive untouched. The verbs the prompt asks for each say something their object
  // cannot, so none of them is preamble.
  assert.equal(stripTitlePreamble("Fix flaky worktree cleanup on Reset"), "Fix flaky worktree cleanup on Reset");
  assert.equal(stripTitlePreamble("Add a dark mode toggle"), "Add a dark mode toggle");
  // Only whole leading words match: `implementation` is not `implement`, and `implements` is a
  // Java keyword whose object does not name the work on its own.
  assert.equal(stripTitlePreamble("Implementation of the parser is wrong"), "Implementation of the parser is wrong");
  assert.equal(stripTitlePreamble("implements Cloneable in the adapter"), "implements Cloneable in the adapter");
  assert.equal(stripTitlePreamble("Weather report widget"), "Weather report widget");
  // A title that is NOTHING but preamble is still the only name the task has - `title` is
  // NOT NULL, and a blank card is worse than a vague one.
  assert.equal(stripTitlePreamble("Implement"), "Implement");
  assert.equal(stripTitlePreamble("Please"), "Please");

  // And the heuristic tier - the title the card carries while the model is still answering, and
  // the one it keeps forever when no provider is reachable - is held to the same rule from the
  // same definition, then title-cased as before.
  assert.equal(deriveTitle("we should implement the Herdr multiplexer\nmore detail"), "The Herdr Multiplexer");
  assert.equal(deriveTitle("Implement Herdr Multiplexer"), "Herdr Multiplexer");
  // The 60-char budget is spent on the name rather than on the framing: unstripped, this cut
  // at "...the flaky worktree" and lost the part that says which cleanup.
  const framed = "We should implement a fix for the flaky worktree cleanup on Reset";
  assert.equal(deriveTitle(framed), "A Fix for the Flaky Worktree Cleanup on Reset");
  assert.ok(!deriveTitle(framed).endsWith("…"));
});

test("fullTaskTitle recovers only a shortened generated fallback", () => {
  const intent =
    "compare the features of this application with the features of the competing application in a complete report";
  const shortened = deriveTitle(intent);
  assert.equal(
    fullTaskTitle(shortened, intent),
    "Compare the Features of This Application with the Features of the Competing Application in a Complete Report",
  );
  assert.equal(fullTaskTitle("A model-written summary…", intent), "A model-written summary…");

  const hugeIntent = "x".repeat(TITLE_DETAIL_MAX_CHARS + 100);
  const bounded = fullTaskTitle(deriveTitle(hugeIntent), hugeIntent);
  assert.equal(bounded.length, TITLE_DETAIL_MAX_CHARS);
  assert.ok(bounded.endsWith("…"));
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
    // The agent DELIBERATELY has no schema default. It carried `.default("claude")` until the
    // per-kind defaults arrived, and that default was the reason none of them could ever have
    // applied: an omitted agent had already become an explicit Claude by the time any code
    // that knows the kind could see it. It is resolved at `TaskManager.create` instead, and
    // `kind` keeps its own default so the kind is always known when it happens.
    assert.equal(ok.data.agent, undefined);
    assert.equal(ok.data.backlog, false);
    assert.equal(ok.data.enabled, true);
  }
  assert.equal(
    DispatchSchema.parse({ repoRoot: "/x", intent: "do it", backlog: true, enabled: false }).enabled,
    false,
  );
  assert.equal(DispatchSchema.safeParse({ intent: "x" }).success, false);
  assert.equal(DispatchSchema.safeParse({ repoRoot: "/x" }).success, false);
  assert.equal(
    DispatchSchema.safeParse({ repoRoot: "/x", intent: "y", kind: "bogus" }).success,
    false,
  );
});
