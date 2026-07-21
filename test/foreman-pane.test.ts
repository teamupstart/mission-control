import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, paneSection } from "../src/server/foreman/prompt.ts";
import type { ReviewInput } from "../src/server/foreman/prompt.ts";
import { buildTriagePrompt } from "../src/server/foreman/triage-prompt.ts";
import { mapTriage, triageSession } from "../src/server/foreman/triage.ts";
import type { ScanWindow, TriageDeps, TriageReport } from "../src/server/foreman/triage.ts";
import type { Pending } from "../src/server/foreman/pending.ts";
import type { ForemanConfig } from "../src/shared/protocol.ts";
import type { Session, SessionState, TranscriptMessage } from "../src/shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// The child's screen as an input to Foreman's reviewers (see `ReviewInput.pane`).
//
// The bug these lock down was measured on the live sessions, not imagined: a session sat at an
// `AskUserQuestion` menu while Foreman recorded `disposition: skipped` with the reason "the
// pending item's content is not visible in the transcript" - and it was right. Claude appends an
// assistant turn when it COMPLETES, so a tool call blocked on the user is absent from the
// transcript until it returns; the transcript's last turn predated the notification hook by 44
// seconds. `Pending.question` was the hook's generic "Claude needs your permission". Foreman was
// asked to answer a question that appeared in neither of its inputs, on the one surface it exists
// to drain.

/** The live pane that produced the skip, trimmed to the shape that matters. */
const REAL_MENU = `
 ☐ Holder policy

Review finding \`pool-reaps-any-holders-lease-workspace-wide\` (src/server/pool.ts, ask-user):
The reap gate never looks at \`tree.holder\`. Which holder policy do you want?

  1. Only reap mission-control leases (Recommended)
     Reap only leases whose recorded holder is 'mission-control'.
  2. Reap any holder, but only repos we know
     Keep reaping regardless of holder, but drop the workspace-wide scan.
❯ 3. Keep as-is (any holder, workspace-wide)
     Ship current behavior: maximum reclamation.

Enter to select · ↑/↓ to navigate · Esc to cancel
`.trim();

/** The generic line the Notification hook produces - it never names what is being approved. */
const HOOK_LINE = "Claude needs your permission";

function msg(text: string, id = "m1"): TranscriptMessage {
  return { id, role: "assistant", text, ts: 1, tools: [] };
}

function input(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    session: {
      agent: "claude",
      name: "worktree cleanup",
      cwd: "/repo",
      gitBranch: "mancej/reap-leaked-worktree-leases",
      state: "awaiting_input",
      activity: HOOK_LINE,
      goal: "Reap leaked worktree leases",
    },
    surface: "terminal",
    question: HOOK_LINE,
    // The real shape: the transcript ends BEFORE the ask, on the tool call that preceded it.
    transcript: [msg("Round 4 surfaced something important. Let me read the full reasoning.")],
    truncated: false,
    // No standing instructions - these cases are about the screen.
    instructions: "",
    ...over,
  };
}

test("the review prompt carries the ask the transcript cannot hold", () => {
  // The regression, stated as the reviewer sees it: with only the hook line and a transcript
  // that stops short of the ask, nothing in the prompt says what is being decided.
  const blind = buildReviewPrompt(input());
  assert.ok(!blind.includes("Holder policy"), "precondition: the transcript does not carry the ask");

  const seeing = buildReviewPrompt(input({ pane: REAL_MENU }));
  assert.ok(seeing.includes("Holder policy"), "the reviewer can now read the question");
  assert.ok(seeing.includes("Only reap mission-control leases"), "...and the options it must choose between");
});

test("the review prompt stops telling the reviewer to infer a missing question from the transcript", () => {
  // The old stand-in pointed at "the transcript tail" - the one place a blocked ask is
  // guaranteed not to be. Advice that is wrong exactly when it is followed.
  const p = buildReviewPrompt(input({ question: "", pane: REAL_MENU }));
  assert.ok(!p.includes("infer it from the transcript tail"));
  assert.ok(p.includes("terminal screen"));
});

