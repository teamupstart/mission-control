import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeSdkRateLimits,
  claudeSdkSpec,
  askUserQuestions,
  permissionPrompt,
  sdkPermissionMode,
} from "../src/server/harness/claude/sdk.ts";
import { sdkSubprocessEnv } from "../src/server/harness/claude/sdk-deps.ts";
import { executableLocator } from "../src/server/executables/locator.ts";
import { driverDialog } from "../src/server/sdk/dialog.ts";
import type {
  ClaudeSdkDeps,
  ClaudeSdkInterruptReceipt,
  ClaudeSdkMessage,
  ClaudeSdkPermissionResult,
  ClaudeSdkQuery,
  ClaudeSdkQueryOptions,
  ClaudeSdkUsageResponse,
  ClaudeSdkUserMessage,
} from "../src/server/harness/claude/sdk-types.ts";
import type { SdkEvent } from "../src/server/harness/types.ts";

// What is at stake: this adapter is the only thing standing between the vendor's message
// stream and every surface in the app. If a permission callback is projected wrongly, a
// human clicks "No" and an agent is told yes; if a `/clear` rotation is missed, the card's
// note, queue and goal are stranded on a dead key; if an exit is swallowed, a card sits on
// the dashboard with a Send button that lies.
//
// It is driven here on a SCRIPTED message stream, with no `claude` binary anywhere - the
// `PaneDeps.pane` pattern applied to a subprocess. That is the whole reason `ClaudeSdkDeps`
// exists: everything under test below is the real projection code, the real pending-request
// bookkeeping and the real answer mapping, exercised without spawning an agent (which the
// first version of this suite did by accident, and which is why `restore` is now pointed at
// an unresumable row in `sdk-db.test.ts`).

/** A hand-driven query: frames go in when the test says so, controls are recorded. */
class FakeQuery implements ClaudeSdkQuery {
  readonly control: string[] = [];
  iterationStarts = 0;
  usageCalls = 0;
  usageResponse: ClaudeSdkUsageResponse = {
    rate_limits_available: false,
    rate_limits: null,
  };
  private queued: ClaudeSdkMessage[] = [];
  private waiting: ((m: IteratorResult<ClaudeSdkMessage>) => void) | null = null;
  private done = false;

  emit(message: ClaudeSdkMessage): void {
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: message, done: false });
      return;
    }
    this.queued.push(message);
  }

  end(): void {
    this.done = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  /** Answers the way a CLI without `interrupt_receipt_v1` does: success, and no receipt. */
  interruptReceipt: ClaudeSdkInterruptReceipt | undefined = undefined;

  async interrupt(): Promise<ClaudeSdkInterruptReceipt | undefined> {
    this.control.push("interrupt");
    return this.interruptReceipt;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.control.push(`mode:${mode}`);
  }

  async applyFlagSettings(settings: { effortLevel?: import("../src/shared/types.ts").ThinkingLevel | null }): Promise<void> {
    this.control.push(`effort:${settings.effortLevel}`);
  }

  async setModel(model?: string): Promise<void> {
    this.control.push(`model:${model}`);
  }

  async return(): Promise<IteratorResult<ClaudeSdkMessage, void>> {
    this.control.push("return");
    this.end();
    return { value: undefined, done: true };
  }

  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<ClaudeSdkUsageResponse> {
    this.usageCalls += 1;
    return this.usageResponse;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeSdkMessage> {
    this.iterationStarts += 1;
    for (;;) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) return;
      const m = await new Promise<IteratorResult<ClaudeSdkMessage>>((r) => {
        this.waiting = r;
      });
      if (m.done) return;
      yield m.value;
    }
  }
}

interface Harnessed {
  query: FakeQuery;
  options: ClaudeSdkQueryOptions;
  /** Everything the streaming input has been handed, in order. */
  turns: ClaudeSdkUserMessage[];
}

function fakeDeps(): { deps: ClaudeSdkDeps; started: Promise<Harnessed> } {
  const query = new FakeQuery();
  let resolveStarted: (h: Harnessed) => void;
  const started = new Promise<Harnessed>((r) => {
    resolveStarted = r;
  });
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ prompt, options }) => {
      const turns: ClaudeSdkUserMessage[] = [];
      // Drain the streaming input in the background, exactly as the real CLI does. This is
      // what makes `send()` observable at all: it resolves when the message is ACCEPTED.
      void (async () => {
        for await (const turn of prompt) turns.push(turn);
        query.end();
      })();
      resolveStarted({ query, options, turns });
      return query;
    },
  };
  return { deps, started };
}

/** Collect events until `stop` says we have what the test is about. */
async function collect(
  events: AsyncIterable<SdkEvent>,
  stop: (e: SdkEvent) => boolean,
): Promise<SdkEvent[]> {
  const out: SdkEvent[] = [];
  for await (const e of events) {
    out.push(e);
    if (stop(e)) break;
  }
  return out;
}

const INIT = (sessionId: string): ClaudeSdkMessage => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model: "claude-opus-5",
});

function launchOpts(over: Record<string, unknown> = {}) {
  return {
    cwd: "/wt/one",
    stateHome: "/tmp/mission-sdk-state",
    prompt: "do the thing",
    model: null,
    effort: null,
    permissionMode: null,
    mcp: null,
    extraDirs: [],
    standingInstructions: "",
    standingInstructionsPrompt: "",
    resume: null,
    ...over,
  } as Parameters<ReturnType<typeof claudeSdkSpec>["launch"]>[0];
}

