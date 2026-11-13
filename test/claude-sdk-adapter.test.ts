import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  claudeSdkRateLimits,
  claudeSdkSpec,
  askUserQuestions,
  permissionPrompt,
  sdkPermissionMode,
} from "../src/server/harness/claude/sdk.ts";
import { defaultClaudeSdkDeps, sdkSubprocessEnv } from "../src/server/harness/claude/sdk-deps.ts";
import { executableLocator } from "../src/server/executables/locator.ts";
import { driverDialog } from "../src/server/sdk/dialog.ts";
import { askChannelRedirect } from "../src/server/ask-channel-prompt.ts";
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
import { CompactionError } from "../src/server/harness/compaction.ts";

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
  recoveryProcessId: number | null = null;
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

test("resident compaction waits for the observed native boundary and result", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  const { query, turns } = await started;
  query.emit(INIT("fixture"));
  await collect(handle.events, e => e.kind === "bound");
  const operation = handle.compact!("Keep the current objective");
  await new Promise(r => setTimeout(r, 5));
  assert.equal(turns[0]?.message.content, "/compact Keep the current objective");
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/resident-compaction/claude-manual.json", import.meta.url), "utf8")) as ClaudeSdkMessage[];
  for (const frame of fixture) query.emit(frame);
  assert.deepEqual(await operation, { contextTokens: 494, contextWindow: 1_000_000 });
  await handle.stop();
});

test("a stalled resident compaction interrupts the CLI's /compact turn instead of leaving it open", async (t) => {
  // Read when the driver is built, so set before launch and restore after.
  process.env.MISSION_RESIDENT_COMPACTION_STALL_MS = "30";
  t.after(() => { delete process.env.MISSION_RESIDENT_COMPACTION_STALL_MS; });
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  const { query, turns } = await started;
  query.emit(INIT("fixture"));
  await collect(handle.events, e => e.kind === "bound");
  // The CLI accepts `/compact` and then never answers, as it did behind a dead network.
  await assert.rejects(handle.compact!(""), (error: unknown) => error instanceof CompactionError && error.retryable &&
    /no progress for 1 second and was interrupted/.test(error.message));
  assert.equal(turns[0]?.message.content, "/compact");
  assert.deepEqual(query.control.filter(c => c === "interrupt"), ["interrupt"]);
  await handle.stop();
});

test("resident compaction without a measured boundary refuses rather than accepting a completed command", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  const { query } = await started;
  const operation = handle.compact!("");
  const refused = assert.rejects(operation, /without a measured context boundary/);
  query.emit({ type: "result", subtype: "success" });
  await refused; await handle.stop();
});

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

test("a task's SDK session asks through request_input, never the built-in AskUserQuestion", async () => {
  const mcp = { serverName: "mission-control", command: "/usr/bin/node", args: ["/d/mcp.mjs"], env: {} };

  // With Mission MCP registered: the built-in is removed, `request_input` is pre-approved,
  // and the redirect leads one append that also carries the standing instructions.
  const withMcp = fakeDeps();
  await claudeSdkSpec(withMcp.deps).launch(
    launchOpts({ mcp, standingInstructions: "Never run E2E locally." }),
  );
  const options = (await withMcp.started).options;
  assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
  assert.deepEqual(options.allowedTools, ["mcp__mission-control__request_input"]);
  assert.deepEqual(options.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: `${askChannelRedirect("mission-control")}\n\nNever run E2E locally.`,
  });

  // Without it, nothing is taken away: an agent with no way to ask is worse than one that
  // keeps the built-in, so the whole channel is off rather than half of it.
  const withoutMcp = fakeDeps();
  await claudeSdkSpec(withoutMcp.deps).launch(launchOpts());
  const bare = (await withoutMcp.started).options;
  assert.equal("disallowedTools" in bare, false);
  assert.equal("allowedTools" in bare, false);
  assert.equal("systemPrompt" in bare, false);
});

test("the launch pins the binary, seeds turn one, and binds on init", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ permissionMode: "auto" }));
  const { query, options, turns } = await started;
  assert.equal(handle.recoveryProcessId, null);
  query.recoveryProcessId = 4242;
  assert.equal(handle.recoveryProcessId, 4242);

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

test("an embedded session opts in to the Artifact tool, unless the operator set it", async () => {
  // The CLI withholds `Artifact` from SDK entrypoints by default, so without this the Files
  // tab's Publish request reaches a session that has no tool to carry it out.
  const plain = fakeDeps();
  await claudeSdkSpec(plain.deps).launch(launchOpts());
  assert.deepEqual((await plain.started).options.env, { PATH: "/usr/bin", CLAUDE_CODE_ARTIFACT: "1" });

  // An operator's explicit off stays off.
  const off = fakeDeps();
  off.deps.env = () => ({ PATH: "/usr/bin", CLAUDE_CODE_ARTIFACT: "0" });
  await claudeSdkSpec(off.deps).launch(launchOpts());
  assert.equal((await off.started).options.env.CLAUDE_CODE_ARTIFACT, "0");
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
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ resume: "agent-cumulative-spend" }));
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
  assert.equal(first?.kind === "turn_done" && first.usageSnapshot?.resumed, true);
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
  assert.equal(rebound?.kind === "turn_done" && rebound.usageSnapshot?.resumed, false,
    "a changed conversation must not inherit the legacy resume gap policy");

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

