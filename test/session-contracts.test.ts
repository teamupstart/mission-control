import { test } from "node:test";
import assert from "node:assert/strict";
import { typecheckWithPatch } from "./helpers/typecheck-probe.ts";

import { sessionEqual } from "../src/server/registry.ts";
import { meta, mkEmuHandle, mkMuxHandle, mkSession } from "./helpers/session-fixture.ts";
import { AGENT_TYPES } from "../src/shared/types.ts";
import { AGENT_IDENTITY } from "../src/shared/agent.ts";
import { DispatchSchema, UpdateTaskSchema } from "../src/shared/protocol.ts";
import type { OrphanedQueueHint, Session } from "../src/shared/types.ts";

const ORPHAN: OrphanedQueueHint = { noteKey: "k", itemCount: 2, branch: "harness/x" };

/**
 * Three contracts that fail SILENTLY when broken - no error, no failing test, just a
 * dashboard showing something that isn't true anymore:
 *
 *  1. `sessionEqual` gates every SSE emit. A `Session` field it doesn't compare
 *     renders once from the snapshot and then never updates again.
 *  2. `useEventStream`'s switch handles `ServerEvent`. A variant it doesn't handle
 *     is dropped on the floor.
 *  3. `AGENT_TYPES` is the union every agent id is drawn from. It used to be written
 *     out three times - the type, the dispatch schema's `z.enum`, the dashboard's
 *     dispatch input - so a fourth agent added to one of them was accepted by the UI
 *     and rejected at the wire, or vice versa.
 *
 * All three are now compiler-enforced. These tests prove the enforcement actually fires
 * (in session-compiler-*.test.ts), and that making it fail closed did not change
 * what gets emitted (above).
 */

// ---- semantics: the refactor must not change a single emit decision ----

test("identical sessions are equal", () => {
  assert.equal(sessionEqual(mkSession(), mkSession()), true);
});

test("a visible change emits", () => {
  const cases: Partial<Session>[] = [
    { name: "renamed" },
    { state: "idle" },
    { cwd: "/elsewhere" },
    { gitBranch: "other" },
    { gitRoot: "/repo" },
    { repoRoot: "/repo" },
    { pid: 2 },
    { nameSource: "process" },
    { agentSessionId: "agent-2" },
    { transcriptPath: "/t.jsonl" },
    { instrumented: false },
    { stateConfirmed: false },
    { hooksSeen: false },
    { activity: "something else" },
    {
      workCycle: {
        logicalKey: "agent-1",
        generation: 1,
        active: false,
        completedAt: 123,
        updatedAt: 124,
      },
    },
    { permissionMode: "plan" },
    { configuredModel: "claude-sonnet-5" },
    { pendingReviews: 3 },
    { prUrl: "https://example.test/pr/1" },
    { prNumber: 1 },
    { prState: "open" },
    { prChecks: "failing" },
    // The runtime axis. Fixed for the life of an entry, so this is a statement about the
    // COMPARATOR rather than about a transition anyone can make: `runtime` decides which
    // affordances a card draws (a Send box with no pane behind it, no Focus, no Rename), so
    // an entry left out of the record would render the wrong set once and never correct it.
    { runtime: "sdk" as const, terminals: [], tty: null },
    // An invite or a withdrawal often lands with nothing else on the session moving -
    // left out, phase 3's rail control would swap only when something unrelated did.
    { foremanInvite: null },
  ];
  for (const over of cases) {
    const field = Object.keys(over)[0];
    assert.equal(sessionEqual(mkSession(), mkSession(over)), false, `${field} should emit`);
  }
});

test("liveness timestamps do NOT emit - they move every poll", () => {
  assert.equal(sessionEqual(mkSession(), mkSession({ lastSeen: 999_999 })), true);
  assert.equal(sessionEqual(mkSession(), mkSession({ lastActivity: 999_999 })), true);
});

test("nested summaries are compared structurally", () => {
  const base = mkSession({ queue: null, orphanedQueue: null });
  // Same shape, different object identity: equal, or every poll would re-emit.
  assert.equal(sessionEqual(base, mkSession({ queue: null, orphanedQueue: null })), true);
  assert.equal(sessionEqual(mkSession(), mkSession({ goal: null })), false);
  assert.equal(
    sessionEqual(
      mkSession(),
      mkSession({
        pendingTurns: [
          {
            id: "pending-1",
            noteKey: "agent-1",
            seq: 0,
            text: "visible queued text",
            state: "queued",
            revision: 0,
            createdAt: 1,
            updatedAt: 1,
            claimedAt: null,
            lastError: null,
          },
        ],
      }),
    ),
    false,
  );
});

