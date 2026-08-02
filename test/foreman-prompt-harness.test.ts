import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, policyFor, promptHarness } from "../src/server/foreman/prompt.ts";
import type { ReviewInput } from "../src/server/foreman/prompt.ts";
import { buildTriagePrompt, routerFor } from "../src/server/foreman/triage-prompt.ts";
import { AGENT_IDENTITY } from "../src/shared/agent.ts";
import { AGENT_TYPES } from "../src/shared/types.ts";
import type { AgentType } from "../src/shared/types.ts";
import { dialogSpecFor } from "../src/server/harness/index.ts";

// What is at stake: the reviewer prompt is a DESCRIPTION of the child's screen, and it was
// written against one agent's chrome and then handed to every agent's session.
//
// This is the one place the two axes legitimately meet. Which model judges is the RUNNER's
// question and is settled before the prompt is built; what is being judged is a session of
// some HARNESS, and the menu grammar - "you MUST fill answer.option", "the child's UI is not
// a text box, it discards typed characters" - is a claim about that harness's TUI. The
// harness already knows (`harness.tui.dialog`, measured against real captures rather than
// assumed), so the prompt asks it.
//
// Both directions are silent failures, and they are not symmetric:
//
//   - Told a menu exists where none is rendered, the model fills `answer.option` against
//     nothing. `menuMismatch` then cancels the answer and hands the session back - safe, but
//     the automation is dead for that harness and nothing says why.
//   - Told NOTHING about menus for a harness that draws them, the model writes prose for a
//     screen that discards typed characters. That reply is delivered as keystrokes into a
//     dialog, which is the direction that actually acts.
//
// So the assertions are table-driven off the registry rather than written per agent: a third
// harness inherits the coverage instead of needing its own test, which is the same bargain
// `detection.test.ts` makes with `DetectSpec`.

function input(agent: AgentType, over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    session: {
      agent,
      runtime: "terminal",
      name: "worktree cleanup",
      cwd: "/repo",
      gitBranch: "mancej/reap-leaked-worktree-leases",
      state: "awaiting_input",
      activity: null,
      goal: "Reap leaked worktree leases",
    },
    surface: "terminal",
    question: "May I run the tests?",
    transcript: [],
    truncated: false,
    instructions: "",
    ...over,
  };
}

test("the reviewer prompt names the harness it is judging, not a generic agent", () => {
  for (const agent of AGENT_TYPES) {
    const prompt = buildReviewPrompt(input(agent));
    assert.ok(
      prompt.includes(`A ${AGENT_IDENTITY[agent].label} session`),
      `the reviewer was not told it is looking at ${agent}`,
    );
  }
});

test("the router prompt names the harness too - it can DISPOSE, so it must read the same screen", () => {
  for (const agent of AGENT_TYPES) {
    const prompt = buildTriagePrompt(input(agent));
    assert.ok(prompt.includes(AGENT_IDENTITY[agent].label), `the router was not told it is on ${agent}`);
  }
});

test("the menu grammar is carried exactly for the harnesses that render a readable dialog", () => {
  for (const agent of AGENT_TYPES) {
    const prompt = buildReviewPrompt(input(agent));
    const draws = dialogSpecFor(agent) !== null;
    assert.equal(
      prompt.includes("ANSWERING A MENU"),
      draws,
      `${agent}: the menu instructions do not match what its harness declares`,
    );
    // The `option` field is the menu's delivery mechanism, so it travels with the section
    // rather than being described in a JSON shape the model can never legitimately fill.
    assert.equal(
      prompt.includes('"option"'),
      draws,
      `${agent}: the reply shape offers an option field that does not match its harness`,
    );
  }
});