for (const initialModel of [null, "claude-opus-5"]) {
  test(`authentication recovery preserves an accepted model upgrade from ${initialModel ?? "default"}`, async (t) => {
    const starts: Harnessed[] = [];
    const deps: ClaudeSdkDeps = {
      executable: async () => "/fake/bin/claude",
      env: () => ({}),
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
    const handle = await claudeSdkSpec(deps).launch(launchOpts({ model: initialModel }));
    t.after(() => handle.stop());
    const first = starts[0]!;
    first.query.emit(INIT("model-recovery"));
    await collect(handle.events, event => event.kind === "bound");
    await handle.setModel!("claude-opus-5-5");
    first.query.setModel = async () => { throw new Error("model unavailable"); };
    await assert.rejects(handle.setModel!("refused-model"), /model unavailable/);

    first.query.emit({ type: "assistant", session_id: "model-recovery", error: "authentication_failed" });
    first.query.emit({ type: "result", session_id: "model-recovery", subtype: "error_during_execution" });
    await collect(handle.events, event => event.kind === "turn_done");
    await handle.send({ text: "continue after login" });

    assert.equal(starts.length, 2);
    assert.equal(starts[1]!.options.resume, "model-recovery");
    assert.equal(starts[1]!.options.model, "claude-opus-5-5", "recovery must not restore the original model");
    assert.equal(starts[0]!.options.model, initialModel ?? undefined, "the first launch remains an unchanged snapshot");
  });
}

test("an authentication failure reloads credentials by resuming on the next turn", async () => {
  const starts: Harnessed[] = [];
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ prompt, options }) => {
      const query = new FakeQuery();
      query.recoveryProcessId = 100 + starts.length;
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
  assert.equal(handle.recoveryProcessId, 100);
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
  assert.equal(handle.recoveryProcessId, 101, "recovery must describe the replacement, not its stale query");
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
  assert.equal(recovered?.kind === "turn_done" && recovered.usage?.costUsd, 10);
  assert.equal(recovered?.kind === "turn_done" && recovered.usage?.input, 1_000);
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

/**
 * The shape of the AP - PR Shepherd hang: credentials expired during a long tool call, the
 * CLI folded a background-task notification into the running turn, its API call failed, and
 * it emitted the synthetic "Not logged in" frame with NO `result` after it. The process stayed
 * alive and silent, so the turn never closed, the resident never went idle, and the recovery
 * that runs on the next send never got a next send.
 */
function wedgedAuthDeps(opts: { staleIgnoresInputClose: boolean }) {
  const starts: Harnessed[] = [];
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    authFailureTurnGraceMs: 20,
    authRecoveryDrainMs: 20,
    query: async ({ prompt, options }) => {
      const query = new FakeQuery();
      const turns: ClaudeSdkUserMessage[] = [];
      const launchIndex = starts.length;
      starts.push({ query, options, turns });
      void (async () => {
        for await (const turn of prompt) turns.push(turn);
        // A wedged CLI does not act on its input closing; only `return()` ends it.
        if (!(opts.staleIgnoresInputClose && launchIndex === 0)) query.end();
      })();
      return query;
    },
  };
  return { starts, deps };
}

const NOT_LOGGED_IN = (sessionId: string): ClaudeSdkMessage => ({
  type: "assistant",
  session_id: sessionId,
  error: "authentication_failed",
  message: { role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
} as ClaudeSdkMessage);

test("an authentication failure the CLI never closes still ends the turn and recovers on the next send", async (t) => {
  const { starts, deps } = wedgedAuthDeps({ staleIgnoresInputClose: true });
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  t.after(() => handle.stop());
  const stale = starts[0]!.query;
  stale.emit(INIT("agent-auth-wedged"));
  await collect(handle.events, (event) => event.kind === "bound");

  stale.emit(NOT_LOGGED_IN("agent-auth-wedged"));
  // No `result` follows. Before the fix nothing ever left `working` from here.
  const closing = await collect(handle.events, (event) => event.kind === "turn_done");
  assert.equal(closing.some((event) => event.kind === "exited"), false, "the session must stay resumable");
  const done = closing.find((event) => event.kind === "turn_done");
  assert.equal(done?.kind === "turn_done" && done.usage, null, "the driver invents no usage");

  // The resident loop's next wake (or a human message) goes through sendIfIdle.
  assert.equal(await handle.sendIfIdle({ text: "continue after claude login" }), "started");
  assert.deepEqual(stale.control, ["return"], "a stale process that ignores its closed input is stopped");
  assert.equal(starts.length, 2, "the stale SDK process is replaced exactly once");
  assert.equal(starts[1]!.options.resume, "agent-auth-wedged");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts[1]!.turns[0]?.message.content, "continue after claude login");
});

test("authentication recovery resumes even when the stale process never drains after return()", async (t) => {
  const { starts, deps } = wedgedAuthDeps({ staleIgnoresInputClose: true });
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  t.after(() => handle.stop());
  const stale = starts[0]!.query;
  // Neither the closed input nor the SDK's own stop ends this process: `return()` never
  // settles and the stale query's stream never finishes.
  let returnCalls = 0;
  stale.return = () => {
    returnCalls += 1;
    return new Promise<never>(() => {});
  };
  stale.emit(INIT("agent-auth-undrained"));
  await collect(handle.events, (event) => event.kind === "bound");
  stale.emit(NOT_LOGGED_IN("agent-auth-undrained"));
  await collect(handle.events, (event) => event.kind === "turn_done");

  const sent = await Promise.race([
    handle.sendIfIdle({ text: "continue after claude login" }),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000).unref()),
  ]);
  assert.equal(sent, "started", "recovery must not wait on a stale process forever");
  assert.equal(returnCalls, 1, "the SDK was asked once to stop the stale process");
  assert.equal(starts.length, 2, "a replacement was launched anyway");
  assert.equal(starts[1]!.options.resume, "agent-auth-undrained");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts[1]!.turns.map((turn) => turn.message.content), ["continue after claude login"]);

  starts[1]!.query.emit(INIT("agent-auth-undrained"));
  starts[1]!.query.emit({ type: "result", subtype: "success", session_id: "agent-auth-undrained" } as ClaudeSdkMessage);
  const done = await collect(handle.events, (event) => event.kind === "turn_done");
  assert.equal(done.some((event) => event.kind === "exited"), false, "the resumed session stays live");
});

