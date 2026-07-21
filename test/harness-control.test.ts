import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";

// What is at stake: whether "we typed at the agent" is allowed to keep passing for
// "the agent took the turn".
//
// Submit verification reads a placeholder off the pane, because tmux reports that bytes
// were written and never what the TUI did with them. That placeholder was one Claude
// regex applied to every agent, so for a harness rendering none the check was not a check
// that failed - it was one that could never fire. `hasPendingPaste` was permanently
// false, the retry had nothing to gate on, and a single Enter came back as a confirmed
// submit having proved nothing. A wrong answer no caller could tell from a right one.
//
// So this pins the four claims the capability makes:
//   1. Every harness declares a delivery, and `control` is not nullable - there is no
//      harness we can dispatch to without knowing how to talk to it.
//   2. A null `pastePlaceholder` is a CAPABILITY absence, not "the composer is clear",
//      and the delivery path degrades on it deliberately instead of looping for evidence
//      that cannot appear.
//   3. What a composer renders, and WHEN, are both the harness's claims - the delivery
//      path makes neither, because one TUI's habit applied to every agent is the defect
//      above in its general form.
//   4. `ok: true` without evidence is reported as unverified rather than as success.

const home = mkdtempSync(join(tmpdir(), "harness-control-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

const { HARNESSES, controlFor } = await import("../src/server/harness/index.ts");
const { injectPrompt } = await import("../src/server/actions.ts");
const { hasPendingPaste } = await import("../src/server/discovery/pane-paste.ts");
const { AGENT_TYPES } = await import("../src/shared/types.ts");
const { stubRun } = await import("../src/server/util/exec.ts");

import type { ControlSpec } from "../src/server/harness/types.ts";
import type { InjectDeps } from "../src/server/actions.ts";
import { bindSession } from "../src/server/terminal/registry.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

after(() => rmSync(home, { recursive: true, force: true }));

const TMUX = mkMuxHandle();
const session = (over: Partial<Session>): Session =>
  ({ id: "s1", agent: "claude", terminals: [TMUX], ...over }) as Session;

const PENDING = "❯ [Pasted text #1 +3 lines]\n⏵⏵ auto mode on";
const CLEAR = "❯\n⏵⏵ auto mode on";

/**
 * Every command succeeds; each pane read yields the next `reads` entry, the last repeating.
 * `reads[0]` is the pre-Enter reading, the only one that can establish a pending paste.
 *
 * A SEQUENCE rather than one screen because the claim under test is a transition - a paste
 * seen pending and then seen gone - and a single fixed screen cannot express one.
 */
function harness(reads: (string | null)[] | string | null): {
  deps: InjectDeps;
  calls: string[][];
  captures: () => number;
} {
  const queue = Array.isArray(reads) ? reads : [reads];
  const calls: string[][] = [];
  let read = 0;
  const deps: InjectDeps = {
    pane: (session) =>
      bindSession(session, async (bin, args) => {
        calls.push([bin, ...args]);
        return stubRun({ stdout: "", stderr: "", code: 0 });
      }),
    capture: async () => queue[Math.min(read++, queue.length - 1)] ?? null,
    sleep: async () => {},
  };
  return { deps, calls, captures: () => read };
}

const enters = (calls: string[][]): number =>
  calls.filter((c) => c.includes("Enter") || c.includes("\r")).length;

// ---- the registry ----

test("every harness declares how a turn reaches it", () => {
  // `control` is required precisely so this can never be "absent, therefore keystroke".
  for (const id of AGENT_TYPES) {
    const control = HARNESSES[id].control;
    assert.ok(control, `${id} declares no delivery`);
    assert.ok(
      control.kind === "keystroke" || control.kind === "stream-json",
      `${id} declares an unknown delivery`,
    );
  }
});

test("the two harnesses genuinely differ in what they can verify", () => {
  // The asymmetry that made this a capability rather than a constant. Both are typed
  // into; only one renders anything that answers "did the Enter land?".
  const claude = HARNESSES.claude.control;
  const codex = HARNESSES.codex.control;
  assert.equal(claude.kind, "keystroke");
  assert.equal(codex.kind, "keystroke");
  assert.ok(claude.kind === "keystroke" && claude.pastePlaceholder, "Claude renders a placeholder");
  assert.equal(codex.kind === "keystroke" && codex.pastePlaceholder, null);
});

test("a harness says both WHAT its composer renders and WHEN, and the two agree", () => {
  // The pair is one fact asked at two moments, so a harness answering them inconsistently
  // sends the delivery path hunting a pane for something it has already been told does
  // not exist. The generic path asks; it never assumes - "a paste collapses when it is
  // multi-line" was true of Claude and of nothing else by right.
  for (const id of AGENT_TYPES) {
    const control = HARNESSES[id].control;
    if (control.kind !== "keystroke") continue;
    assert.equal(typeof control.collapses, "function", `${id} never says when its placeholder appears`);
    if (!control.pastePlaceholder) {
      assert.equal(
        control.collapses("a\nb"),
        false,
        `${id} renders no placeholder, so nothing it collapses could ever be seen`,
      );
    }
  }
});

test("Claude collapses a multi-line paste and echoes a one-liner, and says so itself", () => {
  // The claim the delivery path used to make on every harness's behalf, now made by the
  // one harness it was ever measured against. A one-liner is echoed in full, so there is
  // no placeholder to watch leave and the pre-Enter read is not worth taking.
  const claude = HARNESSES.claude.control;
  assert.ok(claude.kind === "keystroke");
  assert.equal(claude.kind === "keystroke" && claude.collapses("a\nb"), true);
  assert.equal(claude.kind === "keystroke" && claude.collapses("one line"), false);
});

test("the interface admits a harness driven without a terminal", () => {
  // The acceptance test for this boundary: a headless delivery has no settle window and
  // no composer to read, and must typecheck with no field left over. If a real
  // stream-json harness needs the interface widened, it was shaped around a pty.
  const headless: ControlSpec = { kind: "stream-json" };
  assert.equal(headless.kind, "stream-json");
  // And the keystroke fields must NOT be reachable on it - the point of the union is
  // that a caller cannot read `settleMs` off a harness that has no such notion.
  assert.equal("settleMs" in headless, false);
});

test("controlFor answers for a session without naming a vendor", () => {
  for (const id of AGENT_TYPES) {
    assert.equal(controlFor(session({ agent: id })), HARNESSES[id].control);
  }
});

// ---- a null placeholder is not "the composer is clear" ----

test("no placeholder means no evidence, whatever is on screen", () => {
  const claude = HARNESSES.claude.control;
  const placeholder = claude.kind === "keystroke" ? claude.pastePlaceholder : null;

  // The same screen, read with and without a placeholder to look for. A harness that
  // renders none cannot report a pending paste even when one is literally displayed -
  // which is why `false` here has to mean "no evidence", never "nothing pending".
  assert.equal(hasPendingPaste(PENDING, placeholder), true);
  assert.equal(hasPendingPaste(PENDING, null), false);
});

// ---- delivery degrades deliberately ----

test("a submit is verified by watching the paste leave the composer, not by one reading", async () => {
  // The only shape that earns `true`: the placeholder is on screen BEFORE the Enter and
  // gone after it, so the keystroke demonstrably landed rather than being swallowed. One
  // Enter still suffices - the verification claim changed, the keystroke budget did not.
  const { deps, calls } = harness([PENDING, CLEAR]);
  const r = await injectPrompt(session({ agent: "claude" }), "a\nb", deps);
  assert.equal(r.ok, true);
  assert.equal(r.pasted, true);
  assert.equal(r.submitVerified, true, "pending then gone IS the verification");
  assert.equal(enters(calls), 1);
});

test("the ORDINARY success reports verified, every time, not when it wins a redraw race", async () => {
  // The pending half is read before the Enter, where the paste is definitively collapsed,
  // so a healthy delivery cannot report unverified merely because the TUI redrew first.
  // Read only afterwards, this same delivery flipped run to run - and the one shape that
  // reliably still showed a placeholder was a SWALLOWED Enter, so the flag ran backwards.
  for (let run = 0; run < 5; run++) {
    const { deps, calls } = harness([PENDING, CLEAR]);
    const r = await injectPrompt(session({ agent: "claude" }), "a\nb", deps);
    assert.equal(r.submitVerified, true, `run ${run} must not differ from the others`);
    assert.equal(enters(calls), 1, `run ${run} must not differ from the others`);
  }
});

test("only the pre-Enter reading may establish a pending paste", async () => {
  // A placeholder that first appears AFTER the Enter is the paste sitting there
  // unsubmitted, not evidence that one left. Counting it would make the swallowed case
  // the verified case, which is exactly the inversion this window closes.
  const { deps } = harness([CLEAR, PENDING, CLEAR]);
  const r = await injectPrompt(session({ agent: "claude" }), "a\nb", deps);
  assert.equal(r.ok, true);
  assert.equal(r.submitVerified, false, "the composer was clear when we looked - nothing to watch leave");
});

test("a single-line prompt is ok and unverified, and pays for no reading it cannot use", async () => {
  // The COMMON case, and the one the flag used to lie about: a single-line paste is never
  // collapsed, so there is no placeholder to look for at any point. `false` here is "no
  // news", not "it failed" - and looking anyway would be a capture spent on a known answer.
  const { deps, calls, captures } = harness(CLEAR);
  const r = await injectPrompt(session({ agent: "claude" }), "one line", deps);
  assert.equal(r.ok, true);
  assert.equal(r.pasted, true);
  assert.equal(r.submitVerified, false, "an empty composer we never saw fill proves nothing");
  assert.equal(enters(calls), 1, "an unverifiable delivery must not cost extra keystrokes");
  assert.equal(captures(), 1, "the pre-Enter read is for collapsible pastes only");
});

test("a pre-Enter reading we could not take establishes nothing, and is not retried", async () => {
  // A failed capture is not "the composer is clear" and not "the paste is pending". The
  // delivery goes ahead on its own terms and reports unverified; re-reading to chase an
  // answer would spend the pane lock on a pane that just told us it cannot be read.
  const { deps, calls } = harness([null, CLEAR]);
  const r = await injectPrompt(session({ agent: "claude" }), "a\nb", deps);
  assert.equal(r.ok, true, "the delivery proceeds normally");
  assert.equal(r.submitVerified, false, "nothing was established, so nothing is claimed");
  assert.equal(enters(calls), 1);
});

test("a pane we cannot read is not a clear composer, and is given up on quickly", async () => {
  // A failed capture is evidence of nothing in either direction. Reading it as "the paste
  // is gone" is how a delivery nobody could see came back confirmed - and it must not buy
  // an extra Enter either, because that one would be aimed at a screen we cannot see.
  //
  // The bound is what keeps this cheap: the whole wait holds the pane lock, so polling a
  // dead pane for the full timeout refuses every other write to it for that long, with
  // dispatch's own 20s accept deadline sitting behind that.
  const { deps, calls, captures } = harness(null);
  const r = await injectPrompt(session({ agent: "claude" }), "a\nb", deps);
  assert.equal(r.ok, true, "the Enter we sent stands");
  assert.equal(r.submitVerified, false, "nothing on screen, therefore nothing verified");
  assert.equal(enters(calls), 1, "it must not keep firing at a pane it cannot read");
  assert.ok(captures() <= 4, `an unreadable pane cost ${captures()} captures under the lock`);
});

test("a harness with no placeholder spends ONE Enter and says the outcome is unverified", async () => {
  // The defect this capability closes. The pane still shows a pasted prompt, which for
  // Claude would drive the retry loop - but Codex renders no placeholder, so there is
  // nothing to gate a second Enter on. An ungated one is the keystroke that answers a
  // foreground dialog on the operator's behalf, so exactly one is sent.
  const { deps, calls } = harness(PENDING);
  const r = await injectPrompt(session({ agent: "codex" }), "a\nb", deps);
  assert.equal(r.pasted, true);
  assert.equal(enters(calls), 1, "no retry may be spent on evidence that cannot appear");
  assert.equal(r.submitVerified, false, "nothing was verified, and it must not read as success");
});

test("an unverified submit is reported as ok - but ok and unverified are distinguishable", async () => {
  // The whole point of the flag being required. Before it, this call and the verified one
  // above returned byte-identical results, so no caller could tell them apart. Same pane,
  // same sequence, two harnesses: only the one that renders a placeholder can verify.
  const { deps: cdeps } = harness([PENDING, CLEAR]);
  const claude = await injectPrompt(session({ agent: "claude" }), "a\nb", cdeps);
  const { deps: xdeps } = harness([PENDING, CLEAR]);
  const codex = await injectPrompt(session({ agent: "codex" }), "a\nb", xdeps);

  assert.equal(claude.ok, true);
  assert.equal(codex.ok, true);
  assert.notEqual(
    claude.submitVerified,
    codex.submitVerified,
    "the same ok must not hide two different claims",
  );
});

test("a paste that never landed is unverified too, and stays retryable", async () => {
  // `pasted: false` is the only state a caller may retry from, and a failure before any
  // Enter cannot have verified anything. The two flags must not disagree.
  const deps: InjectDeps = {
    pane: (session) =>
      bindSession(session, async () => stubRun({ stdout: "", stderr: "no such pane", code: 1 })),
    capture: async () => null,
    sleep: async () => {},
  };
  const r = await injectPrompt(session({ agent: "claude" }), "a\nb", deps);
  assert.equal(r.ok, false);
  assert.equal(r.pasted, false);
  assert.equal(r.submitVerified, false);
});

test("a session with no pane is refused without claiming a verified submit", async () => {
  const { deps } = harness(null);
  const r = await injectPrompt(session({ agent: "claude", terminals: [] }), "a\nb", deps);
  assert.equal(r.ok, false);
  assert.equal(r.pasted, false);
  assert.equal(r.submitVerified, false);
});
