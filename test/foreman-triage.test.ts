import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDivergence,
  isDestructive,
  mapTriage,
  tier0,
  triagePosture,
  triageSession,
  TIER1_HEAD_TURNS,
  TIER1_TURNS,
  type ScanWindow,
  type TriageDeps,
  type TriageReport,
} from "../src/server/foreman/triage.ts";
import { NO_QUESTION_PLACEHOLDER } from "../src/server/foreman/pending.ts";
import type { Pending } from "../src/server/foreman/pending.ts";
import type { TranscriptMessage } from "../src/shared/types.ts";
import { planFromVerdict } from "../src/server/foreman/verdict.ts";
import type { ReviewContext, Verdict } from "../src/server/foreman/verdict.ts";
import type { ForemanConfig } from "../src/shared/protocol.ts";
import type { Session, SessionState } from "../src/shared/types.ts";

function pend(over: Partial<Pending> = {}): Pending {
  return {
    situation: "terminal-pane",
    surface: "terminal",
    question: "Can I run the test suite?",
    inputReviewId: null,
    canSend: true,
    marker: "await:1",
    ...over,
  };
}

function report(over: Partial<TriageReport> = {}): TriageReport {
  return {
    purpose: "Child wants to run the tests before pushing.",
    bucket: "routine-access",
    answer: { text: "Approve - go ahead." },
    confidence: 0.9,
    ...over,
  };
}

/**
 * A transcript turn as `toMessage` builds one: prose + tool NAMES, never tool inputs. Each gets
 * a distinct id, like the record uuids the real reader emits - the prompt window de-dupes on it.
 */
let msgSeq = 0;
function msg(text: string, tools: string[] = []): TranscriptMessage {
  return { id: `m${++msgSeq}`, role: "assistant", text, tools, ts: 1 };
}

/** A clean (non-destructive) Tier 1 scan window - enough context for the denylist to have scanned. */
function cleanWindow(): ScanWindow {
  return { messages: [msg("Ready to run the unit tests for the refactor.", ["Read"])] };
}

// ---- Tier 0 (pure structural gate) ----

test("tier0: a non-input review is disposed as skip with a review-named purpose", () => {
  const out = tier0(pend({ situation: "non-input-review", reviewKind: "plan", reviewTitle: "Refactor auth" }));
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.tier, 0);
  assert.equal(out.verdict.action, "skip");
  assert.match(out.verdict.purpose, /plan review "Refactor auth"/);
});

test("tier0: terminal-no-pane routes up - its question is never self-contained enough to escalate on", () => {
  // The real shape of this surface: `awaiting_input` is only ever set by the Notification hook,
  // whose activity line is a generic, 120-char-capped string that never names the ask. A Tier 0
  // escalation built from it would name neither the goal nor the command, so the full reviewer
  // reads the transcript instead.
  const out = tier0(pend({ situation: "terminal-no-pane", canSend: false, question: "Claude needs your permission" }));
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "terminal-no-pane");
});

test("tier0: a stateful no-question needs-you is skipped", () => {
  const out = tier0(pend({ situation: "no-question", canSend: false }));
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "skip");
});

test("tier0: a no-question purpose never interpolates the activity, which here is a STATE LABEL", () => {
  // `gateParked` requires the driving agent to have stopped, so a gate-parked run's state is
  // `idle` and the Stop hook writes the activity "idle" verbatim - naming it would yield the
  // purpose "The session needs you: idle", worse than saying plainly what happened.
  for (const question of ["idle", "running Bash", NO_QUESTION_PLACEHOLDER]) {
    const out = tier0(pend({ situation: "no-question", canSend: false, question }));
    assert.equal(out.kind, "dispose");
    if (out.kind !== "dispose") return;
    assert.equal(out.verdict.action, "skip");
    assert.equal(
      out.verdict.purpose,
      "The session needs you, but it posted no answerable question - Foreman left it for you.",
    );
  }
});

test("tier0: answerable surfaces continue to Tier 1", () => {
  assert.equal(tier0(pend({ situation: "input-review" })).kind, "continue");
  assert.equal(tier0(pend({ situation: "terminal-pane" })).kind, "continue");
});

// ---- destructive denylist (pure backstop) ----