test("standing instructions APPEND to the Claude Code preset, and are omitted when empty", async () => {
  // The preset object is the only non-destructive form. A bare `systemPrompt: string`
  // REPLACES Claude Code's own prompt, which would make an embedded session a different
  // agent from the dispatched pane running the very same task.
  const withText = fakeDeps();
  await claudeSdkSpec(withText.deps).launch(
    launchOpts({ standingInstructions: "Never run E2E locally." }),
  );
  assert.deepEqual((await withText.started).options.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: "Never run E2E locally.",
  });

  // And with nothing to send the key is absent entirely - not an empty `append`. An
  // ordinary session's options object stays exactly what it always was.
  const without = fakeDeps();
  await claudeSdkSpec(without.deps).launch(launchOpts());
  assert.equal("systemPrompt" in (await without.started).options, false);
});

test("the launch pins the binary, seeds turn one, and binds on init", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ permissionMode: "auto" }));
  const { query, options, turns } = await started;

  // Pinned, never left to the SDK's own detection - which would fall back to the native CLI
  // inside the npm package, a different build from the one the operator logged in with.
  assert.equal(options.pathToClaudeCodeExecutable, "/fake/bin/claude");
  assert.equal(options.cwd, "/wt/one");
  assert.equal(options.permissionMode, "auto");
  // The ask channel's disallow and redirect are deliberately NOT rendered: an embedded
  // session's questions are answered on the card, which is what the redirect approximated.
  assert.ok(!("disallowedTools" in options), "AskUserQuestion must stay available");

  query.emit(INIT("agent-1"));
  const events = await collect(handle.events, (e) => e.kind === "bound");
  const bound = events.find((e) => e.kind === "bound");
  assert.equal(bound?.kind === "bound" && bound.agentSessionId, "agent-1");
  assert.equal(bound?.kind === "bound" && bound.modelId, "claude-opus-5");
  // No separate process to name: the SDK owns its subprocess, and 0 is the sentinel
  // `signalProcess` refuses.
  assert.equal(bound?.kind === "bound" && bound.pid, null);

  // The intent IS turn one - there is no paste to verify and no retry to get wrong.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(turns.length, 1);
  assert.equal((turns[0]!.message.content as string), "do the thing");
  // And delivery is the transition to working, said before any assistant frame arrives.
  assert.ok(events.some((e) => e.kind === "state" && e.state === "working"));
});

test("secondary worktrees reach the driver as additionalDirectories, and only when there are any", async () => {
  // The multi-repo write grant on the embedded runtime. `additionalDirectories` is the
  // vendor's own option name at the pinned SDK version; getting it wrong produces a session
  // that starts perfectly and silently cannot write where its intent says it may.
  const granted = fakeDeps();
  await claudeSdkSpec(granted.deps).launch(launchOpts({ extraDirs: ["/wt/one-1", "/wt/one-2"] }));
  const withDirs = await granted.started;
  assert.deepEqual(withDirs.options.additionalDirectories, ["/wt/one-1", "/wt/one-2"]);

  // Absent, not empty, when nothing is attached: an ordinary session's options object stays
  // byte-identical to what it was before this capability existed.
  const plain = fakeDeps();
  await claudeSdkSpec(plain.deps).launch(launchOpts());
  const withoutDirs = await plain.started;
  assert.equal("additionalDirectories" in withoutDirs.options, false);
});

test("SDK usage repopulates both Claude plan windows on init and refreshes after a turn", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.usageResponse = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42.5, resets_at: "2026-07-27T18:00:00.000Z" },
      seven_day: { utilization: 83, resets_at: "2026-08-02T04:00:00.000Z" },
    },
  };

  query.emit(INIT("agent-limits"));
  const initial = await collect(handle.events, (e) => e.kind === "rate_limits");
  const first = initial.find((e) => e.kind === "rate_limits");
  assert.deepEqual(first?.kind === "rate_limits" && {
    fiveHour: first.rateLimits.fiveHour,
    sevenDay: first.rateLimits.sevenDay,
  }, {
    fiveHour: {
      usedPercentage: 42.5,
      resetsAt: Date.parse("2026-07-27T18:00:00.000Z") / 1000,
    },
    sevenDay: {
      usedPercentage: 83,
      resetsAt: Date.parse("2026-08-02T04:00:00.000Z") / 1000,
    },
  });
  assert.equal(query.usageCalls, 1, "an idle resumed session restores the gauge on init");

  query.usageResponse = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 48, resets_at: "2026-07-27T18:00:00.000Z" },
      seven_day: { utilization: 84, resets_at: "2026-08-02T04:00:00.000Z" },
    },
  };
  query.emit({ type: "result", subtype: "success", session_id: "agent-limits" });
  const refreshed = await collect(handle.events, (e) => e.kind === "rate_limits");
  const second = refreshed.find((e) => e.kind === "rate_limits");
  assert.equal(second?.kind === "rate_limits" && second.rateLimits.fiveHour?.usedPercentage, 48);
  assert.equal(second?.kind === "rate_limits" && second.rateLimits.sevenDay?.usedPercentage, 84);
  assert.equal(query.usageCalls, 2, "each completed turn refreshes the live gauge");
});