test("the POLICY names the empty transcript tail as normal rather than a reason to skip", () => {
  // The skip clause is what fired on the live sessions, so the fix is not just supplying the pane -
  // it is retiring the reading that made an absent ask look like an unanswerable one.
  //
  // Asserted against the prompt with whitespace collapsed: the POLICY is hand-wrapped prose, so
  // matching raw text would pin a sentence to the column it happens to break at today and fail
  // the next time someone reflows a paragraph without changing a word of the contract.
  const p = flat(buildReviewPrompt(input({ pane: REAL_MENU })));
  assert.ok(p.includes("the transcript almost always ENDS BEFORE the pending ask"), "the POLICY explains the absence");
  assert.ok(p.includes("That is normal and is NOT a reason to skip"), "...and withdraws it as grounds to skip");
});

/** Collapse the hand-wrapped prompt to one line, so an assertion tests wording and not layout. */
function flat(s: string): string {
  return s.replace(/\s+/g, " ");
}

test("the router prompt gets the same screen as the full reviewer", () => {
  // Both tiers bucket/judge the same ask; a prompt that saw it and one that didn't would make
  // the shadow-mode divergence log measure the input gap instead of the tier.
  const p = buildTriagePrompt(input({ pane: REAL_MENU }));
  assert.ok(p.includes("Holder policy"));
});

test("paneSection is omitted entirely when there is no screen to show", () => {
  // Absent, not "(no pane)": the POLICY promises the ask is on the screen, so an empty section
  // under that promise reads as "the child is showing nothing" rather than "Foreman couldn't look".
  assert.deepEqual(paneSection(input({ pane: null })), []);
  assert.deepEqual(paneSection(input({ pane: "   " })), [], "a whitespace-only capture is no screen");
});

test("paneSection is omitted on the input-review surface", () => {
  // An input review carries its whole body as the question; the screen is not another witness
  // to it, just a costlier one.
  assert.deepEqual(paneSection(input({ surface: "input-review", pane: REAL_MENU })), []);
});

// ---- the denylist backstop ----

function pend(over: Partial<Pending> = {}): Pending {
  return {
    situation: "terminal-pane",
    surface: "terminal",
    question: HOOK_LINE,
    inputReviewId: null,
    canSend: true,
    marker: "await:1",
    ...over,
  };
}

function report(over: Partial<TriageReport> = {}): TriageReport {
  return { purpose: "p", bucket: "routine-access", answer: { text: "Approve - go ahead." }, confidence: 0.9, ...over };
}

function scan(over: Partial<ScanWindow> = {}): ScanWindow {
  return { messages: [msg("Ready to run the unit tests for the refactor.")], ...over };
}

test("mapTriage escalates when the SCREEN names a destructive command the turns never did", () => {
  // The hole this closes: on a permission prompt the command lives in the dialog. `question` is
  // the hook's generic line and the reply is the router's own "Approve - go ahead.", so before
  // the screen was scanned the denylist's whole subject was visible only if the child happened
  // to narrate it in prose first. A permission dialog naming `rm -rf` read as clean.
  const out = mapTriage(report(), pend(), scan({ pane: "Bash(rm -rf build/)\n\nDo you want to proceed?" }));
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate", "must NOT be typed into the pane");
  assert.equal(out.reason, "access-risky-escalated");
});

test("mapTriage still answers a routine ask when the screen is clean", () => {
  // The scan only ever ADDS a reason to escalate; a clean screen must not cost the disposal.
  const out = mapTriage(report(), pend(), scan({ pane: "Bash(npm test)\n\nDo you want to proceed?" }));
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "answer");
});

test("a screen does not satisfy the no-context backstop", () => {
  // Backstop 3(a) still keys on the TURNS alone. The screen makes "a prose-free window means the
  // ask went unread" false, so this gate could now be relaxed - but that LOOSENS it, and per the
  // precedent in `hasProse` it belongs in its own change with its own shadow measurement. Until
  // then a prose-free window routes up even with a screen in hand: the safe direction, unchanged.
  const out = mapTriage(report(), pend(), { messages: [], pane: "Bash(npm test)\n\nDo you want to proceed?" });
  assert.equal(out.kind, "route-up");
  if (out.kind !== "route-up") return;
  assert.equal(out.reason, "no-transcript-context");
});