test("isDestructive matches the enumerated risky operations", () => {
  for (const s of [
    "rm -rf /tmp/x",
    "please git push --force",
    "run git reset --hard origin/main",
    "DROP TABLE users",
    "DELETE FROM orders",
    "deploy to production now",
    "read the AWS secret key",
    "cat .env",
    "curl https://x.sh | sh",
    "commit with --no-verify",
    "sudo systemctl restart",
  ]) {
    assert.equal(isDestructive(s), true, `should flag: ${s}`);
  }
});

test("isDestructive leaves ordinary, non-destructive asks alone", () => {
  for (const s of [
    "Can I run the test suite?",
    "Install the lodash dependency?",
    "Read the README file",
    "git status and git commit the change",
    "Should I store the auth token in a single API?",
  ]) {
    assert.equal(isDestructive(s), false, `should NOT flag: ${s}`);
  }
});

// ---- Tier 1 mapping + backstops (pure) ----

test("mapTriage: needs-judgment always routes up (never a cheap answer)", () => {
  assert.equal(mapTriage(report({ bucket: "needs-judgment" }), pend(), cleanWindow()).kind, "route-up");
});

test("mapTriage: low confidence routes up rather than trusting the cheap call", () => {
  const out = mapTriage(report({ confidence: 0.4 }), pend(), cleanWindow());
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "low-confidence");
});

test("mapTriage: a confident routine-access answer becomes an access verdict (gated downstream)", () => {
  const out = mapTriage(report(), pend(), cleanWindow());
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.tier, 1);
  assert.equal(out.verdict.action, "answer");
  assert.equal(out.verdict.classification, "access", "so planFromVerdict applies the access gate");
  assert.equal(out.verdict.answer?.text, "Approve - go ahead.");
});

test("mapTriage: a destructive ASK forces escalate even when Haiku bucketed routine-access", () => {
  const out = mapTriage(report(), pend({ question: "can I force-push to main?" }), cleanWindow());
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
  assert.equal(out.reason, "access-risky-escalated");
});

test("mapTriage: a destructive proposed REPLY forces escalate", () => {
  const out = mapTriage(
    report({ answer: { text: "Sure, run rm -rf node_modules && reinstall" } }),
    pend({ question: "clean deps?" }),
    cleanWindow(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
});

test("mapTriage: a destructive WINDOW forces escalate when the ask itself looks innocuous", () => {
  // The terminal surface's real shape: a generic notification for a question, an innocuous
  // approval for a reply - the recent prose is the only place the command is ever named.
  const out = mapTriage(report(), pend({ question: "Claude needs your permission" }), {
    messages: [msg("I'll clear the stale build output with rm -rf build/ and rebuild.")],
  });
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
  assert.equal(out.reason, "access-risky-escalated");
});

test("mapTriage: a clean window still allows the routine-access answer", () => {
  const out = mapTriage(report(), pend({ question: "Claude needs your permission" }), {
    messages: [msg("I'll run the unit tests now to confirm the refactor holds.")],
  });
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "answer");
});

test("mapTriage: an EMPTY window can never take the auto-answer (nothing was scanned)", () => {
  // `risky === false` over an empty window means "unknown", not "safe" - the one outcome
  // that ACTS must not be taken on it. This is the whole reason the window is a parameter
  // rather than a pre-flattened string: an empty string cannot say WHY it is empty.
  const out = mapTriage(report(), pend({ question: "Claude needs your permission" }), { messages: [] });
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "no-transcript-context");
});

test("mapTriage: a PROSE-FREE window can never take the auto-answer either", () => {
  // A bare tool call survives `toMessage` (it drops a turn only when it has neither text nor
  // tools), and flattens to the tool NAME alone - "Bash" names no command, so the denylist
  // scanned nothing even though the window is 12 turns long. Counting turns would wave this
  // through; the gate keys on prose for exactly this shape.
  const out = mapTriage(
    report(),
    pend({ question: "Claude needs your permission" }),
    { messages: Array.from({ length: 12 }, () => msg("", ["Bash"])) },
  );
  assert.equal(out.kind, "route-up", "must NOT type an approval into the pane");
  if (out.kind === "route-up") assert.equal(out.reason, "no-transcript-context");
});