test("the driver emits turn deltas from Claude's cumulative result snapshots", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.emit(INIT("agent-cumulative-spend"));
  await collect(handle.events, (event) => event.kind === "bound");

  const result = (
    uuid: string,
    totalCost: number | null,
    input: number,
    output: number,
  ): ClaudeSdkMessage => ({
    type: "result",
    subtype: "success",
    session_id: "agent-cumulative-spend",
    uuid,
    total_cost_usd: totalCost,
    modelUsage: {
      "claude-opus-5": {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: totalCost,
      },
    },
  } as ClaudeSdkMessage);

  query.emit(result("result-1", 10, 1_000, 100));
  const first = (await collect(handle.events, (event) => event.kind === "turn_done"))
    .find((event) => event.kind === "turn_done");
  assert.equal(first?.kind === "turn_done" && first.usage?.costUsd, 10);
  assert.equal(first?.kind === "turn_done" && first.usage?.input, 1_000);

  query.emit(result("result-2", 13, 1_250, 140));
  const second = (await collect(handle.events, (event) => event.kind === "turn_done"))
    .find((event) => event.kind === "turn_done");
  assert.equal(second?.kind === "turn_done" && second.usage?.turnId, "result-2");
  assert.equal(second?.kind === "turn_done" && second.usage?.costUsd, 3);
  assert.equal(second?.kind === "turn_done" && second.usage?.input, 250);
  assert.equal(second?.kind === "turn_done" && second.usage?.output, 40);
  assert.equal(
    second?.kind === "turn_done" && second.usage?.models?.[0]?.reportedCostUsd,
    3,
  );

  // Cost can be temporarily absent even while Claude keeps reporting cumulative tokens.
  // The unknown result advances those token baselines but must not erase the last priced
  // baseline, or the next $20 query total would be recorded as $20 instead of $7.
  query.emit(result("result-3", null, 1_500, 180));
  const unpriced = (await collect(handle.events, (event) => event.kind === "turn_done"))
    .find((event) => event.kind === "turn_done");
  assert.equal(unpriced?.kind === "turn_done" && unpriced.usage?.costUsd, null);
  assert.equal(unpriced?.kind === "turn_done" && unpriced.usage?.input, 250);
  assert.equal(
    unpriced?.kind === "turn_done" && unpriced.usage?.models?.[0]?.reportedCostUsd,
    null,
  );

  query.emit(result("result-4", 20, 1_800, 220));
  const repriced = (await collect(handle.events, (event) => event.kind === "turn_done"))
    .find((event) => event.kind === "turn_done");
  assert.equal(repriced?.kind === "turn_done" && repriced.usage?.costUsd, 7);
  assert.equal(repriced?.kind === "turn_done" && repriced.usage?.input, 300);
  assert.equal(
    repriced?.kind === "turn_done" && repriced.usage?.models?.[0]?.reportedCostUsd,
    7,
  );

  // An unknown-cost result with lower tokens is observably a fresh query window. Do not
  // carry the old $20 across that reset: the next priced result is all new spend.
  query.emit(result("result-5", null, 10, 5));
  await collect(handle.events, (event) => event.kind === "turn_done");
  query.emit(result("result-6", 25, 100, 15));
  const afterReset = (await collect(handle.events, (event) => event.kind === "turn_done"))
    .find((event) => event.kind === "turn_done");
  assert.equal(afterReset?.kind === "turn_done" && afterReset.usage?.costUsd, 25);
  assert.equal(
    afterReset?.kind === "turn_done" && afterReset.usage?.models?.[0]?.reportedCostUsd,
    25,
  );

  // A new Claude identity is a new accounting window. Its first counters may happen to be
  // larger than the old window's last ones, so value comparison alone cannot detect it.
  query.emit({
    ...result("result-7", 30, 3_000, 400),
    session_id: "agent-new-accounting-window",
  } as ClaudeSdkMessage);
  const rebound = (await collect(handle.events, (event) => event.kind === "turn_done"))
    .find((event) => event.kind === "turn_done");
  assert.equal(rebound?.kind === "turn_done" && rebound.usage?.costUsd, 30);
  assert.equal(rebound?.kind === "turn_done" && rebound.usage?.input, 3_000);

  query.end();
});

test("SDK usage refuses unavailable, incomplete, or out-of-range plan windows", () => {
  assert.equal(claudeSdkRateLimits({
    rate_limits_available: false,
    rate_limits: null,
  }), null);
  assert.equal(claudeSdkRateLimits({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: null, resets_at: "2026-07-27T18:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: null },
    },
  }), null);
  assert.equal(claudeSdkRateLimits({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: -1, resets_at: "2026-07-27T18:00:00.000Z" },
      seven_day: { utilization: 101, resets_at: "2026-08-02T04:00:00.000Z" },
    },
  }), null);
  assert.deepEqual(claudeSdkRateLimits({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: -1, resets_at: "2026-07-27T18:00:00.000Z" },
      seven_day: { utilization: 100, resets_at: "2026-08-02T04:00:00.000Z" },
    },
  }, 123), {
    fiveHour: null,
    sevenDay: {
      usedPercentage: 100,
      resetsAt: Date.parse("2026-08-02T04:00:00.000Z") / 1000,
    },
    updatedAt: 123,
  });
});

// One `result` ends the turn no matter how many messages it absorbed, and the previous
// version of this test is why that went unnoticed for so long: it scripted the vendor stream
// to emit a result PER accepted message, which the real CLI does not do. Claude Code folds a
// mid-turn message into the running turn as a `queued_command` attachment and finishes the
// whole thing with a single result, so a driver that reserved a completion per message was
// permanently owed one that never came - and `sendIfIdle`, the outbox's only door, stayed
// shut for the life of the session while the card read idle.
test("a mid-turn follow-up is steered, and one result still leaves the driver idle", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;

  // Turn one was seeded at launch, so the editable outbox must keep this message rather than
  // hand it to a driver that would fold it into work already in progress.
  assert.equal(await handle.sendIfIdle({ text: "must remain in Mission Control" }), null);
  assert.equal(
    await handle.send({ text: "after that, run the tests" }),
    "steered",
    "Claude attaches a mid-turn message to the running turn - it does not queue a second one",
  );

  // ONE result, for a turn that took two messages. This is the assertion the bug failed.
  query.emit({ type: "result", subtype: "success", session_id: "agent-1" });
  await collect(handle.events, (e) => e.kind === "turn_done");
  assert.equal(
    await handle.sendIfIdle({ text: "now idle" }),
    "started",
    "a steered message owes no second result, so the outbox door reopens",
  );
  query.end();
});

