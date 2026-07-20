import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, formatMarker, isOurs, parseMarker } from "../src/server/inspector/marker.ts";

// The Inspector pushes to GitHub as the OPERATOR. On the wire its comments are
// indistinguishable from the human's, from another agent running as the same user, and
// from a second Mission Control on another machine - same author, same avatar, same
// everything. Ownership decides two irreversible-looking actions: which threads get
// resolved, and which questions get answered.
//
// So these tests are not about a string format. They are about the three ways the app
// can publicly embarrass its user: resolving a colleague's review thread, silently
// refusing to answer someone who asked a direct question, and being talked into either
// of those by a stranger who pasted our marker into a comment of their own.

/** The login `gh` reports for us in these tests. Never hardcoded in the app. */
const US = "operator";

/** A comment by us, carrying the marker for `fp`. */
function ours(fp: string): { body: string; author: string } {
  return { body: formatMarker({ id: "id1", fingerprint: fp, round: 1 }), author: US };
}

test("a marker we wrote is recognised, with its fields intact", () => {
  const line = formatMarker({ id: "abc-123", fingerprint: "deadbeef0000", round: 3 });
  assert.ok(isOurs({ body: line, author: US }, US));
  assert.deepEqual(parseMarker(line), {
    id: "abc-123",
    fingerprint: "deadbeef0000",
    round: 3,
  });
});

// The marker prefix is a fixed public string and every fingerprint is visible in the
// rendered page source, so anyone who can comment on a public pull request can open one
// with our marker at column 0. Under a marker-only rule we would key that thread as ours
// and RESOLVE it, and read a forged reply as "we spoke last" and never answer the real
// question underneath.
test("a stranger who pastes our marker is not us", () => {
  const forged = { ...ours("fp1"), author: "drive-by-contributor" };
  assert.equal(isOurs(forged, US), false, "the author check is what stops this");
});

// The other half. The account is shared - the human comments under it, other agents run
// as it - so the author alone would make every comment on the PR ours to resolve.
test("our own account without our marker is not us", () => {
  assert.equal(isOurs({ body: "Looks good to me!", author: US }, US), false);
});

// FAIL CLOSED. An attacker who can stop `gh api user` from answering would otherwise
// downgrade us to the marker-only rule - which is exactly the rule they want.
test("with the login unknown, nothing is ours", () => {
  assert.equal(isOurs(ours("fp1"), null), false);
  assert.equal(isOurs({ body: "anything", author: US }, null), false);
});

// A GitHub App or bot credential reports a login that is not the human's, and it has to
// keep working - which is why the login is resolved from `gh`, never hardcoded.
test("ownership follows whatever login gh reports, not a fixed name", () => {
  const bot = { ...ours("fp1"), author: "mission-control[bot]" };
  assert.ok(isOurs(bot, "mission-control[bot]"));
  assert.equal(isOurs(bot, US), false);
});

test("the marker survives having a whole comment written under it", () => {
  const body = [
    formatMarker({ id: "id1", fingerprint: "fp1", round: 1 }),
    "**⌕ Inspector** · `major` · interfaces",
    "",
    "This reaches into the concrete type instead of the interface.",
  ].join("\n");
  assert.equal(parseMarker(body)?.fingerprint, "fp1");
});

// THE one that matters. GitHub's "Quote reply" prefixes every line with "> ", so a human
// replying to one of our comments produces a body that CONTAINS our marker verbatim.
//
// Under a substring test that reply reads as ours. The Inspector then looks at the
// thread, sees its own comment on top, concludes nobody is waiting on it, and never
// answers the question it was just asked - with no error anywhere. Anchoring the marker
// to offset 0 is the entire fix, and this is the test that holds it there.
test("a human QUOTING one of our comments is not mistaken for us", () => {
  const ours = formatMarker({ id: "id1", fingerprint: "fp1", round: 1 });
  const quoted = [`> ${ours}`, "> **⌕ Inspector** · `major`", "", "Why? This is the adapter."].join(
    "\n",
  );
  assert.equal(
    isOurs({ body: quoted, author: US }, US),
    false,
    "a quote-reply is the human's comment, not ours",
  );
  assert.equal(parseMarker(quoted), null);
});

test("nothing else counts as ours", () => {
  for (const body of [
    "Looks good to me!",
    "", // an empty comment
    "  <!-- mission-inspector:v1 id=x fp=y r=1 -->", // leading whitespace: not column 0
    "Here's how our reviewer tags things: <!-- mission-inspector:v1 id=x fp=y r=1 -->",
    "<!-- mission-inspector:v2 id=x fp=y r=1 -->", // a version this build cannot parse
    "<!-- some-other-bot:v1 id=x fp=y r=1 -->",
    "<!-- mission-inspector:v1 -->", // marker-shaped, but carries no identity
  ]) {
    assert.equal(
      isOurs({ body, author: US }, US),
      false,
      `should not claim authorship of: ${JSON.stringify(body)}`,
    );
  }
});

// A fingerprint is the identity of an ISSUE, not of a comment. It is what decides
// whether to post and what to resolve, which is exactly why the model never gets to
// choose one.
test("a fingerprint ignores the line the code happens to sit on", () => {
  // The whole point: a push that shifts code down must not re-raise every finding. The
  // fingerprint has no line in it at all, so this is true by construction - pinned so it
  // stays that way if someone ever "improves" the precision by adding one.
  const a = fingerprint("src/server/pr.ts", "Reaches into the concrete type");
  const b = fingerprint("src/server/pr.ts", "Reaches into the concrete type");
  assert.equal(a, b);
});

test("a fingerprint absorbs the way a model rewords itself", () => {
  const base = fingerprint("src/a.ts", "Reaches into the concrete type");
  for (const variant of [
    "reaches into the concrete type",
    "Reaches  into   the concrete type",
    "Reaches into the concrete type.",
    "`Reaches into the concrete type`",
    "**Reaches into the concrete type**",
    "  Reaches into the concrete type  ",
  ]) {
    assert.equal(fingerprint("src/a.ts", variant), base, `should match: ${variant}`);
  }
});

test("the same complaint about a different file is a different issue", () => {
  assert.notEqual(
    fingerprint("src/a.ts", "Reaches into the concrete type"),
    fingerprint("src/b.ts", "Reaches into the concrete type"),
  );
  assert.notEqual(
    fingerprint("src/a.ts", "Reaches into the concrete type"),
    fingerprint("src/a.ts", "Missing null check on the response"),
  );
});