test("authentication recovery resumes when stopping the stale process throws synchronously", async (t) => {
  const { starts, deps } = wedgedAuthDeps({ staleIgnoresInputClose: true });
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  t.after(() => handle.stop());
  const stale = starts[0]!.query;
  // A transport that is already torn down may refuse the stop outright rather than reject.
  stale.return = () => {
    throw new Error("transport already closed");
  };
  stale.emit(INIT("agent-auth-throwing-stop"));
  await collect(handle.events, (event) => event.kind === "bound");
  stale.emit(NOT_LOGGED_IN("agent-auth-throwing-stop"));
  await collect(handle.events, (event) => event.kind === "turn_done");

  assert.equal(await handle.sendIfIdle({ text: "continue after claude login" }), "started");
  assert.equal(starts.length, 2, "the replacement is launched despite the refused stop");
  assert.equal(starts[1]!.options.resume, "agent-auth-throwing-stop");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts[1]!.turns.map((turn) => turn.message.content), ["continue after claude login"]);
});

test("an undrained stale process can neither steer nor end the resumed session", async (t) => {
  const { starts, deps } = wedgedAuthDeps({ staleIgnoresInputClose: true });
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  t.after(() => handle.stop());
  const stale = starts[0]!.query;
  stale.return = () => new Promise<never>(() => {});
  stale.emit(INIT("agent-auth-superseded"));
  await collect(handle.events, (event) => event.kind === "bound");
  stale.emit(NOT_LOGGED_IN("agent-auth-superseded"));
  await collect(handle.events, (event) => event.kind === "turn_done");
  assert.equal(await handle.sendIfIdle({ text: "first resumed turn" }), "started");
  const fresh = starts[1]!.query;
  fresh.emit(INIT("agent-auth-superseded"));
  fresh.emit({ type: "result", subtype: "success", session_id: "agent-auth-superseded" } as ClaudeSdkMessage);
  await collect(handle.events, (event) => event.kind === "turn_done");

  // The stale process finally speaks: none of it may reach the live conversation.
  stale.emit({
    type: "assistant",
    session_id: "agent-auth-superseded",
    message: { role: "assistant", content: [{ type: "text", text: "stale frame" }] },
  } as ClaudeSdkMessage);
  stale.emit({ type: "result", subtype: "success", session_id: "agent-auth-superseded" } as ClaudeSdkMessage);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await handle.sendIfIdle({ text: "fresh is idle" }), "started", "a stale frame must not mark the fresh turn busy");
  fresh.emit({ type: "result", subtype: "success", session_id: "agent-auth-superseded" } as ClaudeSdkMessage);
  await collect(handle.events, (event) => event.kind === "turn_done");

  // A second recovery replaces `recoveringQuery` while the first stale pump is still open.
  fresh.emit(NOT_LOGGED_IN("agent-auth-superseded"));
  await collect(handle.events, (event) => event.kind === "turn_done");
  assert.equal(await handle.sendIfIdle({ text: "second resumed turn" }), "started");
  assert.equal(starts.length, 3);

  const ended = collect(handle.events, (event) => event.kind === "exited" || event.kind === "turn_done");
  stale.end();
  await new Promise((resolve) => setImmediate(resolve));
  starts[2]!.query.emit(INIT("agent-auth-superseded"));
  starts[2]!.query.emit({ type: "result", subtype: "success", session_id: "agent-auth-superseded" } as ClaudeSdkMessage);
  const events = await ended;
  assert.equal(events.some((event) => event.kind === "exited"), false, "the first stale process ending must not end the session");
  assert.equal(events.at(-1)?.kind, "turn_done");
});

test("a turn the CLI resumes after the driver closed it still reports its completion", async (t) => {
  const { starts, deps } = wedgedAuthDeps({ staleIgnoresInputClose: false });
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  t.after(() => handle.stop());
  const query = starts[0]!.query;
  query.emit(INIT("agent-auth-resumed"));
  await collect(handle.events, (event) => event.kind === "bound");
  query.emit(NOT_LOGGED_IN("agent-auth-resumed"));
  await collect(handle.events, (event) => event.kind === "turn_done");

  // Past the grace, the CLI turns out to be working after all.
  query.emit({
    type: "assistant",
    session_id: "agent-auth-resumed",
    message: { role: "assistant", content: [{ type: "text", text: "continuing" }] },
  } as ClaudeSdkMessage);
  await collect(handle.events, (event) => event.kind === "state" && event.state === "working");
  query.emit({ type: "result", subtype: "success", session_id: "agent-auth-resumed" } as ClaudeSdkMessage);
  const done = await collect(handle.events, (event) => event.kind === "turn_done");
  assert.equal(done.at(-1)?.kind, "turn_done", "the reopened turn's result is its real completion");
  assert.equal(await handle.sendIfIdle({ text: "next turn" }), "started");
  assert.equal(starts.length, 1, "working credentials need no relaunch");
});