// EVERY harness this build ships declares a dialog, so the branch below is reached by no
// agent in `AGENT_TYPES` today. That is exactly why it is driven off a hand-built
// `PromptHarness` rather than an agent id: a path first exercised by the harness that needs
// it is a path that ships broken, and `tui: null` is a capability absence the interface
// explicitly admits. Same bargain `pane-write-capabilities.test.ts` strikes with a
// hand-built `BoundPane` whose `write` is null.
test("a harness that renders no readable dialog is never told its prose will be discarded", () => {
  const prompt = policyFor({ child: "Pi", menus: false, runtime: "terminal" });
  // The sentence that makes the model choose a row instead of writing a reply. Believed on a
  // harness with no row to select, it is how Foreman stops answering that harness at all.
  assert.ok(!prompt.includes("discards typed characters"));
  assert.ok(!prompt.includes("ANSWERING A MENU"));
  assert.ok(!prompt.includes('"option"'));
  assert.ok(!prompt.includes("(no menu on screen)"));
  // ...and it is still told what it IS looking at, and still told how to answer.
  assert.ok(prompt.includes("A Pi session"));
  assert.ok(prompt.includes("PHRASING answer.text"));
  assert.ok(prompt.includes("WHEN TO ESCALATE"));
});

test("a harness that DOES render dialogs gets the whole menu contract", () => {
  const prompt = policyFor({ child: "Pi", menus: true, runtime: "terminal" });
  assert.ok(prompt.includes("ANSWERING A MENU"));
  assert.ok(prompt.includes("discards typed characters"));
  assert.ok(prompt.includes('"option"'));
});

test("the router names the child from the same projection, whatever its menus do", () => {
  // The router BUCKETS and never selects a row, so it carries no menu grammar - and must not
  // acquire one by reading `menus` a second time in a second place.
  for (const menus of [true, false]) {
    const prompt = routerFor({ child: "Pi", menus, runtime: "terminal" });
    assert.ok(prompt.includes("A Pi"));
    assert.ok(!prompt.includes("ANSWERING A MENU"));
  }
});

test("promptHarness reads the registry, not the id", () => {
  for (const agent of AGENT_TYPES) {
    const h = promptHarness(agent, "terminal");
    assert.equal(h.child, AGENT_IDENTITY[agent].label);
    assert.equal(h.menus, dialogSpecFor(agent) !== null);
    assert.equal(h.runtime, "terminal");
  }
});

test("on the driver runtime every harness answers rows, whatever its screen does", () => {
  // The half phase 6 rests on. `menus` is "can an answer be delivered by naming a row",
  // and on this runtime that is true for EVERY harness - including pi, whose `tui` is null
  // and which therefore reads as menu-less on the terminal axis. Were this projection to
  // keep asking the TUI, pi's driver would land and its sessions would be told to answer
  // structured requests in prose that has nowhere to go.
  for (const agent of AGENT_TYPES) {
    const h = promptHarness(agent, "sdk");
    assert.equal(h.child, AGENT_IDENTITY[agent].label);
    assert.equal(h.runtime, "sdk");
    assert.equal(h.menus, true, `${agent}: an embedded session always has a row to name`);
  }
  assert.equal(
    promptHarness("pi", "terminal").menus,
    dialogSpecFor("pi") !== null,
    "the terminal projection is still exactly the TUI fact",
  );
});

test("everything that is about JUDGMENT is the same for every harness", () => {
  // The policy is not per-vendor and must not drift into being. Only the screen description
  // moves; the rules deciding answer / escalate / skip are the same rules whichever agent is
  // stuck, and a harness losing one of them would be a quiet change of Foreman's contract.
  const invariant = [
    "WHEN TO ANSWER",
    "WHEN TO ESCALATE",
    "WHEN TO SKIP",
    "NEVER auto-approve these",
    "YOUR OPERATOR'S STANDING INSTRUCTIONS",
    "PHRASING answer.text",
  ];
  for (const agent of AGENT_TYPES) {
    const prompt = buildReviewPrompt(input(agent));
    for (const clause of invariant) {
      assert.ok(prompt.includes(clause), `${agent} lost the policy clause "${clause}"`);
    }
  }
});

test("the reply shape stays parseable JSON-ish for a harness with no option field", () => {
  // The shape block is spliced, so the branch that drops `option` must not leave a dangling
  // comma or an orphaned brace - the model is being shown this as the object to emit.
  for (const agent of AGENT_TYPES) {
    const prompt = buildReviewPrompt(input(agent));
    const shape = prompt.slice(prompt.indexOf("{"), prompt.indexOf("\n}\n") + 2);
    assert.ok(shape.includes('"answer"'), agent);
    assert.ok(!/,\s*\n\s*\}/.test(shape.replace(/\/\/.*$/gm, "")), `${agent}: trailing comma in the reply shape`);
  }
});