// The transition between a `result` and the first frame of whatever the CLI does next. The
// driver cannot see into it - no vendor signal says "my queue is empty" - so a send can be
// accepted here and then absorbed by a turn the CLI had already begun for itself.
//
// What matters is that losing that race stays BALANCED. The absorbed message is answered by
// the turn that took it, and that turn's single `result` retires the one reservation the
// send made, so the driver ends idle and reachable rather than owing a completion for ever.
// The waiting belongs one layer up and is already there: `PendingTurnManager` holds a 1.5s
// settle window (`DEFAULT_IDLE_SETTLE_MS`) after an idle transition before it drains, and a
// vendor turn that speaks inside it flips the card back to working and cancels the drain. A
// second timer down here would be a weaker copy of that, and a second source of truth about
// idleness besides.
test("a send that loses the race to a vendor-started turn still ends balanced", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;

  query.emit({ type: "result", subtype: "success", session_id: "agent-1" });
  await collect(handle.events, (e) => e.kind === "turn_done");

  // The CLI has silently begun a follow-up it dequeued for itself. Nothing has been said yet,
  // so this is accepted.
  assert.equal(await handle.sendIfIdle({ text: "sent into the gap" }), "started");

  // That turn was real, and it absorbed the message: frames, then ONE result for both.
  query.emit({
    type: "assistant",
    session_id: "agent-1",
    message: { content: [{ type: "text", text: "answering both" }] },
  } as ClaudeSdkMessage);
  query.emit({ type: "result", subtype: "success", session_id: "agent-1" });
  await collect(handle.events, (e) => e.kind === "turn_done");

  // Reachable, not wedged. A driver that ended this sequence still holding the door shut is
  // the exact defect the mid-turn case above pins, reached by a different route.
  assert.equal(await handle.sendIfIdle({ text: "still reachable" }), "started");
  query.end();
});

test("a turn the driver did not start still closes the door on its first frame", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;

  query.emit({ type: "result", subtype: "success", session_id: "agent-1" });
  await collect(handle.events, (e) => e.kind === "turn_done");

  // The CLI can begin work the driver never handed it - a follow-up it dequeued for itself
  // after the result, or a resumed stream picking up where it left off. An assistant frame is
  // proof of that, and taking it as proof is what keeps this value from being a prediction.
  query.emit({
    type: "assistant",
    session_id: "agent-1",
    message: { content: [{ type: "tool_use", name: "Bash" }] },
  } as ClaudeSdkMessage);
  await collect(handle.events, (e) => e.kind === "state");
  assert.equal(
    await handle.sendIfIdle({ text: "do not join a turn already running" }),
    null,
  );

  query.emit({ type: "result", subtype: "success", session_id: "agent-1" });
  await collect(handle.events, (e) => e.kind === "turn_done");
  assert.equal(await handle.sendIfIdle({ text: "now idle" }), "started");
  query.end();
});

test("a resumed Claude stream accepts a continuation without replaying the old intent", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(
    launchOpts({ prompt: "", resume: "agent-interrupted" }),
  );
  const { options, turns } = await started;
  assert.equal(options.resume, "agent-interrupted");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...turns], [], "resume itself adds no user turn");

  assert.equal(await handle.send({ text: "continue from the current checkout" }), "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.message.content, "continue from the current checkout");
  await handle.stop();
});

test("an authentication failure before binding exits as unresumable", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.emit({
    type: "assistant",
    error: "authentication_failed",
    message: { role: "assistant", content: [{ type: "text", text: "Not logged in" }] },
  } as ClaudeSdkMessage);
  query.emit({
    type: "result",
    subtype: "error_during_execution",
    errors: ["Not logged in · Please run /login"],
  } as ClaudeSdkMessage);
  await collect(handle.events, (event) => event.kind === "turn_done");

  const terminal = collect(handle.events, (event) => event.kind === "exited");
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await assert.rejects(
      handle.send({ text: "retry after external login" }),
      /authentication failed before this conversation could be resumed/,
    );
    const events = await Promise.race([
      terminal,
      new Promise<SdkEvent[]>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("unresumable authentication failure did not exit")),
          100,
        );
      }),
    ]);
    const exited = events.find((event) => event.kind === "exited");
    assert.equal(exited?.kind === "exited" && exited.resumable, false);
    assert.match(exited?.kind === "exited" ? exited.reason : "", /could be resumed/);
  } finally {
    if (timeout) clearTimeout(timeout);
    await handle.stop();
  }
});

test("an authentication failure reloads credentials by resuming on the next turn", async () => {
  const starts: Harnessed[] = [];
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ prompt, options }) => {
      const query = new FakeQuery();
      const turns: ClaudeSdkUserMessage[] = [];
      starts.push({ query, options, turns });
      void (async () => {
        for await (const turn of prompt) turns.push(turn);
        query.end();
      })();
      return query;
    },
  };

  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const first = starts[0]!;
  first.query.emit(INIT("agent-auth-recovery"));
  await collect(handle.events, (event) => event.kind === "bound");
  first.query.emit({
    type: "assistant",
    session_id: "agent-auth-recovery",
    error: "authentication_failed",
    message: { role: "assistant", content: [{ type: "text", text: "Not logged in" }] },
  });
  first.query.emit({
    type: "result",
    subtype: "error_during_execution",
    session_id: "agent-auth-recovery",
    errors: ["Not logged in · Please run /login"],
    uuid: "auth-failure-result",
    total_cost_usd: 10,
    modelUsage: {
      "claude-opus-5": {
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 10,
      },
    },
  } as ClaudeSdkMessage);
  await collect(handle.events, (event) => event.kind === "turn_done");

  assert.equal(
    await handle.sendIfIdle({ text: "continue after external login" }),
    "started",
  );
  const recoveryEvents = await collect(
    handle.events,
    (event) => event.kind === "state" && event.state === "working",
  );
  assert.equal(
    recoveryEvents.some((event) => event.kind === "exited"),
    false,
    "draining the stale process must not end the session",
  );
  assert.equal(starts.length, 2, "the stale SDK process is replaced exactly once");
  assert.equal(starts[1]!.options.resume, "agent-auth-recovery");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts[1]!.turns[0]?.message.content, "continue after external login");

  starts[1]!.query.emit(INIT("agent-auth-recovery"));
  starts[1]!.query.emit({
    type: "result",
    subtype: "success",
    session_id: "agent-auth-recovery",
    uuid: "recovered-result",
    total_cost_usd: 20,
    modelUsage: {
      "claude-opus-5": {
        inputTokens: 2_000,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 20,
      },
    },
  } as ClaudeSdkMessage);
  const recovered = (await collect(handle.events, (event) => event.kind === "turn_done"))
    .find((event) => event.kind === "turn_done");
  assert.equal(recovered?.kind === "turn_done" && recovered.usage?.costUsd, 20);
  assert.equal(recovered?.kind === "turn_done" && recovered.usage?.input, 2_000);
  await handle.stop();
});

