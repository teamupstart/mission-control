import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkEvent } from "../src/server/harness/types.ts";
import type { PiSessionEvent } from "../src/server/harness/pi/sdk-types.ts";

// What is at stake: the supervisor's whole view of a managed Pi session.
//
// Two failures matter more than the rest and neither is visible in a transcript. Emitting
// MORE than one `turn_done` per accepted turn retires a completion reservation nobody made,
// so the card reports idle with work still running and the outbox releases a message into a
// busy session. Emitting FEWER leaves the card working for ever, which is the state Foreman
// and the operator both read as "still going". Pi's own vocabulary makes both easy to get
// wrong: it emits `agent_end` once per agent RUN, and one turn can contain several.
//
// The third is volume. Pi emits a `message_update` per token; a `state` event each would be
// a firehose that says nothing a card can show and would rewrite the session row thousands
// of times a turn.

const home = mkdtempSync(join(tmpdir(), "pi-sdk-events-"));
process.env.HARNESS_HOME = join(home, "state");

const { piSdkSpec } = await import("../src/server/harness/pi/sdk.ts");
const { narrowPiEvent } = await import("../src/server/harness/pi/sdk-deps.ts");
const { REDACTED } = await import("../src/server/harness/pi/sdk-errors.ts");
const { FakePiSdk, collect, fakePiSdkDeps, launchOptions, settle } = await import(
  "./helpers/pi-sdk-fake.ts"
);

test.after(() => rmSync(home, { recursive: true, force: true }));

/** A launched session with turn one already delivered and its binding consumed. */
async function running() {
  const sdk = new FakePiSdk();
  const handle = await piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions());
  const stream = collect(handle);
  await settle();
  const session = sdk.runtime.session;
  return {
    sdk,
    handle,
    session,
    ...stream,
    /** Feed Pi events and let the stream catch up. */
    async play(...events: PiSessionEvent[]): Promise<void> {
      session.emit(...events);
      await settle();
    },
    /** Everything after the launch's own `bound` and first `state`. */
    since(mark: number): SdkEvent[] {
      return stream.events.slice(mark);
    },
  };
}

/** A finished assistant message, in the shape the vendor seam projects. */
function assistant(
  over: Partial<Extract<PiSessionEvent, { type: "message_end" }>["assistant"] & object> = {},
): Extract<PiSessionEvent, { type: "message_end" }> {
  return {
    type: "message_end",
    assistant: {
      modelId: "amazon-bedrock/deepseek.v3.2",
      stopReason: "stop",
      errorMessage: null,
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 8, costUsd: 0.03 },
      ...over,
    },
  };
}

// ---- turn accounting --------------------------------------------------------------------

test("exactly one turn completion per accepted turn, however many runs it took", async () => {
  const pi = await running();
  const mark = pi.events.length;
  // One turn that retried twice and compacted once: four `agent_end`s, one `agent_settled`.
  await pi.play(
    { type: "agent_start" },
    { type: "agent_end", willRetry: true },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "overloaded" },
    { type: "auto_retry_end", success: true, attempt: 1 },
    { type: "agent_end", willRetry: true },
    { type: "compaction_start", reason: "threshold" },
    { type: "compaction_end", aborted: false, willRetry: false, errorMessage: null },
    assistant(),
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  );
  const completions = pi.since(mark).filter((event) => event.kind === "turn_done");
  assert.equal(completions.length, 1);
  assert.deepEqual(completions[0]!.usage, {
    input: 100,
    output: 20,
    cacheRead: 5,
    cacheWrite: 1,
    reasoningOutput: 8,
    modelId: "amazon-bedrock/deepseek.v3.2",
    costUsd: 0.03,
  });
  // And the idle transition comes AFTER the completion, which is what lets the supervisor
  // hold it back while another accepted turn is still outstanding.
  const tail = pi.since(mark).slice(-2);
  assert.equal(tail[0]!.kind, "turn_done");
  assert.deepEqual(tail[1], { kind: "state", state: "idle", activity: null });
});

