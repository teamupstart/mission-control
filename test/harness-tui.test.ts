import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_TYPES } from "../src/shared/types.ts";
import { HARNESSES, dialogSpecFor, modeLineSpecFor, tuiFor } from "../src/server/harness/index.ts";
import { claudeTui } from "../src/server/harness/claude/tui.ts";
import { codexTui } from "../src/server/harness/codex/tui.ts";
import {
  hasUnansweredWarning,
  parsePaneDialog,
  submitAnswersRow,
} from "../src/server/discovery/pane-dialog.ts";
import { parsePaneModeLine } from "../src/server/discovery/pane-mode.ts";
import { activePaneDialog, reportBucket } from "../src/shared/session.ts";
import { mkSession } from "./helpers/session-fixture.ts";
import { PERMISSION, MULTI_SELECT } from "./fixtures/claude-panes.ts";
import {
  CODEX_COMMAND_APPROVAL,
  CODEX_FULL_ACCESS_CONFIRMATION,
  CODEX_PERMISSIONS_PICKER,
  CODEX_TRUST_DIALOG,
  CODEX_UPDATE_PROMPT,
} from "./fixtures/codex-panes.ts";

// What is at stake: `activePaneDialog` is the ONLY evidence that a session is parked and
// waiting which needs no hook instrumentation. Codex pushes no hooks at all, so for a Codex
// card it is the only such evidence there is, full stop.
//
// It was never collected. `annotatePaneState` opened with `if (s.agent !== "claude")`, so in
// the whole life of the dialog parser it was never once pointed at a Codex pane - and a
// comment directly above that guard asserted Codex "doesn't render these dialogs", which the
// guard itself guaranteed nobody would ever check. This suite is the check. The fixtures are
// verbatim captures from codex-cli 0.144.1, and they say the assertion was wrong: Codex
// renders the same numbered, single-cursor menus, differing in one token.
//
// So the tests below are mostly about a glyph, and that is the point - the cost of getting
// this wrong was every blocked Codex session on the board reading as merely unconfirmed.

test("every harness answers the tui capability - a spec or an explicit null", () => {
  for (const id of AGENT_TYPES) {
    const tui = HARNESSES[id].tui;
    if (tui === null) continue; // a legitimate answer, but see below for what it costs
    assert.ok(tui.repaintTimeoutMs > 0, `${id}: a repaint budget of zero re-reads instantly`);
    // Each capability is independently nullable, and at least one must be real: a spec that
    // can read neither a mode line nor a dialog is an object that says nothing, and
    // `annotatePaneState` would pay for a capture per tick to run no parses over it.
    assert.ok(
      tui.modeLine !== null || tui.dialog !== null,
      `${id}: a tui spec that reads nothing should be declared null instead`,
    );
  }
});

test("the cursor glyph is what differs, and it is load-bearing in both directions", () => {
  const claude = claudeTui.dialog!;
  const codex = codexTui.dialog!;
  assert.notEqual(claude.cursor, codex.cursor, "if these ever match, one of them is unmeasured");

  // The whole defect, in two assertions: Claude's grammar cannot read a Codex screen...
  assert.equal(parsePaneDialog(CODEX_COMMAND_APPROVAL, claude), null);
  // ...and the same 397 lines read it perfectly once the harness supplies its own glyph.
  const d = parsePaneDialog(CODEX_COMMAND_APPROVAL, codex);
  assert.ok(d, "Codex's approval prompt must parse with Codex's own spec");
  assert.equal(d.options.length, 3);
  assert.equal(d.highlighted, 1);

  // And symmetrically, so neither spec is quietly a superset that would mask the other.
  assert.equal(parsePaneDialog(PERMISSION, codex), null);
  assert.ok(parsePaneDialog(PERMISSION, claude), "Claude's own fixture must still parse");
});