test("a failed authentication recovery remains resumable for a later turn", async () => {
  const starts: Harnessed[] = [];
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ prompt, options }) => {
      const query = new FakeQuery();
      const turns: ClaudeSdkUserMessage[] = [];
      starts.push({ query, options, turns });
      void (async () => {
        for await (const turn of prompt) turns.push(turn);
        query.end();
      })();
      return query;
    },
  };

  const failAuthentication = (query: FakeQuery): void => {
    query.emit({
      type: "assistant",
      session_id: "agent-auth-retry",
      error: "authentication_failed",
      message: { role: "assistant", content: [{ type: "text", text: "Not logged in" }] },
    });
    query.emit({
      type: "result",
      subtype: "error_during_execution",
      session_id: "agent-auth-retry",
      errors: ["Not logged in · Please run /login"],
    });
  };

  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  starts[0]!.query.emit(INIT("agent-auth-retry"));
  await collect(handle.events, (event) => event.kind === "bound");
  failAuthentication(starts[0]!.query);
  await collect(handle.events, (event) => event.kind === "turn_done");

  assert.equal(await handle.send({ text: "retry before login completes" }), "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts.length, 2);
  assert.equal(starts[1]!.options.resume, "agent-auth-retry");
  failAuthentication(starts[1]!.query);
  starts[1]!.query.end();
  await collect(handle.events, (event) => event.kind === "turn_done");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await handle.send({ text: "continue after login completes" }), "started");
  const retryEvents = await collect(
    handle.events,
    (event) => event.kind === "state" && event.state === "working",
  );
  assert.equal(
    retryEvents.some((event) => event.kind === "exited"),
    false,
    "an ended authentication-failed replacement must remain recoverable",
  );
  assert.equal(starts.length, 3);
  assert.equal(starts[2]!.options.resume, "agent-auth-retry");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts[2]!.turns[0]?.message.content, "continue after login completes");

  starts[2]!.query.emit(INIT("agent-auth-retry"));
  starts[2]!.query.emit({
    type: "result",
    subtype: "success",
    session_id: "agent-auth-retry",
  });
  await collect(handle.events, (event) => event.kind === "turn_done");

  failAuthentication(starts[2]!.query);
  starts[2]!.query.end();
  await collect(handle.events, (event) => event.kind === "turn_done");
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = collect(handle.events, (event) => event.kind === "exited");
  await handle.stop();
  const stopped = await terminal;
  assert.equal(
    stopped.some((event) => event.kind === "exited"),
    true,
    "stopping an ended authentication-failed query must still end the session",
  );
});

test("overlapping sends share one authentication recovery and one resumed subprocess", async () => {
  const starts: Harnessed[] = [];
  let observeStaleClose!: () => void;
  const staleCloseObserved = new Promise<void>((resolve) => {
    observeStaleClose = resolve;
  });
  let releaseStaleDrain!: () => void;
  const staleDrainReleased = new Promise<void>((resolve) => {
    releaseStaleDrain = resolve;
  });
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ prompt, options }) => {
      const query = new FakeQuery();
      const turns: ClaudeSdkUserMessage[] = [];
      const launchIndex = starts.length;
      starts.push({ query, options, turns });
      void (async () => {
        for await (const turn of prompt) turns.push(turn);
        if (launchIndex === 0) {
          observeStaleClose();
          await staleDrainReleased;
        }
        query.end();
      })();
      return query;
    },
  };

  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const stale = starts[0]!.query;
  stale.emit(INIT("agent-auth-overlap"));
  await collect(handle.events, (event) => event.kind === "bound");
  stale.emit({
    type: "assistant",
    session_id: "agent-auth-overlap",
    error: "authentication_failed",
    message: { role: "assistant", content: [{ type: "text", text: "Not logged in" }] },
  });
  stale.emit({
    type: "result",
    subtype: "error_during_execution",
    session_id: "agent-auth-overlap",
    errors: ["Not logged in · Please run /login"],
  });
  await collect(handle.events, (event) => event.kind === "turn_done");

  const first = handle.send({ text: "first recovery message" });
  await staleCloseObserved;
  const second = handle.send({ text: "second overlapping message" });
  const idleOnly = handle.sendIfIdle({ text: "idle-only overlapping message" });
  await new Promise((resolve) => setImmediate(resolve));
  releaseStaleDrain();

  assert.deepEqual(await Promise.all([first, second, idleOnly]), ["started", "steered", null]);
  assert.equal(starts.length, 2, "overlapping sends must launch exactly one replacement");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    starts[1]!.turns.map((turn) => turn.message.content),
    ["first recovery message", "second overlapping message"],
  );
  assert.equal(starts[1]!.options.resume, "agent-auth-overlap");
  await handle.stop();
});

