import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  return run(process.execPath, ["-e", spew], {
    maxBuffer: 1024,
    timeoutMs: 15_000,
  }).then((res) => {
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

// A `maxBuffer` overflow is the one flag READS and WRITES read in opposite directions,
// and getting it backwards on the write side is the fifth distinct route into the same
// duplicate-comment failure. On a read the overflow is a fact about the response and
// `fetchDiff` rightly declines the PR (see the test above). On a write the request
// completed and GitHub answered - only our own buffer failed - so the review DID land,
// and calling that a refusal would put every row back to `drafted` and say it all again.
test("an overflow on a write is never a refusal, whatever the flags say", () => {
  assert.equal(
    wasRefused({ ok: false, error: "too big", outcomeUnknown: false, tooLarge: true }),
    false,
    "the response overflowed, not the request - it may well have landed",
  );
});

// An argv the kernel will not accept is thrown SYNCHRONOUSLY out of `spawn`, not handed to
// the callback the way a missing binary is - so it escaped this function as a promise
// REJECTION, which is the one thing `run` documents that it never does. Every caller here
// reads `code` instead of holding a try/catch, so the throw did not degrade into a failed
// command, it took down whatever was awaiting it.
//
// That is the same family as the bug this landed with: a payload on argv has a ceiling, and
// past it the write does not fail, it explodes. tmux's ceiling is its own ~16KB command
// limit and is fixed by piping the payload; the backends with no stdin form (cmux's `rpc`,
// ghostty's `osascript -e`) still have the OS's `ARG_MAX` under them, and this is what makes
// reaching it an ordinary refusal they can report.
test("an argv too large to spawn is a refusal, not a throw", async () => {
  // Comfortably past `ARG_MAX`, which is 1MB on macOS and 2MB on common Linux configs.
  const res = await run(process.execPath, ["-e", "0", "x".repeat(8 * 1024 * 1024)]);

  assert.notEqual(res.code, 0, "it must report failure");
  // The errno spelling is a platform/runtime detail: Unix reports E2BIG, while Windows
  // can surface the same command-line refusal as EINVAL or ENAMETOOLONG.
  const tooLarge = process.platform === "win32" ? /E2BIG|EINVAL|ENAMETOOLONG/ : /E2BIG/;
  assert.match(res.stderr, tooLarge, "and say why, so an operator sees more than a bare exit");
  // The load-bearing half. Nothing spawned, so nothing ran and nothing was written - which
  // is the one direction a caller may safely retry from. Reported as an unknown outcome,
  // `injectPrompt` would refuse to re-send a prompt that never left this process.
  assert.equal(res.outcomeUnknown, false, "no process existed, so the outcome is known");
  assert.equal(res.overflowed, false, "that flag is about stdout, not argv");
});

test("a callback-reported spawn refusal keeps its diagnostic", async () => {
  // ENOENT takes `execFile`'s callback path rather than its synchronous-throw path. Both
  // paths represent the same fact - no process existed - and both need to retain Node's
  // message so an E2BIG reported this way does not degrade to a blank fallback on another
  // runtime or operating system.
  const missing = join(tmpdir(), `mission-control-missing-${randomUUID()}`);
  const res = await run(missing, []);

  assert.notEqual(res.code, 0);
  assert.ok(res.stderr.trim(), "the spawn refusal must say why it could not start");
  assert.equal(res.outcomeUnknown, false, "no process existed, so the outcome is known");
  assert.equal(res.overflowed, false);
});