test("a late result for an auth-failed turn the driver already closed is not reported twice", async (t) => {
  const { starts, deps } = wedgedAuthDeps({ staleIgnoresInputClose: false });
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  t.after(() => handle.stop());
  const query = starts[0]!.query;
  query.emit(INIT("agent-auth-late"));
  await collect(handle.events, (event) => event.kind === "bound");
  query.emit(NOT_LOGGED_IN("agent-auth-late"));
  await collect(handle.events, (event) => event.kind === "turn_done");

  query.emit({ type: "result", subtype: "error_during_execution", session_id: "agent-auth-late" } as ClaudeSdkMessage);
  query.emit({ type: "system", subtype: "status", session_id: "agent-auth-late" } as ClaudeSdkMessage);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const stopped = collect(handle.events, (event) => event.kind === "exited");
  await handle.stop();
  const after = await stopped;
  assert.equal(after.filter((event) => event.kind === "turn_done").length, 0, "the late result is absorbed");
});

test("an auth-failed turn the CLI goes on to finish is not cut short or relaunched", async (t) => {
  const { starts, deps } = wedgedAuthDeps({ staleIgnoresInputClose: false });
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  t.after(() => handle.stop());
  const query = starts[0]!.query;
  query.emit(INIT("agent-auth-healed"));
  await collect(handle.events, (event) => event.kind === "bound");
  query.emit(NOT_LOGGED_IN("agent-auth-healed"));
  query.emit({
    type: "assistant",
    session_id: "agent-auth-healed",
    message: { role: "assistant", content: [{ type: "text", text: "refreshed and continuing" }] },
  } as ClaudeSdkMessage);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await handle.sendIfIdle({ text: "must not join a running turn" }), null, "the turn is still running");

  query.emit({ type: "result", subtype: "success", session_id: "agent-auth-healed" } as ClaudeSdkMessage);
  await collect(handle.events, (event) => event.kind === "turn_done");
  assert.equal(await handle.sendIfIdle({ text: "next turn" }), "started");
  assert.equal(starts.length, 1, "working credentials need no relaunch");
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

// ---- managed telemetry stays the agent's own --------------------------------------------

/**
 * Anything that would change where or whether Claude Code's OpenTelemetry is exported:
 * exporter routing, protocol, headers, export cadence, the SDK and enable switches, and the
 * capture switches. On a managed Mac the organization's policy sets these; Mission Control
 * must never contribute one. Trace-context propagation (`TRACEPARENT`) is not routing.
 */
const CLAUDE_OTEL_ROUTING =
  /\bOTEL_(?:EXPORTER_|BSP_|LOGS_|METRICS?_|TRACES_|LOG_|SDK_DISABLED)|\bCLAUDE_CODE_(?:ENABLE_TELEMETRY|ENHANCED_TELEMETRY)/;

test("an SDK launch adds no OpenTelemetry routing, so a managed policy keeps deciding it", async (t) => {
  // MDM is read by Claude itself. Remove inherited routing keys for this assertion so any
  // match came from Mission Control, including its shipped environment callback.
  const inherited = Object.entries(process.env).filter(([name]) => CLAUDE_OTEL_ROUTING.test(name));
  t.after(() => {
    for (const [name, value] of inherited) process.env[name] = value;
  });
  for (const [name] of inherited) delete process.env[name];
  for (const mcp of [null, { serverName: "mission-control", command: "/usr/bin/node", args: ["/d/mcp.mjs"], env: {} }]) {
    const { deps, started } = fakeDeps();
    deps.env = defaultClaudeSdkDeps.env;
    const handle = await claudeSdkSpec(deps).launch(launchOpts({ mcp }));
    try {
      const { options } = await started;
      const seen = JSON.stringify(options, (_key, value: unknown) => (typeof value === "function" ? undefined : value));
      assert.doesNotMatch(seen, CLAUDE_OTEL_ROUTING);
    } finally {
      await handle.stop();
    }
  }
});

test("the SDK subprocess env adds no OpenTelemetry routing of its own", () => {
  const env = sdkSubprocessEnv({ PATH: "/bin", HOME: "/home/op" }, "/wt/one", "/tmp/mission-sdk-state");
  assert.deepEqual(Object.keys(env).filter((name) => CLAUDE_OTEL_ROUTING.test(name)), []);
});

test("a turn Claude ended at capacity reports the failure on turn_done; other API errors do not", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  const repeated529 = "API Error: Repeated 529 Overloaded errors. The API is at capacity - this is usually temporary. Try again in a moment.";

  // Claude Code tags its exhausted-529 message `server_error`, so the wording decides.
  query.emit({
    type: "assistant",
    session_id: "agent-1",
    parent_tool_use_id: null,
    error: "server_error",
    message: { role: "assistant", content: [{ type: "text", text: repeated529 }] },
  });
  query.emit({ type: "result", subtype: "success", is_error: true, result: repeated529, session_id: "agent-1" });
  const first = (await collect(handle.events, (e) => e.kind === "turn_done")).at(-1);
  assert.deepEqual(first?.kind === "turn_done" && first.failure, { kind: "capacity", message: repeated529 });

  // A server error that is not about capacity, and a subagent's overload, end nothing early.
  assert.equal(await handle.sendIfIdle({ text: "again" }), "started");
  query.emit({
    type: "assistant",
    session_id: "agent-1",
    parent_tool_use_id: "toolu_1",
    error: "overloaded",
    message: { role: "assistant", content: [{ type: "text", text: "API Error: 529 Overloaded" }] },
  });
  query.emit({
    type: "assistant",
    session_id: "agent-1",
    parent_tool_use_id: null,
    error: "server_error",
    message: { role: "assistant", content: [{ type: "text", text: "API Error: 500 Internal server error" }] },
  });
  query.emit({ type: "result", subtype: "success", is_error: true, result: "API Error: 500 Internal server error", session_id: "agent-1" });
  const second = (await collect(handle.events, (e) => e.kind === "turn_done")).at(-1);
  assert.equal(second?.kind === "turn_done" && second.failure, undefined);

  // A stream with no assistant error frame: the error result alone still names the capacity.
  assert.equal(await handle.sendIfIdle({ text: "once more" }), "started");
  query.emit({ type: "result", subtype: "success", is_error: true, result: repeated529, session_id: "agent-1" });
  const third = (await collect(handle.events, (e) => e.kind === "turn_done")).at(-1);
  assert.deepEqual(third?.kind === "turn_done" && third.failure, { kind: "capacity", message: repeated529 });

  // The other two tags Claude Code ends a capacity turn with: `overloaded` is trusted whatever
  // the text says, and `rate_limit` only when the text names capacity, never a usage limit.
  const turnEndingWith = async (error: string, text: string) => {
    assert.equal(await handle.sendIfIdle({ text: `try ${error}` }), "started");
    query.emit({
      type: "assistant",
      session_id: "agent-1",
      parent_tool_use_id: null,
      error,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    // A result with no text, so the verdict can only come from the tagged frame above and
    // the result-only fallback cannot mask a tag the classifier stopped accepting.
    query.emit({ type: "result", subtype: "success", is_error: true, session_id: "agent-1" });
    const done = (await collect(handle.events, (e) => e.kind === "turn_done")).at(-1);
    return done?.kind === "turn_done" ? done.failure : null;
  };
  assert.deepEqual(
    await turnEndingWith("overloaded", "API Error: 529"),
    { kind: "capacity", message: "API Error: 529" },
  );
  const highLoad = "Opus is experiencing high load, please use /model to switch to Sonnet";
  assert.deepEqual(await turnEndingWith("rate_limit", highLoad), { kind: "capacity", message: highLoad });
  assert.equal(
    await turnEndingWith("rate_limit", "You've hit your usage limit. Try again later."),
    undefined,
    "a usage limit is not capacity: waiting minutes does not refill a plan",
  );
  query.end();
});

// A new adapter instance has no in-memory baseline. The Registry must still subtract
// the committed conversation snapshot, including an auxiliary model that ran only once.
test("resumed Claude adapters record only new spend across driver and database restarts", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { closeDb, sessionCostFor, fleetEstimatedCostSince, openDb } = await import("../src/server/db.ts");
  const conversation = "resume-ledger-regression";
  const fleetBefore = fleetEstimatedCostSince(0) ?? 0;
  async function run(resume: boolean, totals: number[], model = "claude-opus-5") {
    const registry = new Registry();
    const id = `sdk:resume-ledger-${resume}`;
    registry.registerSdkSession({ id, agent: "claude", name: "resume", cwd: "/wt/one" });
    const { deps, started } = fakeDeps();
    const handle = await claudeSdkSpec(deps).launch(launchOpts({ resume: resume ? conversation : null, model }));
    const { query } = await started;
    query.emit({ ...INIT(conversation), model });
    for (const event of await collect(handle.events, e => e.kind === "bound")) registry.applyDriverEvent(id, event);
    for (const total of totals) {
      if (total === 13) assert.equal(await handle.sendIfIdle({ text: "capacity retry" }), "started");
      query.emit({ type: "result", subtype: "success", session_id: conversation,
        uuid: `resume-result-${total}`, total_cost_usd: total + 1,
        ...(total === 10 ? { is_error: true, result: "API Error: Repeated 529 Overloaded errors. The API is at capacity" } : {}),
        modelUsage: {
          "claude-opus-5": { inputTokens: Math.min(total, 25) * 10, outputTokens: Math.min(total, 25) * 20,
            cacheReadInputTokens: Math.min(total, 25) * 100, cacheCreationInputTokens: Math.min(total, 25) * 5, costUSD: Math.min(total, 25) },
          ...(model === "claude-sonnet-5" ? { "claude-sonnet-5": {
            inputTokens: (total - 25) * 10, outputTokens: (total - 25) * 20,
            cacheReadInputTokens: (total - 25) * 100, costUSD: total - 25,
          } } : {}),
          "claude-haiku-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 635, costUSD: 1 },
        },
      } as ClaudeSdkMessage);
      for (const event of await collect(handle.events, e => e.kind === "turn_done")) {
        if (total === 10 && event.kind === "turn_done") assert.equal(event.failure?.kind, "capacity");
        registry.applyDriverEvent(id, event);
      }
    }
    assert.equal(registry.getSession(id)?.cost?.costUsd, totals.at(-1)! + 1);
    await handle.stop();
  }
  await run(false, [10, 13]);
  closeDb();
  await run(true, [20, 25]);
  assert.equal(sessionCostFor(conversation)?.costUsd, 26);
  assert.equal(sessionCostFor(conversation)?.cacheRead, 3135);
  assert.equal((fleetEstimatedCostSince(0) ?? 0) - fleetBefore, 26);
  const row = openDb().prepare("SELECT cost_usd, cache_read FROM usage_ledger WHERE note_key = ? AND window_end_ns = ? AND model_id = ?")
    .get(conversation, "resume-result-20", "claude-opus-5");
  assert.deepEqual({ ...row }, { cost_usd: 7, cache_read: 700 });
  await run(true, [30], "claude-sonnet-5");
  assert.equal(sessionCostFor(conversation)?.costUsd, 31, "model relaunch keeps the conversation baseline");
  assert.equal(sessionCostFor(conversation)?.cacheRead, 3635);
});

// Unlike a replacement driver on the same conversation, /clear must book the entire
// first result under the new note key, even if its counters exceed the old baseline.
test("a changed Claude conversation ID books its first result into session and fleet totals", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { sessionCostFor, fleetEstimatedCostSince, openDb } = await import("../src/server/db.ts");
  const oldConversation = "clear-ledger-old";
  const newConversation = "clear-ledger-new";
  const id = "sdk:clear-ledger";
  const registry = new Registry();
  registry.registerSdkSession({ id, agent: "claude", name: "clear", cwd: "/wt/one" });
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ resume: oldConversation }));
  const { query } = await started;
  const fleetBefore = fleetEstimatedCostSince(0) ?? 0;
  try {
    query.emit(INIT(oldConversation));
    for (const event of await collect(handle.events, e => e.kind === "bound")) registry.applyDriverEvent(id, event);
    async function result(conversation: string, total: number) {
      query.emit({ type: "result", subtype: "success", session_id: conversation,
        uuid: `${conversation}-${total}`, total_cost_usd: total,
        modelUsage: { "claude-opus-5": {
          inputTokens: total * 10, outputTokens: total * 2,
          cacheReadInputTokens: total * 100, cacheCreationInputTokens: total, costUSD: total,
        } },
      } as ClaudeSdkMessage);
      for (const event of await collect(handle.events, e => e.kind === "turn_done")) registry.applyDriverEvent(id, event);
    }
    await result(oldConversation, 20); // Approved legacy baseline-only transition.
    await result(oldConversation, 23);
    assert.equal(sessionCostFor(oldConversation)?.costUsd, 3);
    assert.equal((fleetEstimatedCostSince(0) ?? 0) - fleetBefore, 3);

    // Claude can announce /clear's changed identity on an ordinary result, without init.
    await result(newConversation, 40);
    assert.equal(registry.getSession(id)?.agentSessionId, newConversation);
    assert.equal(registry.getSession(id)?.cost?.costUsd, 40, "the card follows the new conversation");
    assert.equal(sessionCostFor(newConversation)?.costUsd, 40);
    assert.equal(sessionCostFor(newConversation)?.cacheRead, 4000);
    assert.equal(sessionCostFor(oldConversation)?.costUsd, 3, "the old conversation is unchanged");
    assert.equal((fleetEstimatedCostSince(0) ?? 0) - fleetBefore, 43);
    const row = openDb().prepare(`SELECT cost_usd, input, output, cache_read, cache_write
      FROM usage_ledger WHERE note_key = ? AND window_end_ns = ?`)
      .get(newConversation, `${newConversation}-40`);
    assert.deepEqual({ ...row }, { cost_usd: 40, input: 400, output: 80, cache_read: 4000, cache_write: 40 });

    await result(newConversation, 40);
    assert.equal((fleetEstimatedCostSince(0) ?? 0) - fleetBefore, 43, "replaying that first result adds nothing");
  } finally {
    await handle.stop();
  }
});