test("mapTriage: a window with a prose turn from the USER side counts as scanned", () => {
  // The gate has no role filter and claims none: it mirrors `riskContextFrom`, which scans both
  // roles because the human's prose names the command about as often as the child's does.
  const out = mapTriage(report(), pend({ question: "Claude needs your permission" }), {
    messages: [{ ...msg("Go ahead and run the unit tests."), role: "user" }],
  });
  assert.equal(out.kind, "dispose");
  if (out.kind === "dispose") assert.equal(out.verdict.action, "answer");
});

test("mapTriage: an INPUT REVIEW still answers on an empty window - its question IS the ask", () => {
  // The prose gate is terminal-only on purpose. Here `question` is the child's own review body,
  // which backstop 1 scanned in full, so the window corroborates rather than witnesses - gating
  // this surface on prose would route up an ask that was perfectly scannable.
  const out = mapTriage(
    report(),
    pend({ situation: "input-review", surface: "input-review", question: "Can I install the lodash dependency?", inputReviewId: "r1", canSend: false }),
    { messages: [], unavailable: true },
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "answer");
  assert.equal(out.verdict.classification, "access", "still gated downstream like any access answer");
});

test("mapTriage: an input review's own question is still denylist-scanned on an empty window", () => {
  // The flip side: dropping the prose gate here costs nothing precisely BECAUSE backstop 1 reads
  // this surface's question directly.
  const out = mapTriage(
    report(),
    pend({ situation: "input-review", surface: "input-review", question: "Can I force-push the rebase to main?", inputReviewId: "r1", canSend: false }),
    { messages: [] },
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
  assert.equal(out.reason, "access-risky-escalated");
});

test("mapTriage: an `unavailable` window routes up as no-transcript-file, not no-transcript-context", () => {
  const out = mapTriage(report(), pend({ question: "Claude needs your permission" }), {
    messages: [],
    unavailable: true,
  });
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "no-transcript-file");
});

test("mapTriage: one prose turn among tool calls is enough to have scanned", () => {
  // The gate asks whether there was anything to scan, not how much - a single line of the
  // child's own prose is a real view of what it is about to run, so Tier 1 may answer.
  const out = mapTriage(report(), pend({ question: "Claude needs your permission" }), {
    messages: [
      msg("", ["Bash"]),
      msg("Running the unit tests now to confirm the refactor holds.", ["Bash"]),
      msg("", ["Read"]),
    ],
  });
  assert.equal(out.kind, "dispose");
  if (out.kind === "dispose") assert.equal(out.verdict.action, "answer");
});

test("mapTriage: an empty window still allows the safe directions (skip + escalate)", () => {
  const esc = mapTriage(report({ bucket: "human-only", disposition: "escalate", answer: undefined }), pend(), { messages: [] });
  assert.equal(esc.kind, "dispose");
  if (esc.kind === "dispose") assert.equal(esc.verdict.action, "escalate");

  const skip = mapTriage(report({ bucket: "human-only", disposition: "skip", answer: undefined }), pend(), { messages: [] });
  assert.equal(skip.kind, "dispose");
  if (skip.kind === "dispose") assert.equal(skip.verdict.action, "skip");
});

test("mapTriage: a destructive ask on an empty window escalates (more useful than routing up)", () => {
  const out = mapTriage(report(), pend({ question: "can I force-push to main?" }), { messages: [] });
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
});

test("mapTriage: routine-access with no answer text routes up rather than guessing", () => {
  const out = mapTriage(report({ answer: undefined }), pend(), cleanWindow());
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "access-without-answer");
});