test("a Codex approval prompt reads as the approve / approve-always / decline it is", () => {
  const d = parsePaneDialog(CODEX_COMMAND_APPROVAL, codexTui.dialog!);
  assert.ok(d);
  assert.deepEqual(
    d.options.map((o) => o.number),
    [1, 2, 3],
  );
  assert.match(d.options[0]!.label, /^Yes, proceed/);
  // Row 2 is the pair `optionRowMiss` documents - an approve row whose label carries the
  // whole command, so a caller that miscounts between rows 1 and 2 agrees with the wrong one.
  assert.match(d.options[1]!.label, /don't ask again/);
  assert.match(d.options[2]!.label, /^No,/);
  // The reason line is the question, not the "Environment: local" chrome nearer the rows.
  assert.match(d.prompt ?? "", /outside the restricted network sandbox\?$/);
});

test("a Codex trust question wrapped across lines is rejoined, not truncated", () => {
  const d = parsePaneDialog(CODEX_TRUST_DIALOG, codexTui.dialog!);
  assert.ok(d);
  assert.equal(d.options.length, 2);
  // The `?` lands on the first fragment; `joinBlock` is what turns the fragment back into
  // the question. Without it this reads "Do you trust the contents of this directory?" and
  // silently drops the sentence explaining what trusting it grants.
  assert.match(d.prompt ?? "", /^Do you trust the contents of this directory\?/);
  assert.match(d.prompt ?? "", /project-local config, hooks, and exec policies to load\.$/);
});

test("a Codex menu with no question mark above it still gets a caption", () => {
  const d = parsePaneDialog(CODEX_UPDATE_PROMPT, codexTui.dialog!);
  assert.ok(d);
  assert.equal(d.options.length, 3);
  // `readPrompt`'s fallback: no `?` anywhere in range, so the adjacent block is used rather
  // than the rows going out uncaptioned.
  assert.ok((d.prompt ?? "").length > 0);
});

test("Codex's native permissions picker and Full Access confirmation stay parseable", () => {
  const permissions = parsePaneDialog(CODEX_PERMISSIONS_PICKER, codexTui.dialog!);
  const permissionLabels = permissions?.options.map((option) => option.label) ?? [];
  assert.equal(permissionLabels.length, 4);
  for (const [index, label] of ["Ask for approval (current)", "Approve for me", "Full Access", "Read Only"].entries()) {
    assert.match(permissionLabels[index] ?? "", new RegExp(`^${label.replace(/[()]/g, "\\$&")}(?: |$)`));
  }
  const confirmation = parsePaneDialog(CODEX_FULL_ACCESS_CONFIRMATION, codexTui.dialog!);
  assert.match(confirmation?.options[0]?.label ?? "", /^Yes, continue anyway(?: |$)/);
  assert.match(confirmation?.options[1]?.label ?? "", /^Cancel(?: |$)/);
});

test("a harness with no form vocabulary never reads a bracketed row as a checkbox", () => {
  const codex = codexTui.dialog!;
  assert.equal(codex.form, null);

  // Claude's own multi-select, parsed with Codex's formless spec. The rows are unreachable
  // anyway (wrong glyph), so use the one thing that must hold for ANY formless harness:
  // the form readers refuse rather than inventing another agent's nouns.
  const claudeForm = parsePaneDialog(MULTI_SELECT, claudeTui.dialog!);
  assert.ok(claudeForm?.multiSelect, "the Claude fixture must still read as a form");
  assert.equal(submitAnswersRow(claudeForm, codex), null);
  assert.equal(hasUnansweredWarning(MULTI_SELECT, codex), false);
  // ...while Claude's own spec still finds them, so the refusal above is about the spec and
  // not about the fixture having lost its rows.
  assert.equal(hasUnansweredWarning("you have not answered all questions", claudeTui.dialog!), true);
});

test("no mode line means no invented mode, not a mode read with someone else's words", () => {
  assert.equal(modeLineSpecFor("codex"), null, "Codex has no Shift+Tab mode footer");
  assert.ok(modeLineSpecFor("claude"), "Claude does");

  // Claude's footer, read with Claude's spec, is a mode. There is no Codex spec to read it
  // with at all: Codex's separate `/permissions` menu control must not make the pane
  // parser read Claude's footer vocabulary.
  const line = parsePaneModeLine("⏸ manual mode on · ← 3 agents", claudeTui.modeLine!);
  assert.equal(line?.mode, "default");
});

test("the fix, end to end: a Codex session parked on an approval prompt needs you", () => {
  const menu = parsePaneDialog(CODEX_COMMAND_APPROVAL, dialogSpecFor("codex")!);
  assert.ok(menu);

  // Codex is uninstrumented by construction - it pushes no hooks - so before this capability
  // there was no signal that could put it anywhere but "not confirmed busy". Status
  // is cleared too: a run in flight is a DIFFERENT reason to read as busy, and leaving it
  // set would let this pass for a reason that has nothing to do with the dialog.
  const blind = mkSession({
    agent: "codex",
    state: "idle",
    instrumented: false,
    hooksSeen: false,
  });
  assert.equal(reportBucket(blind, [blind]), "idle");
  assert.equal(activePaneDialog(blind), null);

  const parked = { ...blind, paneDialog: menu };
  assert.equal(reportBucket(parked, [parked]), "needs-you");
  assert.ok(activePaneDialog(parked), "the menu is what makes it answerable from the dashboard");
});

test("tuiFor is the way to ask, so the agent check cannot come back", () => {
  assert.ok(tuiFor("claude"));
  assert.ok(tuiFor("codex"));
  // Reaching a capability through the registry is what keeps a new harness's answer to
  // "can we read your screen?" a decision someone made rather than a branch nobody wrote.
  for (const id of AGENT_TYPES) assert.equal(tuiFor(id), HARNESSES[id].tui);
});
