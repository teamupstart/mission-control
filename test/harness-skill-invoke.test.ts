// What is at stake: whether "run the no-mistakes gate" actually reaches the agent.
//
// Foreman types this line into a live composer and then walks away. Two things have to
// be true for that to work, and they are different claims about each harness:
//
//   1. the line INVOKES the skill in that harness's own grammar - `/no-mistakes` on
//      Claude, `$no-mistakes` on Codex, `/skill:no-mistakes` on pi; and
//   2. the line SUBMITS on the Enter that delivery spends on it.
//
// The second is the one that bites. Codex's `$name` opens a skill-mention popup whose
// first Enter INSERTS the mention instead of sending the message, and Codex declares
// `control.pastePlaceholder: null`, so delivery spends exactly one Enter and has no
// evidence it can read to retry. A bare `$no-mistakes` therefore sits in the composer
// forever - and Foreman has already stamped `wrapupAskedAt`, so the wrap-up is retired
// and nobody is told. Every value here was read off a live install (codex-cli 0.145.0,
// pi 0.81.0) driven through the daemon's own delivery: tmux bracketed paste, one Enter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HARNESS_CAPABILITIES, skillCommand } from "../src/shared/harness-capabilities.ts";
import { NO_MISTAKES_SKILL, wrapupNoMistakes } from "../src/shared/queue.ts";
import { AGENT_TYPES } from "../src/shared/types.ts";

test("each harness invokes a skill in its own grammar", () => {
  // Pinned literally rather than derived, because these are OBSERVATIONS. A test that
  // rebuilt them from the same spec would agree with any typo the spec ever grows.
  assert.equal(skillCommand("claude", "widget"), "/widget");
  assert.equal(skillCommand("codex", "widget"), "$widget - run this skill now.");
  assert.equal(skillCommand("pi", "widget"), "/skill:widget");
});

test("no two harnesses are handed the same line", () => {
  // The bug in one assertion: `/no-mistakes` was sent to every agent. If a future edit
  // collapses two grammars back together, that is either a real coincidence someone
  // should state deliberately or this defect returning.
  const lines = AGENT_TYPES.map((a) => skillCommand(a, NO_MISTAKES_SKILL)).filter((l) => l !== null);
  assert.equal(new Set(lines).size, lines.length, lines.join(" | "));
});

test("Claude's spelling did NOT move - making this per-harness retired nothing", () => {
  // `isWrapupPayload` recognises Foreman's own instruction coming back as a session's
  // goal by composing this. Every session ever auto-wrapped has `/no-mistakes` sitting
  // in its goal on someone's disk; if this stops composing byte-identically, that text
  // has to move to RETIRED_WRAPUP_PAYLOADS in the same change or the prompted trigger
  // re-arms and ships a second PR for work it already shipped.
  assert.equal(wrapupNoMistakes("claude"), "/no-mistakes");
});

test("CODEX: the line does not end on the mention token, so the one Enter submits it", () => {
  // The measured trap, and the reason Codex's line is not just `$no-mistakes`.
  //
  // A `$name` sitting at the END of Codex's composer keeps its skill-mention popup open
  // ("Press enter to insert or esc to close"), and that popup EATS the Enter to insert
  // the mention rather than sending the message. Worse when the name matches nothing:
  // the popup reads "no matches" and Enter does nothing at all, so the message can never
  // be submitted without an Esc first. Only WHITESPACE closes it - a trailing `.` is
  // read as part of the name and lands straight back in "no matches".
  //
  // Codex is the harness where that is fatal rather than merely awkward: it declares
  // `control.pastePlaceholder: null`, so delivery spends ONE Enter and has no evidence
  // it could read to decide whether to spend another.
  const line = skillCommand("codex", NO_MISTAKES_SKILL) as string;
  const [head, ...rest] = line.split(" ");
  assert.equal(head, `$${NO_MISTAKES_SKILL}`, "the mention still has to come first");
  assert.ok(rest.length > 0, `"${line}" ends on the mention token, so the popup eats the submit`);
  assert.ok(rest.join(" ").trim().length > 0, "a bare trailing space does not survive a trim()");
});

test("every line survives the trim() the send path puts it through", () => {
  // The card sends `text.trim()` and `isWrapupPayload` compares against a trimmed goal,
  // so a line whose submittability depended on trailing whitespace would be silently
  // un-fixed at the last moment - and on Codex, un-submittable.
  for (const agent of AGENT_TYPES) {
    const line = skillCommand(agent, NO_MISTAKES_SKILL);
    if (line === null) continue;
    assert.equal(line, line.trim(), agent);
  }
});

test("CLAUDE and PI end on the token, and that is measured, not overlooked", () => {
  // Neither has Codex's problem, for reasons that are theirs rather than luck, so
  // neither pays for a trailing clause:
  //   - Claude verifies its own submits (`pastePlaceholder` is non-null), so its
  //     delivery presses Enter again while the paste is still sitting in the composer.
  //   - pi opens its completion menu on TYPED keys and not on a bracketed paste;
  //     pasting `/skill:<name>` and pressing Enter once loaded and ran the skill.
  assert.ok((skillCommand("claude", NO_MISTAKES_SKILL) as string).endsWith(NO_MISTAKES_SKILL));
  assert.ok((skillCommand("pi", NO_MISTAKES_SKILL) as string).endsWith(NO_MISTAKES_SKILL));
});

test("a harness that loads skills says how one is invoked", () => {
  // Not the same question as `skills !== null`: a harness could load skills and offer no
  // typed invocation, which is why `invoke` is nullable. But every SHIPPED harness has a
  // measured answer, and a null appearing here should be a deliberate act with a capture
  // behind it, not a slot someone left blank.
  for (const agent of AGENT_TYPES) {
    const skills = HARNESS_CAPABILITIES[agent].skills;
    if (!skills) continue;
    assert.ok(skills.invoke, `${agent} loads skills but declares no invocation`);
  }
});

test("the gate instruction is the skill NAME asked of the harness, not a literal", () => {
  // One name, three lines. If these ever disagree, some surface is spelling the gate
  // itself instead of asking who it is being typed at.
  for (const agent of AGENT_TYPES) {
    assert.equal(wrapupNoMistakes(agent), skillCommand(agent, NO_MISTAKES_SKILL), agent);
  }
});
