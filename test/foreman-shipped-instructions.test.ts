import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: `personas/FOREMAN.md` is the ONE copy of Foreman's shipped standing
// instructions, read as a file at runtime rather than compiled into the bundle, and
// `seed()` swallows a read failure into `""`. That degradation is silent by design - a
// missing file must not take the daemon down - which means a file that stopped resolving
// looks exactly like an operator who deliberately cleared the box: Foreman reviews every
// session, verifies every work item and answers every cheap-tier ask with NO standing
// guidance at all, and nothing anywhere reports it.
//
// `test/foreman-instructions.test.ts` owns the STORAGE rules - builtin versus custom,
// empty versus unset, ETag and CAS - and to own them it points
// `MISSION_FOREMAN_INSTRUCTIONS` at a scratch file for every case. So the whole suite
// proves the mechanism against documents it wrote itself, and no test had ever opened the
// document this build actually ships. Renaming it, dropping it from
// `electron-builder.yml`'s `files` list, or moving `foremanInstructionsPath()` out of the
// two-levels-down module the `../../` depends on would all keep every existing test green.
//
// This file therefore sets no seed override on purpose. It is the one place that reads the
// real path - and "sets none" is not enough, because an override it INHERITED would redirect
// it just as effectively. `foremanInstructionsPath()` prefers `envVar("FOREMAN_INSTRUCTIONS")`
// over the shipped file, and `envVar` walks `MISSION_` then `FLEET_` then `HARNESS_`, so all
// three names have to go. `test/setup-state.mjs` clears the two `*_HOME` aliases and nothing
// else, and an operator who has configured a custom Foreman document has exactly this
// variable exported - so without these three lines this file would quietly validate their
// document on their machine and the shipped one in CI, which is the worst available split.
process.env.MISSION_HOME = mkdtempSync(join(tmpdir(), "foreman-shipped-home-"));
delete process.env.MISSION_FOREMAN_INSTRUCTIONS;
delete process.env.FLEET_FOREMAN_INSTRUCTIONS;
delete process.env.HARNESS_FOREMAN_INSTRUCTIONS;

const { foremanInstructionsPath } = await import("../src/server/config.ts");
const { foremanInstructionsView } = await import("../src/server/foreman/instructions.ts");
const { instructionsSection, PREFS_END, PREFS_HEADING } = await import(
  "../src/server/foreman/prefs.ts"
);
const { FOREMAN_INSTRUCTIONS_MAX_LENGTH } = await import("../src/shared/protocol.ts");

/** Collapse the document's wrapping so an assertion is about the sentence, not the column. */
const flat = (text: string) => text.replace(/\s+/gu, " ");

test("the shipped standing instructions resolve to a real, non-empty document", () => {
  const path = foremanInstructionsPath();
  // Stated rather than assumed. If an override reaches this worker by a route the preamble
  // does not clear, every assertion below would pass against the wrong document and report
  // that the shipped seed is healthy.
  assert.match(
    path,
    /[/\\]personas[/\\]FOREMAN\.md$/,
    `an override redirected the seed to ${path}; this file must read the shipped document`,
  );
  assert.equal(
    existsSync(path),
    true,
    `the shipped seed does not exist at ${path} - Foreman would run with no standing guidance`,
  );
  const bytes = readFileSync(path, "utf8");
  assert.ok(bytes.trim().length > 0, "the shipped seed is empty");

  // Sourced `builtin` and byte-exact, which is what makes "always the document this build
  // was made from" true rather than aspirational.
  const view = foremanInstructionsView();
  assert.equal(view.source, "builtin");
  assert.equal(view.text, bytes);
  assert.equal(view.defaultText, bytes);
});

test("the shipped document fits the length operators are held to", () => {
  // Not a formality. `Reset to built-in default` hands the operator this exact text in an
  // editor whose save is bounded by this constant, so a seed that outgrew the cap would give
  // them a document they could read and then not save - discovered only at the save, with
  // nothing on screen explaining it. Adding prose to the file is the one edit that can cause
  // that, so the bound belongs beside the file rather than in the route alone.
  const text = foremanInstructionsView().text;
  assert.ok(
    text.length <= FOREMAN_INSTRUCTIONS_MAX_LENGTH,
    `the shipped seed is ${text.length} UTF-16 units, over the ${FOREMAN_INSTRUCTIONS_MAX_LENGTH} an operator may save`,
  );
});

test("the operator's escalation rules reach the prompt's standing-instructions block", () => {
  const section = instructionsSection(foremanInstructionsView().text);
  assert.notDeepEqual(section, [], "the shipped seed rendered no standing-instructions block");

  // Framed on both sides, which is the division between the two halves of Foreman's
  // configuration: this prose shapes judgement and must never read as granting authority.
  assert.equal(section[0], PREFS_HEADING);
  assert.ok(section.includes(PREFS_END));

  const rendered = flat(section.join("\n"));

  /*
   * The escalation rules are asserted HERE, at the prompt, and not as Foreman's decision.
   *
   * Standing instructions are prose inserted into a model prompt; there is no branch in this
   * repository that reads "one-way door" and returns `escalate`. Asserting that Foreman
   * actually escalates would take a model call, and this suite spends no model tokens - so
   * the honest, mechanical claim is the one that can go wrong silently: does the rule survive
   * the file, the seed read, the trim and the framing, and arrive in the prompt at all.
   *
   * These two sit in the document's LAST section, which is what a lost trailing chunk, an
   * over-eager trim or a future cap would drop first.
   */
  assert.match(rendered, /Foundational architectural decisions should always be escalated/);
  assert.match(rendered, /One way doors/);
  // The exclusion is half the rule. Without it the same sentence asks Foreman to escalate
  // every ordinary refactor that touches a boundary between two packages.
  assert.match(rendered, /\(not internal interfaces between packages\)/);
  assert.match(rendered, /new major dependencies/);

  // The escalation rules the file already carried, so a rewrite of that section cannot drop
  // one while adding another.
  assert.match(rendered, /Design forks are mine/);
  assert.match(rendered, /The session is asking about scope/);
});
