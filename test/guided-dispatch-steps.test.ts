/**
 * The guided dispatch pass's step machine.
 *
 * What is at stake is the pass's shape, which the phases after it build on: the order is DATA
 * (which is how Repo was prepended to it), and the moves between steps are pure, so the
 * questions a browser test drives are decided here rather than inside a component. The machine
 * has no opinion about what an answer MEANS - `DispatchModal` runs the same `update(...)` the
 * field's own control runs - so what is tested here is the walk, not the writes.
 *
 * A unit test rather than a browser one because there is no DOM in it. The pass's behaviour
 * ON SCREEN - mnemonics landing in the form's own controls, ⌫ un-answering a rung, ⇥ handing
 * over the form with the caret in the task box - is `e2e/specs/guided-dispatch.spec.ts`, and
 * has to be, because none of that is a function of these values.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_TYPES, TASK_KINDS } from "../src/shared/types.ts";
import {
  GUIDED_HARNESS_KEYS,
  GUIDED_KIND_KEYS,
  GUIDED_STEPS,
  GUIDED_STEP_IDS,
  NO_GUIDED_PASS,
  activeGuidedStep,
  answerGuidedStep,
  backGuidedStep,
  endGuidedPass,
  guidedMnemonic,
  isGuidedPassRunning,
  jumpToGuidedStep,
  startGuidedPass,
  type GuidedPass,
} from "../src/web/lib/guided-dispatch-steps.ts";

/** Answer every question in order, from a fresh pass. */
function walk(): GuidedPass {
  let pass = startGuidedPass();
  for (const _ of GUIDED_STEPS) pass = answerGuidedStep(pass);
  return pass;
}

test("the pass asks repo, then kind, then harness, then after work", () => {
  // Order is a contract, not a detail, twice over. Repo is asked FIRST because its answer is
  // the one already in the draft - `readLastDispatchRepo()` seeds it - so the commonest pass
  // opens on a question ↵ alone answers. And Kind is asked BEFORE After work so that by the
  // time the After work question is on screen, `afterWorkForKind` has already moved a scout's
  // selection to None and the step can say why; reversing those two would make the pass
  // preselect an answer it then immediately overwrote.
  assert.deepEqual([...GUIDED_STEP_IDS], ["repo", "kind", "harness", "afterWork"]);
  assert.deepEqual(
    GUIDED_STEPS.map((step) => step.id),
    [...GUIDED_STEP_IDS],
    "the described steps and the id tuple are one list, in one order",
  );
  assert.equal(GUIDED_STEPS[0]?.id, "repo");
});

test("every step names itself, its question and the draft keys it writes", () => {
  for (const step of GUIDED_STEPS) {
    assert.ok(step.name.length > 0, `${step.id} has no rung name`);
    assert.ok(step.question.endsWith("?"), `${step.id}'s question is not a question`);
    assert.ok(step.writes.length > 0, `${step.id} writes nothing`);
  }
  // The declared writes are the claim worth pinning: the pass fills the same draft the form
  // does, through the same keys, and must never reach one the form's own controls do not
  // write. `repo` writes the one key the field it drives already writes; `kind` carries
  // `workflowId` because choosing scout moves After work to None - that is the Kind
  // `<select>`'s own rule - and `harness` carries the two overrides that do not travel across
  // harnesses.
  assert.deepEqual(
    Object.fromEntries(GUIDED_STEPS.map((step) => [step.id, [...step.writes]])),
    {
      repo: ["repoRoot"],
      kind: ["kind", "workflowId", "dependencies"],
      harness: ["agent", "model", "effort"],
      afterWork: ["workflowId"],
    },
  );
});

test("exactly one step is answered by the form's own field, and it is Repo", () => {
  // `answeredBy` is what the key handler branches on, and the branch is not cosmetic: a
  // `field` step spends no digits on positions and does not own Escape, because both belong
  // to `RepoCombobox`. A second step declaring itself a field would silently inherit both
  // exceptions, so the count is asserted rather than the flag alone.
  assert.deepEqual(
    GUIDED_STEPS.filter((step) => step.answeredBy === "field").map((step) => step.id),
    ["repo"],
  );
  // And the closed-set steps are exactly the ones with a mnemonic table, which is what makes
  // "digits and letters pick here, and only here" a property of the data.
  assert.deepEqual(
    GUIDED_STEPS.filter((step) => step.answeredBy === "options").map((step) => step.id),
    ["kind", "harness", "afterWork"],
  );
});

test("a fresh pass opens on the first question with nothing answered", () => {
  const pass = startGuidedPass();
  assert.equal(pass.active, "repo");
  assert.deepEqual([...pass.answered], []);
  assert.equal(isGuidedPassRunning(pass), true);
  assert.equal(activeGuidedStep(pass)?.name, "Repo");

  assert.equal(isGuidedPassRunning(NO_GUIDED_PASS), false);
  assert.equal(activeGuidedStep(NO_GUIDED_PASS), null);
});

test("answering walks forward, ticking each question as it goes", () => {
  let pass = startGuidedPass();
  pass = answerGuidedStep(pass);
  assert.equal(pass.active, "kind");
  assert.deepEqual([...pass.answered], ["repo"]);

  pass = answerGuidedStep(pass);
  assert.equal(pass.active, "harness");
  assert.deepEqual([...pass.answered], ["repo", "kind"]);

  pass = answerGuidedStep(pass);
  assert.equal(pass.active, "afterWork");
  assert.deepEqual([...pass.answered], ["repo", "kind", "harness"]);
});