test("schedule provenance rides inside Session.task, and a change to it still emits", () => {
  // Recurring Missions added three fields to `TaskSummary` rather than to `Session`,
  // which is only safe because `task` compares with `byJson`. If it were ever narrowed to
  // a field list, a session would render its scheduled provenance once from the snapshot
  // and then never update - the exact silent failure this file exists to catch.
  const summary = {
    id: "t1",
    title: "Audit dependencies",
    fullTitle: "Audit dependencies",
    kind: "ship" as const,
    workflowId: null,
    status: "running" as const,
    outcome: null,
    outcomeUrl: null,
    pipelineRun: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    ensemble: null,
    repoPrs: [],
  };
  assert.equal(sessionEqual(mkSession({ task: summary }), mkSession({ task: summary })), true);
  assert.equal(
    sessionEqual(
      mkSession({ task: summary }),
      mkSession({ task: { ...summary, fullTitle: "Audit dependencies across every package" } }),
    ),
    false,
  );
  assert.equal(
    sessionEqual(
      mkSession({ task: summary }),
      mkSession({
        task: { ...summary, scheduleId: "sch-1", scheduleOccurrenceId: "occ-1", scheduledFor: 5 },
      }),
    ),
    false,
  );
  // Ensemble membership rides on the same nested summary, and for the same reason: it needs
  // no `SESSION_FIELD_COMPARATORS` entry of its own, and `byJson` on `task` is what makes a
  // member's state change reach the card at all. A comparator narrowed to a field list would
  // draw "candidate 1 of 3" once and never update it again.
  assert.equal(
    sessionEqual(
      mkSession({ task: summary }),
      mkSession({
        task: {
          ...summary,
          ensemble: {
            runId: "run-1",
            strategyId: "best_of_n",
            strategyLabel: "Best of N",
            memberId: "member-1",
            ordinal: 1,
            wave: 1,
            role: "candidate-1",
            launchedMembers: 3,
            maxMembers: 3,
            status: "active",
            resultLabel: null,
            // Derived from live session state when the projection is rebuilt, and it rides inside
            // `task` for the same reason every other field here does: `byJson` is what makes a
            // member becoming blocked reach the card at all.
            needsInput: false,
          },
        },
      }),
    ),
    false,
  );
});

test("a driver-sourced dialog compares like any other - the fields are new, the rule is not", () => {
  // `paneDialog` is `byJson`, which is what lets the driver fields ride inside it with no
  // comparator of their own. Two reads of the same pending request must be equal (or every
  // event would re-render the buttons), and a NEW request must not be: an ask replaced by
  // another ask is the one tick where nothing else about the session moves.
  const dialog = {
    options: [{ number: 1, label: "Yes" }],
    highlighted: 0,
    prompt: "Run npm test?",
    source: "driver" as const,
    requestId: "req-1",
    kind: "permission" as const,
  };
  assert.equal(sessionEqual(mkSession({ paneDialog: dialog }), mkSession({ paneDialog: dialog })), true);
  assert.equal(
    sessionEqual(
      mkSession({ paneDialog: dialog }),
      mkSession({ paneDialog: { ...dialog, requestId: "req-2" } }),
    ),
    false,
  );
});

test("orphanedQueue emits - the bug the comparator record documents", () => {
  // A queue is orphaned only once ANOTHER session is evicted, so the session whose
  // hint changes need not have changed in any way of its own. Leaving this out of
  // the comparison stranded batches with nothing to surface them.
  assert.equal(sessionEqual(mkSession(), mkSession({ orphanedQueue: ORPHAN })), false);
});

