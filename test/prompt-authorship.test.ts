/**
 * What is at stake: a review that judges the work against Mission Control's own complaint.
 *
 * A prompt event says a prompt was submitted. It does not say who wrote it. Foreman's
 * recovery packets, workflow repair delivery and the SDK's restart continuation all land in
 * the agent's pane as ordinary user turns, and the agent echoes each one straight back to its
 * prompt hook - so the goal path saw them as accepted human instructions and stored them.
 * The session Goal became the packet, the next workflow run froze that Goal as its ask, and
 * the review came back to the agent under the heading "Original user goal".
 *
 * Measured on this machine's own database when the defect was found: 7 of 19 workflow runs
 * had frozen machine-authored text as `rawGoal`, three of them a completion-review packet and
 * two a repair packet - which itself contains the literal string "Original user goal:", so
 * each round nested the previous one.
 *
 * The daemon already knew the answer at delivery time. `recordInjection` writes down who
 * typed what, and both other doors that can seed a Goal - the SDK send and the composer -
 * refuse a non-human origin. These pin the third door asking the same question.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-prompt-authorship-"));
// Set before importing anything that resolves the state dir (see db-isolation.test.ts).
process.env.HARNESS_HOME = join(home, "state");
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry, noteKeyFor } = await import("../src/server/registry.ts");
const {
  confirmReservedInjection,
  forgetInjections,
  originOf,
  recordInjection,
  releaseInjection,
  reserveInjection,
} = await import("../src/server/injections.ts");
const { upsertQueueItem } = await import("../src/server/db.ts");
const { claudeHooks } = await import("../src/server/harness/claude/hooks.ts");
const { codexHooks } = await import("../src/server/harness/codex/hooks.ts");
const { mkMuxHandle } = await import("./helpers/session-fixture.ts");

type HookIngest = import("../src/shared/protocol.ts").HookIngest;
type DiscoveredSession = import("../src/server/discovery/correlate.ts").DiscoveredSession;
type AgentType = import("../src/shared/types.ts").AgentType;

/** The operator's actual ask on the session this was found on. */
const HUMAN_ASK = "Task source write-back - Phase 2: Jira annotate and resolve";

/** Foreman's completion-review packet, verbatim in shape - see `ship-shepherd.ts`. */
const FOREMAN_PACKET = [
  "Foreman's completion review found blocking work that still belongs in this implementation turn:",
  "",
  "1. e2e/specs/conductor-loops.spec.ts: The full end-to-end run failed this spec, while its",
  "   isolated rerun passed.",
  "",
  "Address only these implementation, documentation, test, or evidence gaps.",
].join("\n");

/** The workflow's repair packet - see `workflows/feedback.ts`. */
const REPAIR_PACKET = [
  "Workflow review failed. This is a repair round; address the review packet below.",
  "",
  "Original user goal:",
  HUMAN_ASK,
].join("\n");

beforeEach(() => forgetInjections());

function discovered(id: string, pane: string, agent: AgentType): DiscoveredSession {
  return {
    syntheticId: id,
    agent,
    name: id,
    nameSource: "process",
    cwd: `/wt/${id}`,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    pid: 1,
    tty: `ttys-${id}`,
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: pane })],
    startedAt: 0,
  } as DiscoveredSession;
}

function withSession(id: string, pane: string, agent: AgentType = "claude") {
  const registry = new Registry();
  registry.applyDiscovery([discovered(id, pane, agent)]);
  const session = registry.getSession(id)!;
  const submit = (prompt: string): void => {
    registry.applyHook({
      agent,
      event: "UserPromptSubmit",
      sessionId: null,
      cwd: null,
      transcriptPath: null,
      env: { tmuxPane: pane },
      prompt,
    } as HookIngest);
  };
  return { registry, session, submit };
}

