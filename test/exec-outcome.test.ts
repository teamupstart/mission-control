import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/server/util/exec.ts";
import { wasRefused } from "../src/server/inspector/github.ts";

// `run` is how everything in this app talks to `gh`, and the Inspector is the one caller
// whose commands PUBLISH - a review carrying up to eight comments on a public pull
// request, under the operator's own GitHub account.
//
// What is at stake here is one distinction: did the command RUN AND FAIL, or did it DIE
// without telling us? A refusal is a fact, and the round can be re-planned. A death is
// not - the review may already be live - and re-planning it says the same thing twice in
// public. `outcomeUnknown` is the flag that difference travels on, so the way it can go
// wrong is by reading a death as a refusal.

test("a command that runs and fails is a refusal, not an unknown", () => {
  return run(process.execPath, ["-e", "process.exit(3)"]).then((res) => {
    assert.equal(res.code, 3);
    assert.equal(res.outcomeUnknown, false, "it reported its own exit, so we know");
  });
});

test("a command that succeeds is not an unknown either", () => {
  return run(process.execPath, ["-e", "process.stdout.write('ok')"]).then((res) => {
    assert.equal(res.code, 0);
    assert.equal(res.stdout, "ok");
    assert.equal(res.outcomeUnknown, false);
  });
});

// THE one that matters. `killed` is set only when NODE killed the child, so a process
// taken out by the OOM killer, a container stop, or an operator's `pkill` arrives with
// `killed: false` and a signal - and under a `killed`-only test it reads as an ordinary
// refusal. The Inspector would then revert a whole round to `drafted` believing nothing
// was published, and post it again next round beside the review that already landed.
test("a command killed from outside is an unknown outcome, not a refusal", () => {
  return run(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]).then((res) => {
    assert.notEqual(res.code, 0);
    assert.equal(
      res.outcomeUnknown,
      true,
      "nothing reported an exit, so whether it did its work is unknown",
    );
  });
});

// Our own timeout is the same conclusion by a different route, and has to stay that way:
// a `gh` we stopped listening to may well have finished the POST first.
test("a command we time out on is an unknown outcome", () => {
  return run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 150 }).then(
    (res) => {
      assert.notEqual(res.code, 0);
      assert.equal(res.outcomeUnknown, true);
    },
  );
});

// A different flag for a different conclusion: too much output is not an unknown, it is a
// definite "this response cannot be made smaller by asking again".
test("an overflow is named as itself, and is not an unknown outcome", () => {
  const spew = "process.stdout.write('x'.repeat(200000))";
  return run(process.execPath, ["-e", spew], { maxBuffer: 1024 }).then((res) => {
    assert.equal(res.overflowed, true);
    assert.equal(res.outcomeUnknown, false, "an overflow is a fact about the response");
    assert.match(res.stderr, /maxBuffer/i, "and it has to be legible to a caller");
  });
});

// ---- the rule, at the one place that reads it ----

// `wasRefused` is the single statement of what an outcome means to the code that may
// have already published. Everything that is not a positive "GitHub refused us" has to
// land on the same side, because that side costs a delayed round and the other side
// costs a duplicate comment on a public pull request.
test("only a positive refusal frees a round to be said again", () => {
  assert.equal(
    wasRefused({ ok: false, error: "422", outcomeUnknown: false }),
    true,
    "GitHub answered and said no: nothing was published",
  );
});

test("every way of not knowing reads as 'it may already be published'", () => {
  for (const [name, res] of [
    ["the gh process died", { ok: false, error: "killed", outcomeUnknown: true }],
    ["the flag never travelled", { ok: false, error: "something" }],
    ["a success is not a refusal", { ok: true }],
  ] as const) {
    assert.equal(wasRefused(res), false, name);
  }
});

// The absent case is the one that matters: an optional boolean read as `!flag` would
// call it a refusal, and this is the assertion that stops that reading coming back.
test("a result carrying no verdict at all is never treated as a refusal", () => {
  assert.equal(wasRefused({ ok: false }), false);
});