test("a stop racing authentication relaunch disposes the fresh query before attachment", async () => {
  const starts: Harnessed[] = [];
  let observeRelaunch!: () => void;
  const relaunchStarted = new Promise<void>((resolve) => {
    observeRelaunch = resolve;
  });
  let releaseRelaunch!: () => void;
  const relaunchReleased = new Promise<void>((resolve) => {
    releaseRelaunch = resolve;
  });
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ prompt, options }) => {
      const query = new FakeQuery();
      const turns: ClaudeSdkUserMessage[] = [];
      const launchIndex = starts.length;
      starts.push({ query, options, turns });
      if (launchIndex === 0) {
        void (async () => {
          for await (const turn of prompt) turns.push(turn);
          query.end();
        })();
      } else {
        observeRelaunch();
        await relaunchReleased;
      }
      return query;
    },
  };

  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const stale = starts[0]!.query;
  stale.emit(INIT("agent-auth-stop-race"));
  await collect(handle.events, (event) => event.kind === "bound");
  stale.emit({
    type: "assistant",
    session_id: "agent-auth-stop-race",
    error: "authentication_failed",
    message: { role: "assistant", content: [{ type: "text", text: "Not logged in" }] },
  });
  stale.emit({
    type: "result",
    subtype: "error_during_execution",
    session_id: "agent-auth-stop-race",
    errors: ["Not logged in · Please run /login"],
  });
  await collect(handle.events, (event) => event.kind === "turn_done");

  const terminal = collect(handle.events, (event) => event.kind === "exited");
  const recovering = handle.send({ text: "continue after external login" });
  await relaunchStarted;
  try {
    await handle.stop();
    releaseRelaunch();
    await assert.rejects(recovering, /this session's driver has stopped/);
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1]!.query.control, ["return"]);
    assert.equal(starts[1]!.query.iterationStarts, 0, "the stopped session must not attach it");
    const events = await terminal;
    const exited = events.find((event) => event.kind === "exited");
    assert.equal(exited?.kind === "exited" && exited.resumable, true);
  } finally {
    releaseRelaunch();
    starts[1]?.query.end();
    await handle.stop();
  }
});

test("an ordinary tool becomes a permission ask, and Yes allows it", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));

  let resolved: ClaudeSdkPermissionResult | null = null;
  const pending = options.canUseTool(
    "Bash",
    { command: "rm -rf build" },
    {
      requestId: "req-1",
      signal: new AbortController().signal,
      title: "Claude wants to run a command",
      suggestions: [{ type: "addRules" }],
    },
  );
  void pending.then((r) => (resolved = r));

  const events = await collect(handle.events, (e) => e.kind === "request");
  const request = events.find((e) => e.kind === "request");
  assert.ok(request?.kind === "request");
  assert.equal(request.request.kind, "permission");
  // Three rows, because the CLI offered suggestions: the always-allow row exists only when
  // there is a real rule set behind it to persist.
  assert.deepEqual(
    request.request.options.map((o) => o.label),
    ["Yes", "Yes, and don't ask again", "No"],
  );
  // The prompt leads with the bridge's own sentence and carries the command underneath.
  assert.match(request.request.prompt, /Claude wants to run a command/);
  assert.match(request.request.prompt, /rm -rf build/);

  await handle.answer("req-1", { kind: "option", number: 1, label: "Yes" });
  await pending;
  assert.deepEqual(resolved, { behavior: "allow" });
});

test("the always-allow row hands back the CLI's own suggestions, and No denies", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash" }] }];

  const always = options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "a", signal: new AbortController().signal, suggestions },
  );
  await collect(handle.events, (e) => e.kind === "request");
  await handle.answer("a", { kind: "option", number: 2, label: "Yes, and don't ask again" });
  // Verbatim: the rule set is the CLI's, composed for this exact call, and rewriting it here
  // would persist a permission nobody chose.
  assert.deepEqual(await always, { behavior: "allow", updatedPermissions: suggestions });

  const denied = options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "b", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");
  await handle.answer("b", { kind: "option", number: 2, label: "No" });
  const result = await denied;
  assert.equal(result.behavior, "deny");
});

test("a mislabelled row is refused rather than answered", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  void options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "c", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");

  // The number identifies and the label VERIFIES. A caller answering row 1 while believing
  // it says something else has confirmed nothing, and confirming it anyway is how a
  // permission prompt gets the opposite of the answer a human gave.
  await assert.rejects(
    () => handle.answer("c", { kind: "option", number: 1, label: "No" }),
    /is "Yes", not "No"/,
  );
  await assert.rejects(
    () => handle.answer("nope", { kind: "option", number: 1, label: "Yes" }),
    /no pending request/,
  );
});

test("AskUserQuestion becomes a form, and the answers map goes back as updatedInput", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));

  const input = {
    questions: [
      {
        question: "Which linter?",
        header: "Linter",
        multiSelect: false,
        options: [
          { label: "biome", description: "one binary" },
          { label: "eslint", description: "widest plugins" },
        ],
      },
      {
        question: "Which checks?",
        header: "Checks",
        multiSelect: true,
        options: [
          { label: "types", description: "tsc" },
          { label: "tests", description: "node:test" },
        ],
      },
    ],
  };
  const pending = options.canUseTool("AskUserQuestion", input, {
    requestId: "q1",
    signal: new AbortController().signal,
  });
  const events = await collect(handle.events, (e) => e.kind === "request");
  const request = events.find((e) => e.kind === "request");
  assert.ok(request?.kind === "request");
  assert.equal(request.request.kind, "question");
  assert.equal(request.request.questions?.length, 2);
  // A form's rows live on its questions. Flattened into one numbered list they would be
  // numbers the driver cannot map back - which is exactly why `driverDialog` refuses to.
  assert.deepEqual(request.request.options, []);
  const dialog = driverDialog(request.request);
  assert.equal(dialog.multiSelect, true);
  assert.deepEqual(dialog.options, []);
  assert.equal(dialog.questions?.[1]?.multiSelect, true);

  await handle.answer("q1", {
    kind: "form",
    answers: [
      { question: "Which linter?", labels: ["biome"] },
      { question: "Which checks?", labels: ["types", "tests"] },
    ],
  });
  const result = await pending;
  assert.equal(result.behavior, "allow");
  // The tool's own encoding: one string per question, several labels comma-joined. And the
  // rest of the input is preserved - `updatedInput` REPLACES the call's arguments.
  assert.deepEqual(result.behavior === "allow" && result.updatedInput, {
    ...input,
    answers: { "Which linter?": "biome", "Which checks?": "types, tests" },
  });
});