test("a recorded Foreman packet echoed back by the prompt hook never becomes the Goal", () => {
  const { registry, session, submit } = withSession("authorship-foreman", "%81");

  submit(HUMAN_ASK);
  const seeded = registry.getGoal(session.id);
  assert.equal(seeded?.prompt, HUMAN_ASK, "precondition: the human's ask is the Goal");
  assert.equal(seeded?.objective, HUMAN_ASK, "precondition: it is also the provisional objective");
  assert.equal(seeded?.promptRevision, 1);

  // Everything the failure chain did, in order: Foreman types its packet into the pane and
  // records that it did, then the agent reports the same text back through its prompt hook.
  recordInjection(session.id, FOREMAN_PACKET, "foreman");
  submit(FOREMAN_PACKET);

  const after = registry.getGoal(session.id);
  assert.equal(after?.prompt, HUMAN_ASK, "the packet must not replace the human's ask");
  assert.equal(after?.objective, HUMAN_ASK);
  assert.equal(after?.promptRevision, 1, "and it must not open a revision for the refiner");
  assert.deepEqual(
    after?.pendingPrompts.map((pending) => pending.prompt),
    [HUMAN_ASK],
    "nor queue itself for intent reconciliation",
  );
});

test("the suppression matches the submitted text, which the goal reading has reshaped", () => {
  // Load-bearing, and the reason `HookSpec` carries two prompt readings. `promptText` applies
  // Claude's scaffolding grammar, which collapses every whitespace run - so a multi-line
  // packet reaches the goal path as one line and hashes to nothing that was ever recorded. A
  // guard consulting only that reading would let every packet in this file straight through.
  const evt = {
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: null,
    cwd: null,
    transcriptPath: null,
    env: {},
    prompt: FOREMAN_PACKET,
  } as HookIngest;

  assert.equal(claudeHooks.submittedPromptText(evt), FOREMAN_PACKET);
  const reshaped = claudeHooks.promptText(evt);
  assert.ok(reshaped);
  assert.equal(reshaped.includes("\n"), false, "the goal reading is one line");
  assert.notEqual(reshaped, FOREMAN_PACKET);
});

test("a workflow repair packet is suppressed on the same terms", () => {
  const { registry, session, submit } = withSession("authorship-repair", "%82");
  submit(HUMAN_ASK);

  recordInjection(session.id, REPAIR_PACKET, "workflow");
  submit(REPAIR_PACKET);

  const goal = registry.getGoal(session.id);
  assert.equal(goal?.prompt, HUMAN_ASK);
  // The packet quotes the goal it was built from, so capturing it would nest one round's
  // "Original user goal:" inside the next round's.
  assert.equal(goal?.prompt?.includes("Original user goal:"), false);
});

test("a human instruction after a packet still moves the Goal", () => {
  // The guard is authorship, not a freeze. A session that has been sent a packet must still
  // take direction from the person watching it.
  const { registry, session, submit } = withSession("authorship-human-after", "%83");
  submit(HUMAN_ASK);
  recordInjection(session.id, FOREMAN_PACKET, "foreman");
  submit(FOREMAN_PACKET);

  submit("actually skip the Jira transition and only post the comment");

  const goal = registry.getGoal(session.id);
  assert.equal(goal?.prompt, "actually skip the Jira transition and only post the comment");
  assert.equal(goal?.promptRevision, 2, "the human's turn is revision two, not the packet's");
  assert.equal(goal?.objective, HUMAN_ASK, "later prompts leave the durable objective standing");
});

test("an unrecorded prompt is captured, so a harness with no delivery record is unaffected", () => {
  // The negative control. Suppression is driven entirely by what the daemon wrote down at
  // delivery; text nobody claimed is the human's, which is what every prompt was before this.
  const { registry, session, submit } = withSession("authorship-unrecorded", "%84");
  submit(HUMAN_ASK);
  submit(FOREMAN_PACKET);
  assert.notEqual(registry.getGoal(session.id)?.prompt, HUMAN_ASK);
});

test("Codex sessions get the same guard through their own spec", () => {
  const { registry, session, submit } = withSession("authorship-codex", "%85", "codex");
  submit(HUMAN_ASK);
  recordInjection(session.id, FOREMAN_PACKET, "foreman");
  submit(FOREMAN_PACKET);
  assert.equal(registry.getGoal(session.id)?.prompt, HUMAN_ASK);
});