test("a retrying run stays working rather than reporting a finished turn", async () => {
  const pi = await running();
  const mark = pi.events.length;
  await pi.play(
    { type: "agent_start" },
    { type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage: "429 rate limited" },
  );
  assert.deepEqual(pi.since(mark).filter((event) => event.kind === "turn_done"), []);
  const state = pi.since(mark).filter((event) => event.kind === "state").at(-1)!;
  assert.equal(state.state, "working");
  assert.match(state.activity ?? "", /retrying \(attempt 2 of 3\): 429 rate limited/);
});

test("a second accepted turn produces a second completion, and no more", async () => {
  const pi = await running();
  pi.session.finish();
  await pi.play({ type: "agent_settled" });
  const mark = pi.events.length;
  await pi.handle.send({ text: "next" });
  await pi.play({ type: "agent_start" }, assistant(), { type: "agent_settled" });
  assert.equal(pi.since(mark).filter((event) => event.kind === "turn_done").length, 1);
});

// ---- activity ---------------------------------------------------------------------------

test("a stream of deltas becomes one activity, not one event per token", async () => {
  const pi = await running();
  const mark = pi.events.length;
  // `message_update` is not projected at all (see `narrowPiEvent`), and a repeated
  // `message_start` says nothing new - so a long response costs exactly one event.
  await pi.play({ type: "message_start" }, { type: "message_start" }, { type: "message_start" });
  assert.deepEqual(pi.since(mark), [
    { kind: "state", state: "working", activity: "responding" },
  ]);
});

test("a tool's whole lifecycle is one activity and one release", async () => {
  const pi = await running();
  const mark = pi.events.length;
  await pi.play(
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", command: "git status" },
    { type: "tool_execution_update", toolCallId: "t1", toolName: "bash" },
    { type: "tool_execution_update", toolCallId: "t1", toolName: "bash" },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false },
  );
  assert.deepEqual(pi.since(mark), [
    { kind: "state", state: "working", activity: "bash: git status" },
    { kind: "state", state: "working", activity: null },
  ]);
});

test("compaction says so while it runs, and its failure stays on the card", async () => {
  const pi = await running();
  const mark = pi.events.length;
  const activity = (): string =>
    pi.since(mark).filter((event) => event.kind === "state").at(-1)?.activity ?? "";
  await pi.play({ type: "compaction_start", reason: "overflow" });
  assert.match(activity(), /compacting context \(overflow\)/);
  await pi.play({
    type: "compaction_end",
    aborted: false,
    willRetry: false,
    errorMessage: "provider refused the summary",
  });
  assert.match(activity(), /compaction failed: provider refused/);
});

// ---- provider failures -------------------------------------------------------------------

test("a turn that failed still completes, and says why in words an operator can act on", async () => {
  const pi = await running();
  const mark = pi.events.length;
  await pi.play(
    { type: "agent_start" },
    assistant({
      stopReason: "error",
      errorMessage: "ExpiredToken: The security token included in the request is expired",
      usage: null,
    }),
    { type: "agent_end", willRetry: false },
    { type: "agent_settled" },
  );
  const emitted = pi.since(mark);
  // The completion is unconditional: the supervisor's reservation has to be retired whether
  // the turn succeeded or not, or the card stays working over a session that has stopped.
  const completion = emitted.filter((event) => event.kind === "turn_done");
  assert.equal(completion.length, 1);
  assert.equal(completion[0]!.usage, null);
  const idle = emitted.at(-1)!;
  assert.equal(idle.kind, "state");
  assert.equal(idle.state, "idle");
  assert.match(idle.activity ?? "", /expired/i);
  assert.match(idle.activity ?? "", /\/login amazon-bedrock/);
});

test("a failure that arrives after acceptance is surfaced rather than thrown into the void", async () => {
  const pi = await running();
  const mark = pi.events.length;
  pi.session.deliveries.at(-1)!.fail(new Error("AccessDeniedException: model access denied"));
  await settle();
  const state = pi.since(mark).filter((event) => event.kind === "state").at(-1);
  assert.match(state?.activity ?? "", /access denied/i);
  assert.match(state?.activity ?? "", /provider console/);
});