test("a form refuses a half answer and a single-select given two", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  void options.canUseTool(
    "AskUserQuestion",
    {
      questions: [
        { question: "A?", multiSelect: false, options: [{ label: "x" }, { label: "y" }] },
        { question: "B?", multiSelect: false, options: [{ label: "p" }, { label: "q" }] },
      ],
    },
    { requestId: "f", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");

  // Sending a half-filled form puts answers the human never gave under their name - the
  // same call the pane path makes when its review tab reports a gap.
  await assert.rejects(
    () => handle.answer("f", { kind: "form", answers: [{ question: "A?", labels: ["x"] }] }),
    /"B\?" was not answered/,
  );
  await assert.rejects(
    () =>
      handle.answer("f", {
        kind: "form",
        answers: [
          { question: "A?", labels: ["x", "y"] },
          { question: "B?", labels: ["p"] },
        ],
      }),
    /takes one answer/,
  );
});

test("ExitPlanMode is a plan approval, not a tool permission", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  const pending = options.canUseTool(
    "ExitPlanMode",
    { plan: "1. read\n2. write" },
    { requestId: "p", signal: new AbortController().signal },
  );
  const events = await collect(handle.events, (e) => e.kind === "request");
  const request = events.find((e) => e.kind === "request");
  assert.ok(request?.kind === "request");
  assert.equal(request.request.kind, "plan");
  assert.match(request.request.prompt, /1\. read/);
  await handle.answer("p", { kind: "option", number: 2, label: "No, keep planning" });
  assert.equal((await pending).behavior, "deny");
});

test("prose on a permission ask is a deny WITH a message, which no menu can express", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  const pending = options.canUseTool(
    "Bash",
    { command: "curl evil.test" },
    { requestId: "t", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");
  await handle.answer("t", { kind: "text", text: "no - use the vendored copy" });
  assert.deepEqual(await pending, {
    behavior: "deny",
    message: "no - use the vendored copy",
  });
});

test("a /clear rotation re-fires bound, so the card's decorations follow it", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, turns } = await started;
  query.emit(INIT("agent-1"));
  await collect(handle.events, (e) => e.kind === "bound");

  await handle.clearContext!();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(turns.at(-1)!.message.content, "/clear");

  // The CLI mints a new id and reports it on an ORDINARY frame, not a second init. Missing
  // that leaves the note, queue and goal on a key no later event can move.
  query.emit({ type: "assistant", session_id: "agent-2", message: { content: [] } });
  const events = await collect(handle.events, (e) => e.kind === "bound");
  const rebound = events.find((e) => e.kind === "bound");
  assert.equal(rebound?.kind === "bound" && rebound.agentSessionId, "agent-2");
});

test("assistant frames narrate, a result ends the turn, and the stream's end exits", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.emit(INIT("agent-1"));
  query.emit({
    type: "assistant",
    session_id: "agent-1",
    message: { content: [{ type: "tool_use", name: "Read" }] },
  });
  query.emit({ type: "result", subtype: "success", session_id: "agent-1" });
  query.end();

  const events = await collect(handle.events, (e) => e.kind === "exited");
  assert.ok(
    events.some((e) => e.kind === "state" && e.state === "working" && e.activity === "Read"),
    "the tool name is the ticker line",
  );
  assert.ok(events.some((e) => e.kind === "turn_done"));
  const exited = events.find((e) => e.kind === "exited");
  // Resumable, because it bound: there is an id on disk to pick back up after a restart.
  assert.equal(exited?.kind === "exited" && exited.resumable, true);
});

test("a session that never bound exits unresumable", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.end();
  const events = await collect(handle.events, (e) => e.kind === "exited");
  const exited = events.find((e) => e.kind === "exited");
  assert.equal(exited?.kind === "exited" && exited.resumable, false);
});

test("stop denies what is parked, so the CLI is never left waiting on an answer", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  const pending = options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "s", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");
  await handle.stop();
  // Left unanswered, the subprocess hangs on exit holding a control request nothing will
  // ever resolve.
  assert.equal((await pending).behavior, "deny");
  assert.ok(query.control.includes("interrupt"));
});

test("live controls delegate, and a mode this CLI has never heard of is refused", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.emit(INIT("agent-1"));
  await handle.setPermissionMode!("acceptEdits");
  await handle.setEffort!("xhigh");
  await handle.setModel!("claude-opus-5");
  assert.deepEqual(query.control, ["mode:acceptEdits", "effort:xhigh", "model:claude-opus-5"]);
  // `askForApproval` is a Codex profile sharing our union. The SDK validates the value, so
  // passing it through would fail the call for a reason no operator typed.
  await assert.rejects(() => handle.setPermissionMode!("askForApproval"), /no permission mode/);
});