test("answering the last question ends the pass with every step answered", () => {
  const pass = walk();
  assert.equal(pass.active, null);
  assert.equal(isGuidedPassRunning(pass), false);
  assert.deepEqual([...pass.answered], [...GUIDED_STEP_IDS]);
  // Nothing left to answer, so a further answer is inert rather than an error - the key
  // handler is a window listener and can be reached one repeat after the last ↵.
  assert.deepEqual(answerGuidedStep(pass), pass);
});

test("back un-answers the question it returns to", () => {
  let pass = answerGuidedStep(answerGuidedStep(startGuidedPass()));
  assert.deepEqual([...pass.answered], ["repo", "kind"]);

  pass = backGuidedStep(pass);
  // The rung it lands on stops claiming an answer. It is about to be asked again, and a
  // tick over a live question is the strip telling the operator something untrue.
  assert.equal(pass.active, "kind");
  assert.deepEqual([...pass.answered], ["repo"]);

  // ...all the way back to the first question, which is Repo. The draft keeps the path
  // either way; what this un-does is the rung's claim to have asked already.
  pass = backGuidedStep(pass);
  assert.equal(pass.active, "repo");
  assert.deepEqual([...pass.answered], []);
});

test("back from the first question is a no-op", () => {
  const pass = startGuidedPass();
  // ⇥ is the exit and it is printed on the strip. If ⌫ also left, one key would mean
  // "correct that" three times and "abandon this" once. In Repo the key never reaches this
  // at all - it deletes a character out of the field being filtered on - and the two
  // readings agree, which is what let Repo take the front without touching this move.
  assert.equal(pass.active, "repo");
  assert.deepEqual(backGuidedStep(pass), pass);
  assert.deepEqual(backGuidedStep(NO_GUIDED_PASS), NO_GUIDED_PASS);
});

test("jumping back reopens an answered question and un-answers everything after it", () => {
  const finished = walk();
  const pass = jumpToGuidedStep(finished, "repo");
  assert.equal(pass.active, "repo");
  assert.deepEqual([...pass.answered], []);

  const atKind = jumpToGuidedStep(finished, "kind");
  assert.equal(atKind.active, "kind");
  assert.deepEqual([...atKind.answered], ["repo"]);
});

test("jumping is refused for a question that has not been answered", () => {
  const pass = startGuidedPass();
  // The rungs that are not buttons are exactly the ones this rejects, so the strip cannot
  // become a way to skip past a question by being clicked ahead.
  assert.deepEqual(jumpToGuidedStep(pass, "afterWork"), pass);
  assert.deepEqual(jumpToGuidedStep(pass, "harness"), pass);
  assert.deepEqual(jumpToGuidedStep(pass, "kind"), pass);
});

test("skipping keeps every answered step", () => {
  const pass = endGuidedPass(answerGuidedStep(startGuidedPass()));
  assert.equal(pass.active, null);
  assert.equal(isGuidedPassRunning(pass), false);
  // ⇥ hands over the form with what has been answered so far, which is the promise the
  // strip prints. Losing the answers here would make the escape hatch cost something.
  assert.deepEqual([...pass.answered], ["repo"]);
  // Already ended: idempotent, because the toggle, the ⇥ key and the Ensemble switch can
  // all reach it and two of them can land in the same commit.
  assert.deepEqual(endGuidedPass(pass), pass);
});

test("no two options in a closed-set step claim the same mnemonic", () => {
  for (const [what, keys] of [
    ["kind", Object.values(GUIDED_KIND_KEYS)],
    ["harness", Object.values(GUIDED_HARNESS_KEYS)],
  ] as const) {
    assert.equal(new Set(keys).size, keys.length, `two ${what} options share a letter`);
    for (const key of keys) {
      assert.match(key, /^[a-z]$/, `${what} mnemonics are single lowercase letters`);
    }
  }
  // Every member of each registry has one, which is the point of typing them as a `Record`
  // over the tuple: a fourth harness does not compile until it has said which key takes it.
  assert.equal(Object.keys(GUIDED_KIND_KEYS).length, TASK_KINDS.length);
  assert.equal(Object.keys(GUIDED_HARNESS_KEYS).length, AGENT_TYPES.length);
});

test("each kind's mnemonic is a letter of its own name", () => {
  // The uniqueness check above is satisfied by any three distinct letters, including three
  // that no operator could guess. These are the letters a person would reach for, so the
  // rule they were chosen under is written down rather than left to the comment.
  for (const kind of TASK_KINDS) {
    assert.ok(
      kind.includes(GUIDED_KIND_KEYS[kind]),
      `${kind}'s mnemonic ${GUIDED_KIND_KEYS[kind]} is not a letter of the word`,
    );
  }
  // And the specific assignments, because "a letter of its own name" does not pick between
  // `p` and `s` for ship. `plan` takes `l` by elimination: `p` is ship's, `a` is in all
  // three words, and `n` reads as "no".
  assert.deepEqual(GUIDED_KIND_KEYS, { ship: "p", scout: "t", plan: "l", chat: "c" });
});

test("a fetched option takes the first letter of its name that is still free", () => {
  const taken = new Set(["d", "n"]);
  // "Docs Sweep" cannot have `d` - that belongs to the Dispatch default option above it -
  // so it earns `o`, and shadowing is what this exists to prevent.
  assert.equal(guidedMnemonic("Docs Sweep", taken), "o");
  assert.equal(guidedMnemonic("No-Mistakes Review", taken), "o");
  // Digits and punctuation are not mnemonics: position digits are their own key, and a
  // workflow called "v2 Review" must not claim the `2` that takes the second option.
  assert.equal(guidedMnemonic("2· Review", taken), "r");
  // Nothing left. The option is still reachable - by its position digit and by the arrows -
  // and prints the digit rather than a letter it does not own.
  assert.equal(guidedMnemonic("dnd", taken), null);
  assert.equal(guidedMnemonic("", taken), null);
});