test("mapTriage: human-only escalate carries the brief + recommendation", () => {
  const out = mapTriage(
    report({ bucket: "human-only", disposition: "escalate", brief: "## Fork\nA vs B", recommendation: "Lean A", answer: undefined }),
    pend(),
    cleanWindow(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
  assert.equal(out.verdict.brief, "## Fork\nA vs B");
  assert.equal(out.verdict.recommendation, "Lean A");
});

test("mapTriage: human-only skip is allowed only for a non-risky ask", () => {
  const skip = mapTriage(
    report({ bucket: "human-only", disposition: "skip", answer: undefined }),
    pend({ question: "just a diff review" }),
    cleanWindow(),
  );
  assert.equal(skip.kind, "dispose");
  if (skip.kind === "dispose") assert.equal(skip.verdict.action, "skip");

  // A risky ask can never be quietly skipped - it is surfaced (escalated).
  const risky = mapTriage(
    report({ bucket: "human-only", disposition: "skip", answer: undefined }),
    pend({ question: "drop the users table?" }),
    cleanWindow(),
  );
  assert.equal(risky.kind, "dispose");
  if (risky.kind === "dispose") assert.equal(risky.verdict.action, "escalate");
});

// ---- shadow-mode divergence classifier (pure) ----

function opus(action: Verdict["action"]): Verdict {
  const base = { purpose: "p", classification: "other" as const };
  if (action === "answer") return { ...base, action, answer: { text: "go", submit: true } };
  return { ...base, action };
}

test("classifyDivergence: a route-up is a deferral (nothing to compare)", () => {
  assert.equal(classifyDivergence({ kind: "route-up", reason: "x" }, opus("answer")), "deferred");
});

test("classifyDivergence: agree, over-eager, too-cautious, minor", () => {
  const answer = mapTriage(report(), pend(), cleanWindow()); // cheap answer
  assert.equal(classifyDivergence(answer, opus("answer")), "agree");
  assert.equal(classifyDivergence(answer, opus("escalate")), "cheap-over-eager");

  const skip = tier0(pend({ situation: "no-question" })); // cheap skip
  assert.equal(skip.kind, "dispose");
  if (skip.kind !== "dispose") return;
  assert.equal(classifyDivergence(skip, opus("answer")), "cheap-too-cautious");
  assert.equal(classifyDivergence(skip, opus("escalate")), "minor");
});

// ---- triageSession orchestration with injected fakes (no real subprocess) ----

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1", agent: "claude", name: "sess", nameSource: "process", state: "awaiting_input" as SessionState,
    cwd: "/repo", gitBranch: null, gitRoot: null, nomistakesGated: false, pid: 1, tty: null, permissionMode: null,
    wezterm: null, tmux: { session: "m", window: "w", windowIndex: 1, paneId: "%1" }, agentSessionId: null,
    transcriptPath: null, instrumented: true, activity: "Approve?",
    startedAt: null, firstSeen: 0, lastSeen: 0, lastActivity: 1, pendingReviews: 0, nomistakes: null,
    nomistakesNarration: null, task: null, prUrl: null, prNumber: null, prState: null, prChecks: null, meta: null, note: null,
    ...over,
  };
}

function cfg(over: Partial<ForemanConfig> = {}): ForemanConfig {
  return { enabled: true, mode: "live", repoAllowlist: ["/repo"], autoApproveAccess: true, triage: "on", ...over };
}

function deps(over: Partial<TriageDeps> = {}): TriageDeps {
  return {
    // A real (clean) window by default: an empty one is a gated case in its own right, so
    // defaulting to it would quietly turn every case below into a no-transcript route-up.
    transcript: async () => ({ messages: cleanWindow().messages, truncated: false }),
    runModel: async () => JSON.stringify(report()),
    ...over,
  };
}