test("a work item Foreman relays is still the human's ask, and still moves the Goal", () => {
  // The one payload the daemon DELIVERS but did not WRITE. Round 0 of a work item is
  // `item.intent` verbatim (see `payloadFor`), so it is recorded as Foreman's turn - correctly,
  // for the conversation log - while remaining the operator's own words. Suppressing it would
  // leave a queued instruction moving nothing on the card and nothing for the reconciler.
  const { registry, session, submit } = withSession("authorship-work-item", "%86");
  submit(HUMAN_ASK);

  const QUEUED = "also move the issue to In Review once the comment posts";
  upsertQueueItem({
    id: "authorship-item-1",
    noteKey: noteKeyFor(session),
    seq: 0,
    intent: QUEUED,
    state: "queued",
    round: 0,
    baseSha: null,
    transcriptAnchor: null,
    gaps: [],
    sendAttempts: 0,
    verifyFailures: 0,
    escalationReason: null,
    lastVerdict: null,
    approvedAt: null,
    proposedPayload: null,
    recoveredAt: null,
    revision: 0,
    createdAt: 1000,
    updatedAt: 1000,
    sentAt: null,
    completedAt: null,
  });

  recordInjection(session.id, QUEUED, "foreman");
  submit(QUEUED);

  const goal = registry.getGoal(session.id);
  assert.equal(goal?.prompt, QUEUED, "a relayed work item still reaches the Goal");
  assert.equal(goal?.promptRevision, 2);

  // A fix round on the same item is Foreman's own prose, never equal to the intent, so the
  // exemption does not widen to cover it.
  const FIX_ROUND = `${QUEUED}\n\nThe transition did not happen. Address the gap and report back.`;
  recordInjection(session.id, FIX_ROUND, "foreman");
  submit(FIX_ROUND);
  assert.equal(registry.getGoal(session.id)?.prompt, QUEUED, "a fix round stays suppressed");
});

test("a human who re-sends a packet verbatim is heard, not silenced", () => {
  // One delivery owes exactly one echo. Matching on text equality alone made the suppression
  // permanent: the operator scrolls back, copies a packet out of the transcript, sends it
  // again to redirect the work, and the Goal does not move - with nothing on screen to say
  // why. `claimInjectionEcho` spends the claim on the echo it was bought for, so the second
  // arrival of the same text is captured as the instruction it now is.
  const { registry, session, submit } = withSession("authorship-retype", "%87");
  submit(HUMAN_ASK);

  recordInjection(session.id, FOREMAN_PACKET, "foreman");
  submit(FOREMAN_PACKET);
  assert.equal(registry.getGoal(session.id)?.prompt, HUMAN_ASK, "the delivery's own echo is suppressed");

  submit(FOREMAN_PACKET);
  assert.equal(
    registry.getGoal(session.id)?.prompt?.startsWith("Foreman's completion review"),
    true,
    "a second arrival is the human retyping it and must reach the Goal",
  );

  // The conversation log still credits Foreman with the turn it really typed. The label is
  // permanent; only the suppression was single-use.
  assert.equal(originOf(session.id, FOREMAN_PACKET), "foreman");
});

test("two deliveries of the same text owe two echoes", () => {
  // Foreman re-sending an unacknowledged packet must not spend the second delivery's claim on
  // the first delivery's echo, or the retype guard above would let a genuine packet through.
  const { registry, session, submit } = withSession("authorship-redelivered", "%88");
  submit(HUMAN_ASK);

  recordInjection(session.id, FOREMAN_PACKET, "foreman");
  recordInjection(session.id, FOREMAN_PACKET, "foreman");
  submit(FOREMAN_PACKET);
  submit(FOREMAN_PACKET);
  assert.equal(registry.getGoal(session.id)?.prompt, HUMAN_ASK, "both echoes are accounted for");

  submit(FOREMAN_PACKET);
  assert.equal(
    registry.getGoal(session.id)?.prompt?.startsWith("Foreman's completion review"),
    true,
    "and the third arrival, which no delivery owes, is the human",
  );
});

test("an echo arriving while its delivery is still in flight is suppressed", () => {
  // The race the reservation exists for. A driver can hand the turn over and the agent can
  // submit it before the sender's `await` resolves, so the hook reaches the daemon while the
  // send is unresolved. Claiming authorship only after delivery returns leaves that echo with
  // nothing on file, and it is captured as the human's Goal - the exact substitution the
  // record was added to prevent, still reachable through its own path.
  const { registry, session, submit } = withSession("authorship-inflight", "%89");
  submit(HUMAN_ASK);

  // The sender reserves, then the send begins and has NOT returned.
  reserveInjection(session.id, FOREMAN_PACKET, "foreman");
  submit(FOREMAN_PACKET);
  assert.equal(
    registry.getGoal(session.id)?.prompt,
    HUMAN_ASK,
    "an in-flight delivery's echo must already have authorship on file",
  );

  // The send then resolves. Confirming must not owe a SECOND echo, or the surplus is spent
  // silencing the next human turn that repeats the text.
  confirmReservedInjection(session.id, FOREMAN_PACKET, "foreman");
  submit(FOREMAN_PACKET);
  assert.equal(
    registry.getGoal(session.id)?.prompt?.startsWith("Foreman's completion review"),
    true,
    "confirmation settles the reservation rather than adding to it",
  );
});