test("a turn that ran nothing still retires its reservation", async () => {
  // Pi dispatches a registered extension command and returns without an agent run. The
  // supervisor is holding a completion reservation for that send; without this the card
  // would work for ever over a command that already finished.
  const pi = await running();
  const mark = pi.events.length;
  pi.session.streaming = false;
  pi.session.idle = true;
  pi.session.deliveries.at(-1)!.settle();
  await settle();
  assert.equal(pi.since(mark).filter((event) => event.kind === "turn_done").length, 1);
});

// ---- the Phase 1 boundary ----------------------------------------------------------------

test("the driver never announces a pull request, which Phase 1 excludes on purpose", async () => {
  // Claude's and Codex's drivers watch their tool streams for `gh pr create` and emit
  // `pr_created`, and the same reading is plainly available here - the command and its
  // output both pass through this driver. It is deliberately not taken: adoption attributes
  // a pull request to a session under the operator's GitHub identity, which is a claim this
  // phase does not make. Asserted rather than left to a comment, because the next person to
  // read the tool events will see the same opportunity.
  const pi = await running();
  const mark = pi.events.length;
  await pi.play(
    {
      type: "tool_execution_start",
      toolCallId: "pr",
      toolName: "bash",
      command: "gh pr create --fill",
    },
    { type: "tool_execution_end", toolCallId: "pr", toolName: "bash", isError: false },
  );
  assert.deepEqual(
    pi.since(mark).filter((event) => event.kind === "pr_created"),
    [],
    "a managed Pi session must announce no pull request in Phase 1",
  );
});

// ---- the vendor seam -----------------------------------------------------------------------

test("the vendor projection keeps what the driver reads and drops what it does not", () => {
  // A CLOSED union is what makes the normalizer's switch exhaustive, so a Pi release that
  // adds an event lands here as a `null` rather than as an unhandled shape in the adapter.
  assert.deepEqual(narrowPiEvent({ type: "agent_start" } as never), { type: "agent_start" });
  assert.equal(narrowPiEvent({ type: "queue_update", steering: [], followUp: [] } as never), null);
  assert.equal(narrowPiEvent({ type: "session_info_changed", name: "x" } as never), null);
  assert.equal(narrowPiEvent({ type: "bash_execution_update", delta: "..." } as never), null);
  assert.equal(narrowPiEvent({ type: "a_future_pi_event" } as never), null);
});

test("the projection reads a finished assistant message, and a user message is not one", () => {
  const projected = narrowPiEvent({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "amazon-bedrock",
      model: "deepseek.v3.2",
      responseModel: "deepseek.v3.2-20260101",
      stopReason: "stop",
      usage: {
        input: 3,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 1,
        cost: { total: 0.5 },
      },
    },
  } as never);
  assert.deepEqual(projected, {
    type: "message_end",
    assistant: {
      // The model the provider actually SERVED, not the alias that was requested.
      modelId: "amazon-bedrock/deepseek.v3.2-20260101",
      usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 1, costUsd: 0.5 },
      stopReason: "stop",
      errorMessage: null,
    },
  });
  assert.deepEqual(
    narrowPiEvent({ type: "message_end", message: { role: "user", content: "hi" } } as never),
    { type: "message_end", assistant: null },
  );
});

test("a provider error is redacted at the vendor seam, before it can be stored anywhere", () => {
  const projected = narrowPiEvent({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "amazon-bedrock",
      model: "deepseek.v3.2",
      stopReason: "error",
      errorMessage:
        "UnrecognizedClientException: request signed with AKIAIOSFODNN7EXAMPLE and aws_secret_access_key=wJalrXUtnFEMI",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    },
  } as never);
  const message = projected?.type === "message_end" ? projected.assistant?.errorMessage : null;
  assert.doesNotMatch(message ?? "", /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(message ?? "", /wJalrXUtnFEMI/);
  assert.equal((message ?? "").split(REDACTED).length - 1, 2);
});

test("the vendor seam carries only parsed PR URLs, never arbitrary tool output", () => {
  const end = narrowPiEvent({
    type: "tool_execution_end",
    toolCallId: "t",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "hello" }] },
  } as never);
  assert.deepEqual(end, {
    type: "tool_execution_end",
    toolCallId: "t",
    toolName: "bash",
    isError: false,
    prUrls: [],
  });
});
