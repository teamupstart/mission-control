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
// So this pins the three claims the capability makes:
//   1. Every harness declares a delivery, and `control` is not nullable - there is no
//      harness we can dispatch to without knowing how to talk to it.
//   2. A null `pastePlaceholder` is a CAPABILITY absence, not "the composer is clear",
//      and the delivery path degrades on it deliberately instead of looping for evidence
//      that cannot appear.
//   3. `ok: true` without evidence is reported as unverified rather than as success.

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

after(() => rmSync(home, { recursive: true, force: true }));

const TMUX = { session: "s", window: "w", windowIndex: 0, paneId: "%1" };
const session = (over: Partial<Session>): Session =>
  ({ id: "s1", agent: "claude", tmux: TMUX, wezterm: null, ...over }) as Session;

/** Every pane read comes back as `text`; every command succeeds. */
function harness(text: string | null): { deps: InjectDeps; calls: string[][] } {
  const calls: string[][] = [];
  const deps: InjectDeps = {
    exec: async (bin, args) => {
      calls.push([bin, ...args]);
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
    capture: async () => text,
    sleep: async () => {},
  };
  return { deps, calls };
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
  const pane = "❯ [Pasted text #1 +3 lines]\n⏵⏵ auto mode on";

  // The same screen, read with and without a placeholder to look for. A harness that
  // renders none cannot report a pending paste even when one is literally displayed -
  // which is why `false` here has to mean "no evidence", never "nothing pending".
  assert.equal(hasPendingPaste(pane, placeholder), true);
  assert.equal(hasPendingPaste(pane, null), false);
});

// ---- delivery degrades deliberately ----

test("a harness that can verify keeps pressing Enter until the composer clears", async () => {
  // Claude's path, unchanged: the placeholder is gone on the read back, so one Enter is
  // enough and the submit is reported as actually verified.
  const { deps, calls } = harness("❯\n⏵⏵ auto mode on");
  const r = await injectPrompt(session({ agent: "claude" }), "a\nb", deps);
  assert.equal(r.ok, true);
  assert.equal(r.pasted, true);
  assert.equal(r.submitVerified, true, "seeing the composer clear IS the verification");
  assert.equal(enters(calls), 1);
});

test("a harness with no placeholder spends ONE Enter and says the outcome is unverified", async () => {
  // The defect this capability closes. The pane still shows a pasted prompt, which for
  // Claude would drive the retry loop - but Codex renders no placeholder, so there is
  // nothing to gate a second Enter on. An ungated one is the keystroke that answers a
  // foreground dialog on the operator's behalf, so exactly one is sent.
  const { deps, calls } = harness("❯ [Pasted text #1 +3 lines]\nsomething on screen");
  const r = await injectPrompt(session({ agent: "codex" }), "a\nb", deps);
  assert.equal(r.pasted, true);
  assert.equal(enters(calls), 1, "no retry may be spent on evidence that cannot appear");
  assert.equal(r.submitVerified, false, "nothing was verified, and it must not read as success");
});

test("an unverified submit is reported as ok - but ok and unverified are distinguishable", async () => {
  // The whole point of the flag being required. Before it, this call and the verified one
  // above returned byte-identical results, so no caller could tell them apart.
  const { deps: cdeps } = harness("❯ clear");
  const claude = await injectPrompt(session({ agent: "claude" }), "a\nb", cdeps);
  const { deps: xdeps } = harness("❯ clear");
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
    exec: async () => stubRun({ stdout: "", stderr: "no such pane", code: 1 }),
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
  const r = await injectPrompt(session({ agent: "claude", tmux: null, wezterm: null }), "a\nb", deps);
  assert.equal(r.ok, false);
  assert.equal(r.pasted, false);
  assert.equal(r.submitVerified, false);
});