test("a delivery that provably did not land gives its claim back", () => {
  // The other side of reserving early. A refused send produces no turn, so a claim left
  // standing would sit there waiting to swallow whatever the human types next that happens to
  // match - which for a packet they just read on screen is not far-fetched.
  const { registry, session, submit } = withSession("authorship-released", "%90");
  submit(HUMAN_ASK);

  reserveInjection(session.id, FOREMAN_PACKET, "foreman");
  releaseInjection(session.id, FOREMAN_PACKET);
  submit(FOREMAN_PACKET);
  assert.equal(
    registry.getGoal(session.id)?.prompt?.startsWith("Foreman's completion review"),
    true,
    "a released reservation suppresses nothing",
  );
});

test("every harness answers null for an event that carries no prompt", () => {
  for (const spec of [claudeHooks, codexHooks]) {
    const evt = {
      agent: "claude",
      event: "Stop",
      sessionId: null,
      cwd: null,
      transcriptPath: null,
      env: {},
      prompt: "not a prompt event",
    } as HookIngest;
    assert.equal(spec.promptText(evt), null);
    assert.equal(spec.submittedPromptText(evt), null);
  }
});

test("every sender that writes into a pane reserves before it writes", () => {
  // The ordering is the property, and it is only correct if EVERY sender has it: a single
  // module that records after its own send resolves reopens the race for its own packets,
  // and the workflow manager's are the repair packets that caused two of the seven measured
  // contaminated runs. Asserted over the source because the alternative is five separate
  // integration tests for one rule, and because the failure mode is a sender that was added
  // later and simply never joined in.
  const senders = [
    "src/server/routes.ts",
    "src/server/workflows/manager.ts",
    "src/server/retro.ts",
    "src/server/skills/reload.ts",
    "src/server/sdk/supervisor.ts",
  ];
  for (const sender of senders) {
    const source = readFileSync(new URL(`../${sender}`, import.meta.url), "utf8");
    // Word boundaries, not `name(`: two of these senders take their authorship calls as
    // injected deps and reach the real one through `(deps.reserve ?? reserveInjection)(...)`.
    assert.ok(
      /\breserveInjection\b/.test(source),
      `${sender} writes into a pane and must reserve authorship before it does`,
    );
    assert.ok(
      /\bconfirmReservedInjection\b/.test(source),
      `${sender} must settle its reservation rather than record a second claim`,
    );
    // And gives the claim back only on POSITIVE evidence that nothing was delivered. A bare
    // `!ok` is not that: a pane delivery can fail with the text already in the composer and
    // only the Enter refused, and that echo may still arrive. The one sender that releases
    // from a `catch` is the SDK supervisor, whose rejection is itself classified as a refusal.
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("releaseInjection(") || line.trimStart().startsWith("*")) return;
      // The gate has to be at the CALL, not merely somewhere in the file: `routes.ts` says
      // `pasted` in several unrelated places, and a file-wide search passed a route that had
      // been reverted to a bare `!ok`.
      // The nearest enclosing `if`/`catch` rather than a window of lines: the gate and its
      // call are separated by the comment explaining why the gate is what it is, and that
      // comment is exactly what a later edit would keep while widening the condition. A line
      // window either misses the gate or reads a neighbouring one and passes either way.
      let guard = "";
      for (let above = index; above >= 0; above -= 1) {
        if (/\b(if|catch)\s*\(/.test(lines[above] ?? "")) {
          guard = lines[above] ?? "";
          break;
        }
      }
      assert.ok(
        /pasted|catch \(/.test(guard),
        `${sender}:${index + 1} releases its claim under \`${guard.trim()}\`, which is not `
          + "positive evidence that nothing landed",
      );
    });
  }
});