// This reference comes from per-request transcript usage and pinned list rates, not
// from the cumulative SDK cost fields that the adapter consumes. See the fixture README.
test("resumed Claude ledger, session and fleet reconcile with transcript requests at list rates", async (t) => {
  const { Registry } = await import("../src/server/registry.ts");
  const { closeDb, openDb, sessionCostFor, fleetEstimatedCostSince, fleetTokensSince } = await import("../src/server/db.ts");
  type TranscriptRequest = {
    requestId: string;
    message: {
      id: string;
      model: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
        cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
      };
    };
  };
  const transcript: TranscriptRequest[] = readFileSync(
    new URL("./fixtures/claude-resume-usage/transcript.jsonl", import.meta.url), "utf8",
  ).trim().split("\n").map(line => JSON.parse(line));
  // A response can have several content blocks, each repeating the same usage object.
  const requests = [...new Map(transcript.map(row => [
    `${row.message.id}:${row.requestId}`, row,
  ])).values()];
  assert.equal(transcript.length, 5);
  assert.equal(requests.length, 4);
  // USD/MTok, Sonnet 4.6 standard global API rates, verified 2026-11-05:
  // https://platform.claude.com/docs/en/about-claude/pricing
  const rates = { input: 3, output: 15, cacheRead: 0.30, write5m: 3.75, write1h: 6 };
  const pricedRequests = requests.map(({ message }) => {
    assert.equal(message.model, "claude-sonnet-4-6");
    const u = message.usage;
    const write5m = u.cache_creation.ephemeral_5m_input_tokens;
    const write1h = u.cache_creation.ephemeral_1h_input_tokens;
    assert.equal(u.cache_creation_input_tokens, write5m + write1h);
    return {
      input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens,
      cacheWrite: write5m + write1h,
      cost: (u.input_tokens * rates.input + u.output_tokens * rates.output
        + u.cache_read_input_tokens * rates.cacheRead + write5m * rates.write5m
        + write1h * rates.write1h) / 1_000_000,
    };
  });
  const expected = pricedRequests.reduce((a, r) => ({
    input: a.input + r.input, output: a.output + r.output,
    cacheRead: a.cacheRead + r.cacheRead, cacheWrite: a.cacheWrite + r.cacheWrite,
    cost: a.cost + r.cost,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const near = (actual: number | null | undefined, expectedCost: number, label: string) => {
    assert.equal(typeof actual, "number", `${label} must be priced`);
    assert.ok(Math.abs(actual! - expectedCost) < 1e-9, `${label}: ${actual} vs ${expectedCost}`);
  };
  const tokens = (value: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({
    input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite,
  });
  const frames: ClaudeSdkMessage[] = JSON.parse(readFileSync(
    new URL("./fixtures/claude-resume-usage/results.json", import.meta.url), "utf8",
  ));
  const conversation = "00000000-0000-4000-8000-000000001356";
  const costBefore = fleetEstimatedCostSince(0) ?? 0;
  const tokensBefore = fleetTokensSince(0);
  async function replay(resume: boolean, results: ClaudeSdkMessage[]) {
    const id = `sdk:transcript-reconciliation-${resume}`;
    const registry = new Registry();
    registry.registerSdkSession({ id, agent: "claude", name: "reconciliation", cwd: "/wt/one" });
    const { deps, started } = fakeDeps();
    const handle = await claudeSdkSpec(deps).launch(launchOpts({
      resume: resume ? conversation : null, model: "claude-sonnet-4-6",
    }));
    const { query } = await started;
    try {
      query.emit({ ...INIT(conversation), model: "claude-sonnet-4-6" });
      for (const event of await collect(handle.events, e => e.kind === "bound")) registry.applyDriverEvent(id, event);
      for (const frame of results) {
        query.emit(frame);
        for (const event of await collect(handle.events, e => e.kind === "turn_done")) registry.applyDriverEvent(id, event);
      }
      return registry.getSession(id)?.cost;
    } finally {
      await handle.stop();
    }
  }
  await replay(false, frames.slice(0, 2));
  closeDb();
  const card = await replay(true, frames.slice(2));
  const session = sessionCostFor(conversation);
  assert.ok(card && session);
  near(card.costUsd, expected.cost, "card cost");
  near(session.costUsd, expected.cost, "session cost");
  assert.deepEqual(tokens(card), tokens(expected));
  assert.deepEqual(tokens(session), tokens(expected));
  const ledger = openDb().prepare(`SELECT SUM(cost_usd) AS cost,
    SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead,
    SUM(cache_write) AS cacheWrite, COUNT(*) AS rows FROM usage_ledger WHERE note_key = ?`)
    .get(conversation) as typeof expected & { rows: number };
  near(ledger.cost, expected.cost, "ledger cost");
  assert.deepEqual(tokens(ledger), tokens(expected));
  assert.equal(ledger.rows, 3, "one row per completed turn, across both query instances");
  const resumedTurn = openDb().prepare(`SELECT cost_usd AS cost, input, output,
    cache_read AS cacheRead, cache_write AS cacheWrite FROM usage_ledger
    WHERE note_key = ? AND window_end_ns = 'fixture-result-3'`).get(conversation) as typeof expected;
  near(resumedTurn.cost, pricedRequests[3]!.cost, "resumed turn cost");
  assert.deepEqual(tokens(resumedTurn), tokens(pricedRequests[3]!));
  near((fleetEstimatedCostSince(0) ?? 0) - costBefore, expected.cost, "fleet cost contribution");
  assert.equal(fleetTokensSince(0) - tokensBefore,
    expected.input + expected.output + expected.cacheRead + expected.cacheWrite);
  t.diagnostic(`4 deduplicated transcript requests; list-rate cost $${expected.cost.toFixed(5)}; `
    + `${expected.input} input, ${expected.output} output, ${expected.cacheRead} cache-read, `
    + `${expected.cacheWrite} cache-write tokens reconcile with ledger, card/session and fleet after resume`);
});

test("resident durable memory uses flag settings and the same directory on resume", async () => {
  for (const resume of [null, "previous-conversation"]) {
    const { deps, started } = fakeDeps();
    const handle = await claudeSdkSpec(deps).launch(launchOpts({ residentStateDir: "/state/profile", resume }));
    const { options } = await started;
    assert.equal(options.settings?.autoMemoryDirectory, "/state/profile");
    assert.equal(options.settings?.autoMemoryEnabled, true);
    assert.equal(options.env.RESIDENT_STATE_DIR, "/state/profile");
    assert.ok(options.additionalDirectories?.includes("/state/profile"));
    await handle.stop();
  }
});

test("background sub-agents become one coalesced summary, and their frames never re-arm the parent", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.emit(INIT("agent-subagents"));
  await collect(handle.events, (e) => e.kind === "bound");

  const sys = (subtype: string, body: Record<string, unknown>): ClaudeSdkMessage =>
    ({ type: "system", subtype, session_id: "agent-subagents", ...body });
  query.emit({ type: "assistant", session_id: "agent-subagents", parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "launching" }] } });
  query.emit(sys("background_tasks_changed", { tasks: [
    { task_id: "a", task_type: "local_agent", subagent_type: "Explore", description: "Map call sites" },
    { task_id: "sh", task_type: "local_bash", description: "watch" },
  ] }));
  query.emit(sys("task_started", { task_id: "a", task_type: "local_agent", subagent_type: "Explore",
    description: "Map call sites", is_backgrounded: true, tool_use_id: "toolu_a" }));
  // Counter-only, inside the interval: held rather than sent.
  query.emit(sys("task_progress", { task_id: "a", description: "Map call sites", last_tool_name: "Grep",
    usage: { total_tokens: 10, tool_uses: 2, duration_ms: 1 } }));
  query.emit({ type: "result", subtype: "success", session_id: "agent-subagents" });
  const turn = await collect(handle.events, (e) => e.kind === "turn_done");
  const summaries = turn.flatMap((e) => (e.kind === "subagents" ? [e.subagents] : []));
  assert.equal(summaries.length, 2, "the level, then task_started's launch id; progress is held");
  assert.deepEqual(summaries[1]?.agents.map((a) => [a.id, a.type, a.state, a.launchTurnId, a.toolUses]), [
    ["a", "Explore", "running", "toolu_a", null],
  ]);

  // After the turn: a sub-agent's own frame, then its end.
  query.emit({ type: "assistant", session_id: "agent-subagents", parent_tool_use_id: "toolu_a",
    message: { role: "assistant", content: [{ type: "tool_use", id: "inner", name: "Grep", input: {} }] } });
  query.emit(sys("task_notification", { task_id: "a", status: "completed", summary: "found 4",
    usage: { total_tokens: 20, tool_uses: 3, duration_ms: 1 } }));
  const after = await collect(handle.events, (e) => e.kind === "subagents");
  assert.deepEqual(after.map((e) => e.kind), ["subagents"], "the sub-agent frame did not flip the parent to working");
  const done = after[0]!.kind === "subagents" ? after[0]!.subagents : null;
  assert.deepEqual(done?.agents.map((a) => [a.state, a.toolUses, a.summary]), [["completed", 3, "found 4"]]);

  // The operator's next turn folds the finished agent; nothing runs, so nothing is left.
  await handle.send({ text: "next" });
  const next = await collect(handle.events, (e) => e.kind === "subagents");
  assert.deepEqual(next.map((e) => e.kind), ["state", "subagents"]);
  assert.equal(next[1]!.kind === "subagents" && next[1]!.subagents, null);
  await handle.stop();
});