test("the handle list compares only what the card renders", () => {
  const mux = mkMuxHandle();
  const emu = mkEmuHandle();

  // Gaining or losing a pane is the difference between a card that can Send and one that
  // cannot, so a length change alone is a change.
  assert.equal(sessionEqual(mkSession({ terminals: [mux] }), mkSession({ terminals: [] })), false);
  assert.equal(
    sessionEqual(mkSession({ terminals: [mux] }), mkSession({ terminals: [mux, emu] })),
    false,
  );

  // Focus flips are visible; so is the window name, which is what the two comparators this
  // replaced compared and all they compared.
  assert.equal(
    sessionEqual(mkSession({ terminals: [emu] }), mkSession({ terminals: [{ ...emu, isActive: false }] })),
    false,
  );
  assert.equal(
    sessionEqual(mkSession({ terminals: [mux] }), mkSession({ terminals: [{ ...mux, windowName: "w2" }] })),
    false,
  );
  assert.equal(
    sessionEqual(mkSession({ terminals: [mux] }), mkSession({ terminals: [{ ...mux, sessionName: "s2" }] })),
    false,
  );

  // The two the old pair MISSED, and the reason this is not a straight port. The pane id
  // reaches the card's subtitle and the multiplexer session name reaches Kill's confirm
  // tooltip, so a pane that moved under an otherwise-still card used to keep displaying the
  // old one until something unrelated shook it loose.
  assert.equal(
    sessionEqual(mkSession({ terminals: [mux] }), mkSession({ terminals: [{ ...mux, paneId: "%9" }] })),
    false,
  );
  assert.equal(
    sessionEqual(mkSession({ terminals: [mux] }), mkSession({ terminals: [{ ...mux, session: "other" }] })),
    false,
  );

  // The geometry around them churns and is rendered nowhere.
  assert.equal(
    sessionEqual(mkSession({ terminals: [mux] }), mkSession({ terminals: [{ ...mux, windowIndex: 4 }] })),
    true,
  );
  assert.equal(
    sessionEqual(mkSession({ terminals: [emu] }), mkSession({ terminals: [{ ...emu, windowId: "9" }] })),
    true,
  );
});

test("meta compares displayed values, not the reading behind them", () => {
  assert.equal(sessionEqual(mkSession(), mkSession({ meta: meta({ model: "Sonnet 5" }) })), false);
  // A re-read that lands on the same displayed model/context% must not re-render.
  assert.equal(
    sessionEqual(mkSession(), mkSession({ meta: meta({ updatedAt: 12_345, contextTokens: 124_001 }) })),
    true,
  );
});

// ---- the agent union: one source, and the wire follows it ----

test("every declared agent is dispatchable", () => {
  // The property that matters to a person: an id in the union can be launched. It broke
  // by omission - the union grew, the schema's hand-written enum didn't, and the failure
  // surfaced as a 400 from a picker that offered the choice.
  for (const agent of AGENT_TYPES) {
    assert.equal(DispatchSchema.parse({ repoRoot: "/r", intent: "do it", agent }).agent, agent);
    assert.equal(UpdateTaskSchema.parse({ agent }).agent, agent);
  }
});

test("an agent id that is not in the union is refused at the wire", () => {
  // The other half: the schema is the boundary, so it must not accept ids the rest of
  // the daemon has no code for. A widened enum that forgot to narrow is a session
  // launched against a binary nobody resolves.
  // `probeagent`, not `pi`: `pi` is now a real harness in the union, so it is accepted. The
  // point of this test is that an id the daemon has NO code for is refused at the wire.
  assert.throws(() => DispatchSchema.parse({ repoRoot: "/r", intent: "do it", agent: "probeagent" }));
  assert.throws(() => UpdateTaskSchema.parse({ agent: "probeagent" }));
});

test("every declared agent has a name and a colour to render", () => {
  // `AGENT_IDENTITY` is compiler-enforced (the probe below), but only against a MISSING
  // key. An empty string satisfies the type and renders as a blank byline - or, for the
  // accent, as a dot with `--agent-accent:` set to nothing, which falls back to the
  // neutral grey and looks like a deliberate choice. What the accent has to BE is
  // `agent-accent.test.ts`'s question.
  for (const agent of AGENT_TYPES) {
    assert.ok(AGENT_IDENTITY[agent].label, `${agent} needs a product name`);
    assert.ok(AGENT_IDENTITY[agent].speaker, `${agent} needs a transcript byline`);
    assert.ok(AGENT_IDENTITY[agent].accent, `${agent} needs a brand colour`);
  }
});

// Compiler mutations live in separate files so Node can shard the expensive probes.
test("the probe harness compiles a clean copy", () => {
  // Without this, a probe that failed to compile for some UNRELATED reason would
  // still satisfy "typechecking failed" and the guard could rot untested.
  assert.equal(typecheckWithPatch(null), "", "unpatched copy of src should typecheck");
});