test("triageSession: Tier 0 disposes without ever calling the model", async () => {
  let calls = 0;
  const out = await triageSession(
    deps({ runModel: async () => (calls++, "{}") }),
    pend({ situation: "non-input-review", reviewKind: "diff", reviewTitle: "T" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  assert.equal(calls, 0, "Tier 0 short-circuits before spawning Haiku");
});

test("triageSession: an answerable surface runs Tier 1 and disposes on a routine-access reply", async () => {
  const out = await triageSession(deps(), pend({ situation: "terminal-pane" }), mkSession(), cfg());
  assert.equal(out.kind, "dispose");
  if (out.kind === "dispose") {
    assert.equal(out.tier, 1);
    assert.equal(out.verdict.classification, "access");
  }
});

test("triageSession: a destructive command in the transcript prose escalates a terminal-pane approval", async () => {
  // The exact live shape the denylist has to survive: `question` is the generic notification
  // string the Notification hook produces (it never carries the command), and the router's
  // reply is its own innocuous "Approve - go ahead." - so the Tier 1 window is the only
  // place `rm -rf` is visible to code.
  const out = await triageSession(
    deps({ transcript: async () => ({ messages: [msg("Next I'll run rm -rf build/ to clear the stale output.")], truncated: false }) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession({ activity: "Claude needs your permission" }),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate", "must NOT be typed into the pane");
  assert.equal(out.reason, "access-risky-escalated");
});

test("triageSession: a clean transcript still lets the routine-access answer through", async () => {
  const out = await triageSession(
    deps({ transcript: async () => ({ messages: [msg("Ready to run the unit tests for the refactor.", ["Read"])], truncated: false }) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession({ activity: "Claude needs your permission" }),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "answer");
  assert.equal(out.verdict.classification, "access");
});

test("triageSession: an EMPTY window routes up rather than auto-answering (the denylist scanned nothing)", async () => {
  // With no prose, backstop 1 has no text to match, so `risky === false` means "unknown",
  // not "safe" - and on the terminal surface the question is a generic notification and the
  // reply is Haiku's own "Approve - go ahead.", so nothing else can catch a risky ask either.
  const out = await triageSession(
    deps({ transcript: async () => ({ messages: [], truncated: false }) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession({ activity: "Claude needs your permission" }),
    cfg(),
  );
  assert.equal(out.kind, "route-up", "must NOT type an approval into the pane");
  if (out.kind === "route-up") assert.equal(out.reason, "no-transcript-context");
});

test("triageSession: a window of pure TOOL CALLS routes up (tool names name no command)", async () => {
  // A tool-heavy stretch with no interleaved prose is an ordinary shape for agent work, and it
  // reaches the router as a full-length window carrying nothing the denylist can match.
  const out = await triageSession(
    deps({
      transcript: async () => ({ messages: Array.from({ length: 12 }, () => msg("", ["Bash"])), truncated: false }),
    }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession({ activity: "Claude needs your permission" }),
    cfg(),
  );
  assert.equal(out.kind, "route-up", "must NOT type an approval into the pane");
  if (out.kind === "route-up") assert.equal(out.reason, "no-transcript-context");
});

test("triageSession: an `unavailable` window routes up with its OWN reason, not the generic one", async () => {
  // "no transcript file at all" and "the window came back empty" are different diagnoses, and
  // the worker log is the only place this feature's accuracy gets measured - so they must not
  // read alike there.
  const out = await triageSession(
    deps({ transcript: async () => ({ messages: [], truncated: false, unavailable: true }) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "no-transcript-file");
});

test("triageSession: an INPUT REVIEW with no transcript at all still answers", async () => {
  // The efficacy case the terminal-only prose gate buys back: the reviewer would fetch the same
  // empty window and read the same question, so deferring here costs an Opus call for no extra
  // information. The ask itself was fully scanned by the denylist.
  const out = await triageSession(
    deps({ transcript: async () => ({ messages: [], truncated: false, unavailable: true }) }),
    pend({ situation: "input-review", surface: "input-review", question: "Can I install the lodash dependency?", inputReviewId: "r1", canSend: false }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.tier, 1);
  assert.equal(out.verdict.action, "answer");
  assert.equal(out.reason, "routine-access");
});

test("triageSession: a transcript FETCH FAILURE routes up rather than auto-answering", async () => {
  const out = await triageSession(
    deps({ transcript: async () => { throw new Error("500"); } }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "route-up");
  // A daemon that failed to answer is not a session without a transcript - keep them apart.
  if (out.kind === "route-up") assert.equal(out.reason, "no-transcript-context");
});

test("triageSession: an empty window still allows the SAFE directions (escalate)", async () => {
  // Routing down is always allowed - only the auto-answer path acts, so only it is gated.
  const out = await triageSession(
    deps({
      transcript: async () => ({ messages: [], truncated: false, unavailable: true }),
      runModel: async () => JSON.stringify(report({ bucket: "human-only", disposition: "escalate", answer: undefined })),
    }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
});

test("triageSession: the window is bounded to TIER1_TURNS, so old history can't force an escalation", async () => {
  // The endpoint's `turns` is only a byte-bound hint - under its byte budget it returns the
  // file WHOLE - so a session that once mentioned `.env` forty turns ago would otherwise
  // escalate every routine ask for the rest of its life, collapsing Tier 1's only disposal.
  const old = Array.from({ length: 30 }, (_, i) => msg(`Turn ${i}: I'll read the API key from .env to wire auth.`));
  const recent = Array.from({ length: TIER1_TURNS }, () => msg("Running the unit tests for the refactor."));
  const out = await triageSession(
    deps({ transcript: async () => ({ messages: [...old, ...recent], truncated: false }) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "answer", "stale history beyond the window must not poison the scan");
});

test("triageSession: a destructive command in a RECENT turn still forces escalate", async () => {
  const old = Array.from({ length: 30 }, () => msg("Reading the source files."));
  const out = await triageSession(
    deps({
      transcript: async () => ({ messages: [...old, msg("Next I'll run rm -rf build/ to clear the stale output.")], truncated: false }),
    }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
  assert.equal(out.reason, "access-risky-escalated");
});

test("triageSession: the router prompt keeps the GOAL turns plus the recent ones, and elides the middle", async () => {
  // The prompt window is deliberately wider than the denylist's scan window: `purpose` is the
  // one field Tier 1 always produces and it lands on the card, so a prompt of only the last 12
  // turns would describe the last ten minutes rather than what the session is for.
  let prompt = "";
  const goal = Array.from({ length: TIER1_HEAD_TURNS }, (_, i) => msg(`GOAL-${i} port the auth module to OAuth.`));
  const middle = Array.from({ length: 20 }, (_, i) => msg(`MIDDLE-${i} nothing to see here.`));
  const recent = Array.from({ length: TIER1_TURNS }, (_, i) => msg(`RECENT-${i} working on the refactor.`));
  await triageSession(
    deps({
      transcript: async () => ({ messages: [...goal, ...middle, ...recent], truncated: false }),
      runModel: async (p) => (prompt = p, JSON.stringify(report())),
    }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.ok(prompt.includes("GOAL-0"), "the opening turns carry what the session is for");
  assert.ok(prompt.includes("RECENT-0"), "the recent neighbourhood of the ask is kept");
  assert.ok(!prompt.includes("MIDDLE-"), "Tier 1's prompt stays genuinely smaller than Tier 2's");
  assert.match(prompt, /the middle was elided/, "a gapped window is declared, not passed off as the whole story");
});

test("triageSession: a short transcript reaches the router whole, with no duplicated turns", async () => {
  // The head and tail slices overlap on a short window - they must de-dupe by record id rather
  // than feed the router the same turn twice.
  let prompt = "";
  const all = Array.from({ length: 3 }, (_, i) => msg(`ONLY-${i} porting the auth module.`));
  await triageSession(
    deps({
      transcript: async () => ({ messages: all, truncated: false }),
      runModel: async (p) => (prompt = p, JSON.stringify(report())),
    }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.equal(prompt.match(/ONLY-0/g)?.length, 1, "the overlapping turn appears exactly once");
  assert.ok(prompt.includes("ONLY-2"));
  assert.ok(!prompt.includes("the middle was elided"), "nothing was actually dropped");
});

test("triageSession: the denylist scan does NOT reach back into the goal turns", async () => {
  // The scan window stays narrower than the prompt window on purpose: the patterns over-match,
  // so a goal stated as "wire up the API key from .env" would otherwise escalate every routine
  // ask for the rest of the session - collapsing Tier 1's only substantive disposal.
  const goal = Array.from({ length: TIER1_HEAD_TURNS }, () => msg("Goal: read the API key from .env to wire auth."));
  const recent = Array.from({ length: TIER1_TURNS }, () => msg("Running the unit tests for the refactor."));
  const out = await triageSession(
    deps({ transcript: async () => ({ messages: [...goal, ...recent], truncated: false }) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "answer", "ambient prose in the goal turns must not poison the scan");
});

// ---- the daemon's TRUNCATED (head+tail) response shape ----
//
// Over its byte budget the endpoint returns the opening turns followed by the closing ones with
// the middle elided, and the tail's turn count is byte-bounded - so it can yield FEWER turns
// than the head. Slicing back from the end of that array lands inside the opening, which is why
// the recent turns are taken forward from `headCount` instead. These cover the shape directly.

/** The daemon's truncated response: `head` opening turns, then a short byte-bounded tail. */
function splitWindow(head: TranscriptMessage[], tail: TranscriptMessage[]) {
  return { messages: [...head, ...tail], truncated: true, headCount: head.length };
}

test("triageSession (truncated): a destructive string in a HEAD turn does NOT force an escalation", async () => {
  // 12 opening turns, a tail of only 4: `slice(-12)` would drag 8 goal turns into the scan and
  // escalate every routine ask for the rest of the session.
  const head = Array.from({ length: 12 }, () => msg("Goal: wipe the staging database and reseed it."));
  const tail = Array.from({ length: 4 }, () => msg("Running the unit tests for the refactor."));
  const out = await triageSession(
    deps({ transcript: async () => splitWindow(head, tail) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "answer", "old history is not the pending ask");
});

test("triageSession (truncated): a destructive string in a genuine RECENT turn still escalates", async () => {
  const head = Array.from({ length: 12 }, () => msg("Goal: port the auth module."));
  const tail = [msg("I'll clear the stale build output with rm -rf build/ and rebuild.")];
  const out = await triageSession(
    deps({ transcript: async () => splitWindow(head, tail) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
  assert.equal(out.reason, "access-risky-escalated");
});

test("triageSession (truncated): HEAD prose cannot satisfy the no-context gate for the tail", async () => {
  // The fail-open this closes: the recent turns are all prose-free tool calls (nothing the
  // denylist can read a command in), but opening prose would make `hasProse` report
  // "scanned and clean" - and Tier 1 would type an approval into the pane.
  const head = Array.from({ length: 12 }, () => msg("Goal: port the auth module."));
  const tail = Array.from({ length: 4 }, () => msg("", ["Bash"]));
  const out = await triageSession(
    deps({ transcript: async () => splitWindow(head, tail) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "route-up", "must NOT type an approval into the pane");
  if (out.kind === "route-up") assert.equal(out.reason, "no-transcript-context");
});

test("triageSession (truncated): a window with NO headCount can never take the auto-answer", async () => {
  // `headCount` carries the safety property but arrives on a response the client casts rather
  // than parses. Absent, it must not quietly become 0 - that IS the permissive answer (slice
  // from the start = slice back into the opening). A truncated window that won't say where its
  // middle was elided is one whose turns can't be placed in the session, so a clean scan over
  // them is not evidence about the pending ask. Not scoped by situation: unlike the prose gate,
  // an unplaceable window is worthless as corroboration on either surface.
  for (const situation of ["terminal-pane", "input-review"] as const) {
    const out = await triageSession(
      deps({ transcript: async () => ({ messages: [msg("Running the unit tests for the refactor.")], truncated: true }) }),
      pend({ situation, question: "Claude needs your permission" }),
      mkSession(),
      cfg(),
    );
    assert.equal(out.kind, "route-up", `${situation}: must not act on turns it cannot place`);
    if (out.kind === "route-up") assert.equal(out.reason, "no-window-boundary");
  }
});

test("triageSession (truncated): no headCount still escalates a destructive ask (routing DOWN stays allowed)", async () => {
  // With the shape unknown the window is scanned WHOLE rather than trimmed: the denylist
  // over-matches on purpose, and over-matching is the only reading that can't wave a risky ask
  // through. Only the acting path is withheld.
  const out = await triageSession(
    deps({
      transcript: async () => ({
        messages: [msg("I'll clear the stale build output with rm -rf build/ and rebuild.")],
        truncated: true,
      }),
    }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  assert.equal(out.verdict.action, "escalate");
  assert.equal(out.reason, "access-risky-escalated");
});

test("triageSession: an untruncated window needs no headCount - every turn is contiguous", async () => {
  // The daemon omits the boundary as 0 on the whole-file path, and there is nothing to locate:
  // the guard must not fire here or it would swallow the common case.
  const out = await triageSession(
    deps({ transcript: async () => ({ messages: [msg("Ready to run the unit tests for the refactor.")], truncated: false }) }),
    pend({ situation: "terminal-pane", question: "Claude needs your permission" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "dispose");
  if (out.kind === "dispose") assert.equal(out.verdict.action, "answer");
});

test("triageSession (truncated): the router still gets the opening goal turns", async () => {
  // The prompt window stays wider than the scan window - `purpose` lands on the card.
  let prompt = "";
  const head = Array.from({ length: 12 }, (_, i) => msg(`GOAL-${i} port the auth module.`));
  const tail = [msg("RECENT running the unit tests.")];
  await triageSession(
    deps({
      transcript: async () => splitWindow(head, tail),
      runModel: async (p) => (prompt = p, JSON.stringify(report())),
    }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.ok(prompt.includes("GOAL-0"), "the goal the user set must reach the router");
  assert.ok(prompt.includes("RECENT"), "so must the pending ask");
});

test("triageSession: a router reply with no confidence routes up as unparseable, not low-confidence", async () => {
  const { confidence: _omitted, ...noConfidence } = report();
  const out = await triageSession(
    deps({ runModel: async () => JSON.stringify(noConfidence) }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "tier1-unparseable", "an honest diagnosis of a broken router");
});

test("triageSession: a router TIMEOUT routes up (the shorter Tier 1 budget degrades to the full review)", async () => {
  // The router runs on its own, shorter cap than the full reviewer (see the worker's
  // TRIAGE_TIMEOUT_MS): in `on` mode the two are serial, so a hung router must fail fast into
  // this route-up - i.e. the pre-triage cost - instead of doubling the queue's worst case.
  const out = await triageSession(
    deps({ runModel: async () => { throw new Error("review timed out"); } }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.match(out.reason, /tier1-failed.*timed out/);
});

test("triageSession: a router spawn failure routes up (fail-safe to the full review)", async () => {
  const out = await triageSession(
    deps({ runModel: async () => { throw new Error("boom"); } }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.match(out.reason, /tier1-failed/);
});

test("triageSession: unparseable router output routes up", async () => {
  const out = await triageSession(
    deps({ runModel: async () => "not json at all" }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg(),
  );
  assert.equal(out.kind, "route-up");
  if (out.kind === "route-up") assert.equal(out.reason, "tier1-unparseable");
});

test("triageSession: config triageModel overrides the router model", async () => {
  let usedModel = "";
  await triageSession(
    deps({ runModel: async (_p, m) => (usedModel = m, JSON.stringify(report())) }),
    pend({ situation: "terminal-pane" }),
    mkSession(),
    cfg({ triageModel: "claude-custom-router" }),
  );
  assert.equal(usedModel, "claude-custom-router");
});

// ---- the tier posture: `on` is opt-in only, everything else fails safe ----

test("triagePosture: each known posture maps to itself", () => {
  assert.equal(triagePosture("off"), "off");
  assert.equal(triagePosture("shadow"), "shadow");
  assert.equal(triagePosture("on"), "on");
});

test("triagePosture: `on` is reachable ONLY by an exact match", () => {
  // `on` is the one posture where Tier 1's verdicts are applied instead of merely logged, so
  // nothing but the literal string may reach it. Everything else lands on `shadow`, which runs
  // the cheap tier but acts on the FULL review - so Tier 1 can't act under a config nobody set.
  for (const junk of ["ON", "On", "on ", "enabled", "true", "", "yes"]) {
    assert.equal(triagePosture(junk), "shadow", `${JSON.stringify(junk)} must not mean "on"`);
  }
});

test("triagePosture: a missing `triage` key falls back to shadow, not to on", () => {
  // The real reachability: the worker is started separately from the daemon (`npm run foreman`),
  // so a new worker polling an older daemon build gets a config with no `triage` key at all.
  // That must degrade to the documented default, never to the acting posture.
  assert.equal(triagePosture(undefined), "shadow");
  assert.equal(triagePosture(({} as ForemanConfig).triage), "shadow");
});

test("triagePosture: a non-string value falls back to shadow", () => {
  for (const junk of [null, 1, 0, true, false, {}, [], { triage: "on" }]) {
    assert.equal(triagePosture(junk), "shadow", `${JSON.stringify(junk)} must not mean "on"`);
  }
});

// ---- the safety invariant: a Tier 1 access verdict is gated exactly like a Tier 2 one ----

function ctx(over: Partial<ReviewContext> = {}): ReviewContext {
  return { sessionId: "s1", repoRoot: "/repo", promptMarker: "await:1", inputReviewId: null, canSend: true, ...over };
}

test("Tier 1 routine-access verdict SENDS only under the full path's config gate", () => {
  const out = mapTriage(report(), pend(), cleanWindow());
  assert.equal(out.kind, "dispose");
  if (out.kind !== "dispose") return;
  const v = out.verdict;

  // live + allowlisted + autoApproveAccess -> sends, exactly like a Tier 2 access answer.
  const live = planFromVerdict(v, ctx(), true, true);
  assert.equal(live.note.disposition, "answered");
  assert.ok(live.send);

  // dry-run (mayActLive=false) -> drafts, sends nothing.
  const draft = planFromVerdict(v, ctx(), false, true);
  assert.equal(draft.note.disposition, "pending");
  assert.equal(draft.send, null);

  // access auto-approval off -> escalates, sends nothing (mid-review toggle honoured).
  const off = planFromVerdict(v, ctx(), true, false);
  assert.equal(off.note.disposition, "escalated");
  assert.equal(off.send, null);
});