test("task frames the stale process sends while its replacement launches do not survive the relaunch", async (t) => {
  // The first process ignores its closed input; the relaunch is held open until the test says.
  const starts: Harnessed[] = [];
  let requested!: () => void;
  const relaunchRequested = new Promise<void>((resolve) => { requested = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    authFailureTurnGraceMs: 20,
    authRecoveryDrainMs: 20,
    query: async ({ prompt, options }) => {
      const query = new FakeQuery();
      const turns: ClaudeSdkUserMessage[] = [];
      const launchIndex = starts.length;
      starts.push({ query, options, turns });
      void (async () => {
        for await (const turn of prompt) turns.push(turn);
        if (launchIndex !== 0) query.end();
      })();
      if (launchIndex === 1) {
        requested();
        await released;
      }
      return query;
    },
  };
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ prompt: "" }));
  t.after(() => handle.stop());
  const stale = starts[0]!.query;
  stale.return = () => new Promise<never>(() => {});
  stale.emit(INIT("agent-auth-subagents"));
  await collect(handle.events, (event) => event.kind === "bound");
  stale.emit(NOT_LOGGED_IN("agent-auth-subagents"));
  await collect(handle.events, (event) => event.kind === "turn_done");

  const sending = handle.sendIfIdle({ text: "continue after login" });
  await relaunchRequested;
  // The stale process is still the attached query while the replacement launches.
  const sys = (subtype: string, body: Record<string, unknown>): ClaudeSdkMessage =>
    ({ type: "system", subtype, session_id: "agent-auth-subagents", ...body });
  stale.emit(sys("background_tasks_changed", { tasks: [
    { task_id: "ghost", task_type: "local_agent", subagent_type: "Explore", description: "from the replaced process" },
  ] }));
  stale.emit(sys("task_started", { task_id: "ghost", task_type: "local_agent", subagent_type: "Explore",
    description: "from the replaced process", is_backgrounded: true }));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal(await sending, "started");

  const events = await collect(handle.events, (e) => e.kind === "state" && e.state === "working");
  const summaries = events.flatMap((e) => (e.kind === "subagents" ? [e.subagents] : []));
  assert.ok(summaries.length > 0, "the stale frames did reach the driver before the relaunch landed");
  assert.equal(summaries.at(-1), null, "the replacement process starts with no sub-agents");
});