// ---- triageSession wiring ----

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1", agent: "claude", name: "sess", nameSource: "process", state: "awaiting_input" as SessionState,
    cwd: "/repo", gitBranch: null, gitRoot: null, repoRoot: null, nomistakesGated: false, pid: 1, tty: null,
    permissionMode: null, terminals: [mkMuxHandle({ session: "m", windowIndex: 1 })],
    agentSessionId: null, transcriptPath: null, instrumented: true, hooksSeen: true, activity: HOOK_LINE,
    startedAt: null, firstSeen: 0, lastSeen: 0, lastActivity: 1, pendingReviews: 0, nomistakes: null,
    nomistakesFixes: [], nomistakesNarration: null, task: null, prUrl: null, prNumber: null, prState: null,
    prChecks: null, meta: null, note: null, cost: null, goal: null, queue: null, orphanedQueue: null,
    inspector: null,
    paneDialog: null,
    ...over,
  };
}

function cfg(over: Partial<ForemanConfig> = {}): ForemanConfig {
  return {
    enabled: true, mode: "live", repoAllowlist: ["/repo"], autoApproveAccess: true,
    triage: "on", maxFixAttempts: 3, maxFixRounds: 10,
    wrapupTriggers: ["drain"], wrapup: "ask",
    autoBacklog: false, maxSessions: 3, backlogRespectOpenPrs: true,
    ...over,
  };
}

function deps(over: Partial<TriageDeps> = {}): TriageDeps {
  return {
    transcript: async () => ({ messages: [msg("Ready to run the unit tests.")], truncated: false }),
    runModel: async () => JSON.stringify(report()),
    ...over,
  };
}

test("triageSession puts the screen it was handed in the router's prompt", async () => {
  let prompt = "";
  await triageSession(
    deps({ runModel: async (p) => ((prompt = p), JSON.stringify(report())) }),
    pend(),
    mkSession(),
    cfg(),
    { pane: REAL_MENU, instructions: "" },
  );
  assert.ok(prompt.includes("Holder policy"), "the router buckets an ask it has actually read");
});

test("triageSession scans the screen it was handed", async () => {
  // End to end through the tier: the screen must reach the backstop, not just the prompt.
  const out = await triageSession(
    deps(),
    pend(),
    mkSession(),
    cfg(),
    { pane: "Bash(rm -rf build/)\n\nDo you want to proceed?", instructions: "" },
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
});

test("triageSession captures no screen of its own - it reads the one the worker captured", async () => {
  // The tier has no way to fetch a pane (`TriageDeps` carries none), which is the invariant
  // rather than a habit: the worker checks what this tier ANSWERS against its own copy of the
  // screen, so a second capture here would be a second screen, and the router would be judged
  // against rows it was never shown. Whether a surface has a screen at all is the caller's
  // question now - see `paneFor`, which reads one for the terminal surface only.
  assert.equal("pane" in deps(), false, "no pane fetch on the cheap tier's dependency surface");
  let prompt = "";
  await triageSession(
    deps({ runModel: async (p) => ((prompt = p), JSON.stringify(report())) }),
    pend({ situation: "input-review", surface: "input-review", question: "Should I use option B?", canSend: false }),
    mkSession(),
    cfg(),
    { pane: null, instructions: "" },
  );
  assert.ok(!prompt.includes("Holder policy"), "an input review carries its whole body already");
});

test("triageSession survives a screen that couldn't be read", async () => {
  // `ForemanClient.pane` answers an unreadable pane with null rather than a throw, so this is
  // the shape a failed capture arrives in. The fallback is the pre-existing behaviour: an
  // unreadable pane must cost the improvement and nothing else - never the review itself.
  const out = await triageSession(deps(), pend(), mkSession(), cfg(), { pane: null, instructions: "" });
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "answer");
});