test("every session may REACH bypass, and only the mode decides whether it is in it", async () => {
  // Two different things, and conflating them is the bug this pins from both sides.
  //
  // `allowDangerouslySkipPermissions` compiles to `--allow-dangerously-skip-permissions`
  // ("enable bypassing as an option, WITHOUT it being enabled by default"), not to
  // `--dangerously-skip-permissions` ("bypass all permission checks"). So it is sent
  // unconditionally: `bypassPermissions` is live-pickable through the mode chip, and the
  // vendor's `setPermissionMode` takes the mode alone, so launch is the only moment this can
  // be declared. Deriving it from the launch mode would leave a session dispatched in
  // `default` permanently unable to cycle into bypass.
  //
  // The safety property therefore moved to `permissionMode`, and that is the half asserted
  // hardest: a session launched in `acceptEdits` must still be IN `acceptEdits`.
  const bypass = fakeDeps();
  await claudeSdkSpec(bypass.deps).launch(launchOpts({ permissionMode: "bypassPermissions" }));
  const bypassOptions = (await bypass.started).options;
  assert.equal(bypassOptions.permissionMode, "bypassPermissions");
  assert.equal(bypassOptions.allowDangerouslySkipPermissions, true);

  const plain = fakeDeps();
  await claudeSdkSpec(plain.deps).launch(launchOpts({ permissionMode: "acceptEdits" }));
  const plainOptions = (await plain.started).options;
  assert.equal(plainOptions.permissionMode, "acceptEdits");
  assert.equal(plainOptions.allowDangerouslySkipPermissions, true);

  // A mode this CLI does not have is dropped by `sdkPermissionMode`, and dropping it must not
  // silently leave the session bypass-capable AND modeless in one step.
  const foreign = fakeDeps();
  await claudeSdkSpec(foreign.deps).launch(launchOpts({ permissionMode: "askForApproval" }));
  const foreignOptions = (await foreign.started).options;
  assert.equal(foreignOptions.permissionMode, undefined);
  assert.equal(foreignOptions.allowDangerouslySkipPermissions, true);
});

// The resume argv used to be asserted here, because it used to live on `SdkSpec`. It is a
// harness capability now (every harness has one; only Claude has a driver), so it is pinned
// in `harness-resume.test.ts` for all three rather than under this one adapter's tests.

test("the subprocess env drops the daemon's own pane, or every hook binds to it", () => {
  // Machine-installed `~/.claude/settings.json` hooks fire inside this subprocess too, and
  // the bridge reports TMUX_PANE as the pane it believes it is in. A daemon started from a
  // terminal would hand its own down, and `findSessionByEnv` prefers a pane key over
  // everything else - so every embedded session's hooks would land on one stranger's card.
  const env = sdkSubprocessEnv({ PATH: "/bin", TMUX_PANE: "%3", WEZTERM_PANE: "7", ITERM_SESSION_ID: "w0t0p0:UUID", TERM_PROGRAM: "x" });
  assert.equal(env.PATH, executableLocator.snapshot().path);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.WEZTERM_PANE, undefined);
  assert.equal(env.ITERM_SESSION_ID, undefined);
  assert.equal(env.TERM_PROGRAM, undefined);
});

test("the pure projections stand on their own", () => {
  // A malformed tool input degrades to nothing rather than to an empty form the human
  // could never submit; the caller then falls through to the permission shape.
  assert.deepEqual(askUserQuestions({}), []);
  assert.deepEqual(askUserQuestions({ questions: [{ question: "", options: [] }] }), []);
  // The bridge's own sentence wins; the tool name is the fallback, never the raw input -
  // which for a Write is a whole file body.
  assert.equal(permissionPrompt("Write", { content: "x".repeat(9000) }, {}), "Claude wants to use Write");
  assert.equal(sdkPermissionMode("readOnly"), null);
  assert.equal(sdkPermissionMode("plan"), "plan");
  assert.equal(sdkPermissionMode(null), null);
});

test("an aborted permission ask is DENIED, not merely forgotten", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));

  const abort = new AbortController();
  const pending = options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "gone", signal: abort.signal },
  );
  const events = await collect(handle.events, (e) => e.kind === "request");
  assert.ok(events.some((e) => e.kind === "request"));

  abort.abort();
  // The SDK is explicit about the consequence of not resolving: no control response is
  // sent, and a permission prompt has no park deadline, so the tool stays blocked for
  // ever. Clearing the card without resolving is the worst version of that - a turn hung
  // on a question nobody can see any more.
  const result = await pending;
  assert.equal(result.behavior, "deny", "an abandoned ask must fail CLOSED");
  const after = await collect(handle.events, (e) => e.kind === "request_resolved");
  assert.ok(after.some((e) => e.kind === "request_resolved" && e.requestId === "gone"));
});

test("a signal that is already aborted resolves rather than hanging", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  await collect(handle.events, (e) => e.kind === "bound");

  const abort = new AbortController();
  abort.abort();
  // An already-aborted signal never fires its event, so a listener alone would leave this
  // promise pending for ever - and put a card up for an ask that was over before it
  // arrived. Nothing is announced and nothing is held.
  const result = await options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "stale", signal: abort.signal },
  );
  assert.equal(result.behavior, "deny");
});

test("stop still wins the race against a later abort, with no double resolve", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  const abort = new AbortController();
  const pending = options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "both", signal: abort.signal },
  );
  await collect(handle.events, (e) => e.kind === "request");
  await handle.stop();
  const first = await pending;
  // `stop` removes its entry before resolving, and `abandon` is guarded by that same
  // delete - so the abort that follows a teardown is a no-op rather than a second answer.
  abort.abort();
  assert.equal(first.behavior, "deny");
  assert.match(first.behavior === "deny" ? first.message : "", /Mission Control stopped/);
});

test("the adapter refuses a duplicated question too, against its own request", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  void options.canUseTool(
    "AskUserQuestion",
    {
      questions: [
        { question: "A?", multiSelect: false, options: [{ label: "x" }, { label: "y" }] },
      ],
    },
    { requestId: "dup", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");

  // The route checks this against the card the operator saw; this checks it against the
  // request being answered. Both matter - the answers map is where the damage happens, and
  // a second write there silently replaces an answer the caller sent.
  await assert.rejects(
    () =>
      handle.answer("dup", {
        kind: "form",
        answers: [
          { question: "A?", labels: ["x"] },
          { question: "A?", labels: ["y"] },
        ],
      }),
    /answered twice/,
  );
});