test("a sub-agent's frame during the parent's turn updates its activity without opening another turn", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.emit(INIT("agent-subagent-active"));
  await collect(handle.events, (e) => e.kind === "bound");

  // The parent's own turn is running (the launch seeded it); a foreground sub-agent reports.
  query.emit({ type: "assistant", session_id: "agent-subagent-active", parent_tool_use_id: "toolu_sub",
    message: { role: "assistant", content: [{ type: "tool_use", id: "inner", name: "Grep", input: {} }] } });
  // Bounded, so a frame that never reports fails here instead of hanging the suite.
  const during = await Promise.race([
    collect(handle.events, (e) => e.kind === "state"),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the sub-agent frame reported no activity")), 2_000)),
  ]);
  assert.deepEqual(during.at(-1), { kind: "state", state: "working", activity: "Grep" });

  // One result closes the one turn: the sub-agent frame opened nothing of its own.
  query.emit({ type: "result", subtype: "success", session_id: "agent-subagent-active" });
  const closed = await collect(handle.events, (e) => e.kind === "turn_done");
  assert.equal(closed.filter((e) => e.kind === "turn_done").length, 1);
  assert.equal(await handle.sendIfIdle({ text: "next" }), "started", "the session is idle once its turn ends");
  await handle.stop();
});
