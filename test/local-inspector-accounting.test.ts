/*
 * Local Inspector execution accounting across the repository-review result boundary.
 *
 * Every case drives the real path: WorkflowEngine -> runCheck -> runLocalInspector (stage) ->
 * RepositoryReview (adapter) -> LocalPersonaWorkloadExecutor -> a fake provider, against the
 * real WorkflowStore and a captured repository artifact. Only the provider is faked: it writes
 * the same audit journal and seal the repository MCP would, then returns or throws.
 *
 * The boundary under test is the provider returning a response. After it, a rejection of that
 * response (malformed verdict, no verified repository query, audit failure, interruption,
 * process death) keeps the Command allowance spent. Before it, an infrastructure failure gives
 * it back.
 */
import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKFLOW_POLICY } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-local-inspector-accounting-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { WorkflowEngine } = await import("../src/server/workflows/engine.ts");
const { WorkflowCommandManager } = await import("../src/server/workflows/commands.ts");
const { applyFeatureFlagIntent } = await import("../src/server/feature-flags/index.ts");
const { getInspectorConfig, setInspectorConfig } = await import("../src/server/inspector/config.ts");
const { InspectorConfigPatchSchema } = await import("../src/shared/protocol.ts");
const { seed, repository: createRepository, capture, audit, clean, usage, enableLocalInspector, localExecutor } =
  await import("./helpers/local-inspector-accounting-fixture.ts");
type Provider = import("./helpers/local-inspector-accounting-fixture.ts").Provider;

const prior = InspectorConfigPatchSchema.parse(getInspectorConfig());
enableLocalInspector();
const catalog = new WorkflowCommandManager(new Registry(), new WorkflowStore());
const command = catalog.get("inspector")!;
const saved = catalog.replace("inspector", { ...command, expectedRevision: command.revision, maxRuns: 1, onBudgetExhausted: "block" });
assert.ok(saved.ok);
after(() => {
  catalog.replace("inspector", { ...command, expectedRevision: saved.ok ? saved.view.revision : command.revision });
  setInspectorConfig(prior);
  applyFeatureFlagIntent({ kind: "flag", id: "local-inspector", enabled: false });
});

function repository(t: TestContext) {
  const source = createRepository();
  t.after(() => rmSync(source.repo, { recursive: true, force: true }));
  return source;
}

type Executor = import("../src/server/workflows/persona-workload/contracts.ts").PersonaWorkloadExecutor;

async function harness(t: TestContext, id: string, provider: Provider, options: {
  providerBinary?: (call: number) => Promise<string>;
  /** Replace the real executor, for a stream-only executor with a scripted replay. */
  executor?: Executor;
  /** Hand the real executor a return sink that throws instead of the supervisor's. */
  failingSink?: boolean;
} = {}) {
  const runId = `run-${id}`, submissionId = `submission-${id}`;
  const source = repository(t);
  const store = seed(id, source.repo);
  await capture(store, submissionId, source);
  // Commands permission for the repository, which the operator can revoke and grant again.
  const access = { granted: true };
  let providerCalls = 0, binaryCalls = 0;
  const providerReturns: number[] = [];
  const executor = localExecutor(store, async launch => {
    const call = ++providerCalls;
    const output = await provider(launch, call);
    providerReturns.push(call);
    return output;
  }, async () => {
    binaryCalls++;
    return options.providerBinary ? options.providerBinary(binaryCalls) : "/fixture/codex";
  });
  const engineOptions: ConstructorParameters<typeof WorkflowEngine>[2] = {
    workflowPolicy: () => ({ ...DEFAULT_WORKFLOW_POLICY, checksEnabled: true, repoAllowlist: access.granted ? [source.repo] : [] }),
    repositoryExecutor: options.executor ?? (options.failingSink ? withFailingSink(executor) : executor),
  };
  let engine = new WorkflowEngine(store, undefined, engineOptions);
  t.after(async () => { await engine.stop(); });
  const blocked = () => waitFor(() => store.getRun(runId)?.status === "blocked", 10_000);
  return {
    store, runId, submissionId,
    get providerCalls() { return providerCalls; },
    get providerReturns() { return providerReturns.length; },
    spent: () => store.checkRunsSpent(runId, "inspector", null),
    latest: (node = "inspect") => store.latestAttemptForNode(submissionId, node),
    start() { engine.start(); engine.activateSubmission(submissionId); },
    blocked,
    /** Revoke or restore Commands permission for the submitted repository. */
    grant(granted: boolean) { access.granted = granted; },
    /** Begin a daemon shutdown now: the review's shutdown signal aborts synchronously. */
    interrupt: () => engine.stop(),
    /** Daemon restart: a fresh engine over the same durable store. */
    async restart() {
      await engine.stop();
      engine = new WorkflowEngine(store, undefined, engineOptions);
      engine.start();
    },
    /** The retried gate settled, whichever way: refused, failed again, or passed. */
    retried: () => waitFor(() => {
      const latest = store.latestAttemptForNode(submissionId, "inspect");
      return latest?.attempt === 2 && (latest.state === "error" || latest.state === "completed");
    }, 10_000),
    /** The operator's Retry on the blocked gate, then let the engine run it. */
    async retry(requestId = randomUUID()) {
      const failed = store.latestAttemptForNode(submissionId, "inspect")!;
      const result = store.manualInfrastructureRetry(runId, submissionId, failed, requestId, randomUUID(), Date.now());
      engine.activateSubmission(submissionId);
      return result;
    },
  };
}

/** The real executor, but every return sink write fails: its storage is unavailable. */
function withFailingSink(executor: Executor & { dispatch: Executor["dispatch"] }): Executor {
  const dispatch = executor.dispatch.bind(executor);
  executor.dispatch = (request, signal) => dispatch(request, signal, {
    returned() { throw new Error("fixture: return witness storage is unavailable"); },
  });
  return executor;
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeoutMs) throw new Error("timed out waiting for workflow engine");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function report(label: string, value: Record<string, unknown>) {
  console.log(JSON.stringify({ case: label, ...value }));
}

for (const scenario of [
  {
    id: "returned-malformed-verdict",
    label: "a returned malformed verdict",
    provider: (async launch => { await audit(launch); return { verdict: { findings: "not a list" }, usage }; }) as Provider,
    error: /invalid_verdict/,
  },
  {
    id: "returned-without-repository-evidence",
    label: "a returned valid verdict without a verified repository query",
    provider: (async launch => { await audit(launch, { query: false }); return { verdict: clean, usage }; }) as Provider,
    error: /verified repository query/,
  },
  {
    id: "returned-then-audit-failure",
    label: "a returned response whose audit seal does not match",
    provider: (async launch => {
      await audit(launch);
      const prefix = "REPOSITORY_MCP_DESCRIPTOR=";
      const descriptor = launch.mcp.args.find(arg => arg.startsWith(prefix))!.slice(prefix.length);
      const { auditPath } = JSON.parse(await readFile(descriptor, "utf8")) as { auditPath: string };
      await writeFile(auditPath + ".seal", JSON.stringify({ workloadId: launch.request.workloadId,
        attemptId: launch.request.attemptId, count: 1, sha256: "0".repeat(64) }));
      return { verdict: clean, usage };
    }) as Provider,
    error: /audit_unavailable/,
  },
  {
    id: "returned-invalid-usage",
    label: "a returned response whose usage is malformed",
    // A negative token count fails the usage schema the executor checks after the return.
    provider: (async launch => { await audit(launch); return { verdict: clean, usage: { input_tokens: -1 } }; }) as Provider,
    error: /provider_unavailable/,
  },
]) {
  test(`Local Inspector keeps the allowance spent after ${scenario.label}, across retry and restart`, { timeout: 30_000 }, async t => {
    const h = await harness(t, scenario.id, scenario.provider);
    h.start();
    await h.blocked();
    assert.equal(h.store.getRun(h.runId)?.currentPhase, "command_action_required");
    assert.match(h.latest()?.error ?? "", scenario.error, "the rejected review still blocks; nothing passes");
    assert.equal(h.latest("inspect-again"), null, "a rejected review never advances to the next gate");
    assert.equal(h.providerReturns, 1);
    const spentAfterRejection = h.spent();

    // Daemon restart: the allowance is read back from durable state, not memory.
    await h.restart();
    const spentAfterRestart = h.spent();

    // Operator retry: the next execution must ask the same allowance of one.
    await h.retry();
    await h.retried();
    const retryError = h.latest()?.error ?? "";
    report(scenario.label, { maxRuns: 1, providerReturns: h.providerReturns, spentAfterRejection,
      spentAfterRestart, spentAfterRetry: h.spent(), retryError: retryError.slice(0, 160) });
    assert.equal(spentAfterRejection, 1, "a returned provider response spends the execution");
    assert.equal(spentAfterRestart, 1);
    assert.match(retryError, /allowance is exhausted \(1\/1\)/);
    assert.match(retryError, /earlier review could not be completed/i);
    assert.equal(h.providerCalls, 1, "the exhausted allowance refuses a second provider call");
    assert.equal(h.spent(), 1);
  });
}

test("Local Inspector refunds a failure before the provider is launched", { timeout: 30_000 }, async t => {
  const h = await harness(t, "before-provider", async launch => { await audit(launch); return { verdict: clean, usage }; }, {
    providerBinary: async call => {
      if (call === 1) throw new Error("Repository reviewer requires codex");
      return "/fixture/codex";
    },
  });
  h.start();
  await h.blocked();
  assert.match(h.latest()?.error ?? "", /provider_unavailable/);
  const spentAfterFailure = h.spent();
  await h.retry();
  // The refunded allowance runs the retry, which passes and leaves the shared allowance spent,
  // so the second gate on the same Command is refused.
  await waitFor(() => h.latest("inspect-again")?.state === "error", 10_000);
  report("pre-provider failure", { maxRuns: 1, spentAfterFailure, providerCalls: h.providerCalls, spentAfterRetry: h.spent(),
    secondGate: h.latest("inspect-again")?.error?.slice(0, 120) });
  assert.equal(spentAfterFailure, 0, "a provider that never ran is never charged");
  assert.equal(h.providerCalls, 1);
  assert.match(JSON.stringify(h.latest()?.output), /"status":"passed"/);
  assert.equal(h.spent(), 1);
  assert.match(h.latest("inspect-again")?.error ?? "", /allowance is exhausted \(1\/1\)/);
});

test("Local Inspector charges a healthy review once and refuses the next call on the same Command", { timeout: 30_000 }, async t => {
  const h = await harness(t, "healthy", async launch => { await audit(launch); return { verdict: clean, usage }; });
  h.start();
  await waitFor(() => h.latest("inspect-again")?.state === "error", 10_000);
  report("healthy review", { maxRuns: 1, providerCalls: h.providerCalls, spent: h.spent(),
    firstGate: h.latest()?.state, secondGate: h.latest("inspect-again")?.error?.slice(0, 120) });
  assert.match(JSON.stringify(h.latest()?.output), /"status":"passed"/);
  assert.equal(h.spent(), 1);
  assert.equal(h.providerCalls, 1);
  assert.match(h.latest("inspect-again")?.error ?? "", /allowance is exhausted \(1\/1\)/);
});

test("Local Inspector interrupted after the provider returned stays charged across restart", { timeout: 30_000 }, async t => {
  let returned!: () => void;
  const providerReturned = new Promise<void>(resolve => { returned = resolve; });
  // No seal: the executor waits for one after the provider returns, which is where the
  // daemon is stopped.
  const h = await harness(t, "interrupted-after-return", async (launch, call) => {
    await audit(launch, { seal: call !== 1 });
    if (call === 1) setImmediate(returned);
    return { verdict: clean, usage };
  });
  h.start();
  await providerReturned;
  await new Promise(resolve => setTimeout(resolve, 100));
  await h.restart();
  await h.blocked();
  const spentAfterRestart = h.spent();
  await h.retry();
  await h.retried();
  report("interrupted after provider return", { maxRuns: 1, providerReturns: h.providerReturns, spentAfterRestart,
    providerCalls: h.providerCalls, retryError: h.latest()?.error?.slice(0, 120) });
  assert.equal(spentAfterRestart, 1);
  assert.equal(h.providerCalls, 1);
  assert.match(h.latest()?.error ?? "", /allowance is exhausted \(1\/1\)/);
});

test("Local Inspector interrupted at the instant the provider returns stays charged across restart", { timeout: 30_000 }, async t => {
  let stopping: Promise<void> | undefined;
  // The shutdown is queued by the provider itself, so it aborts the review in the same tick
  // the provider's reply resolves: before the supervisor can read and record that return in
  // order.
  const h = await harness(t, "interrupted-at-return", async (launch, call) => {
    await audit(launch);
    if (call === 1) queueMicrotask(() => { stopping = h.interrupt(); });
    return { verdict: clean, usage };
  });
  h.start();
  await waitFor(() => stopping !== undefined, 10_000);
  await stopping;
  await h.restart();
  await h.blocked();
  const spentAfterRestart = h.spent();
  await h.retry();
  await h.retried();
  report("interrupted at the instant of provider return", { maxRuns: 1, providerReturns: h.providerReturns, spentAfterRestart,
    providerCalls: h.providerCalls, firstError: h.store.listAttempts(h.submissionId).find(a => a.nodeId === "inspect")?.error?.slice(0, 120),
    retryError: h.latest()?.error?.slice(0, 120) });
  assert.equal(h.providerReturns, 1);
  assert.equal(spentAfterRestart, 1, "a reply that resolved is an execution even when shutdown wins the race to record it");
  assert.equal(h.providerCalls, 1, "no second provider call");
  assert.match(h.latest()?.error ?? "", /allowance is exhausted \(1\/1\)/);
});

test("Local Inspector keeps a return charged when the grant expires at the instant the provider returns", { timeout: 30_000 }, async t => {
  // The operator revokes Commands permission in the same tick the provider's reply resolves,
  // so the workload no longer owns its grant when the supervisor tries to record that return.
  const h = await harness(t, "grant-expired-at-return", async (launch, call) => {
    await audit(launch);
    if (call === 1) queueMicrotask(() => h.grant(false));
    return { verdict: clean, usage };
  });
  h.start();
  await h.blocked();
  const firstError = h.latest()?.error ?? "";
  const passed = h.store.listAttempts(h.submissionId).some(a => JSON.stringify(a.output ?? null).includes('"status":"passed"'));
  const spentAfterRejection = h.spent();
  // The operator grants permission again and the daemon restarts before the retry.
  h.grant(true);
  await h.restart();
  const spentAfterRestart = h.spent();
  await h.retry();
  await h.retried();
  report("grant expired at the instant of provider return", { maxRuns: 1, providerReturns: h.providerReturns,
    firstError: firstError.slice(0, 120), passed, spentAfterRejection, spentAfterRestart, providerCalls: h.providerCalls,
    retryError: h.latest()?.error?.slice(0, 120) });
  assert.equal(h.providerReturns, 1);
  assert.match(firstError, /could not complete repository review|ownership expired/i, "the review is still rejected");
  assert.equal(passed, false, "an expired grant never turns the review into a pass");
  assert.equal(h.latest("inspect-again"), null);
  assert.equal(spentAfterRejection, 1);
  assert.equal(spentAfterRestart, 1, "the returned execution stays spent after restart");
  assert.equal(h.providerCalls, 1, "no second provider call");
  assert.match(h.latest()?.error ?? "", /allowance is exhausted \(1\/1\)/);
});

test("Local Inspector keeps a returned execution spent when the daemon process dies at the return", { timeout: 60_000 }, async t => {
  const id = "process-death-at-return";
  const runId = `run-${id}`, submissionId = `submission-${id}`;
  const source = repository(t);
  // The child runs the review on this same state home and is SIGKILLed right after the
  // provider's reply reaches the executor. Nothing in it gets to clean up or replay.
  const child = spawnSync(process.execPath, ["--import", "tsx", "test/helpers/local-inspector-crash.ts",
    id, source.repo, source.base, source.head, source.tree],
  { env: { ...process.env }, encoding: "utf8", timeout: 40_000 });
  assert.equal(child.signal, "SIGKILL", `the child died at the return boundary: ${child.status} ${child.stderr}`);
  const store = new WorkflowStore();
  const first = store.latestAttemptForNode(submissionId, "inspect")!;
  assert.equal(first.state, "running", "the dead daemon left its review in flight");
  const witness = openDb().prepare(`SELECT e.kind FROM workflow_repository_events e JOIN workflow_llm_calls l ON l.id = e.workload_id
    WHERE l.node_attempt_id = ? AND e.kind = 'persona_returned'`).get(first.id);

  // Restart: a fresh daemon recovers the interrupted review and retries it on the same allowance.
  let providerCalls = 0;
  const executor = localExecutor(store, async launch => {
    providerCalls++;
    await audit(launch);
    return { verdict: clean, usage };
  });
  // The dead process's workload is gone, which the restarted executor confirms.
  const reconcile = executor.reconcile.bind(executor);
  executor.reconcile = async (workloadId, after) => {
    const status = await reconcile(workloadId, after);
    return status.state === "unknown" ? { ...status, state: "terminal" } : status;
  };
  const engine = new WorkflowEngine(store, undefined, {
    workflowPolicy: () => ({ ...DEFAULT_WORKFLOW_POLICY, checksEnabled: true, repoAllowlist: [source.repo] }),
    repositoryExecutor: executor,
  });
  t.after(async () => { await engine.stop(); });
  engine.start();
  await waitFor(() => {
    const latest = store.latestAttemptForNode(submissionId, "inspect");
    return Boolean(latest && latest.id !== first.id && (latest.state === "error" || latest.state === "completed"));
  }, 10_000);
  const retry = store.latestAttemptForNode(submissionId, "inspect")!;
  report("daemon process death at the instant of provider return", { maxRuns: 1, childSignal: child.signal,
    witnessRecorded: Boolean(witness), spentAfterRestart: store.checkRunsSpent(runId, "inspector", null),
    providerCallsAfterRestart: providerCalls, retryState: retry.state, retryError: retry.error?.slice(0, 120) });
  assert.ok(witness, "the return was recorded durably before the process died");
  assert.equal(store.checkRunsSpent(runId, "inspector", null), 1);
  assert.equal(providerCalls, 0, "the restarted daemon makes no second provider call");
  assert.equal(retry.state, "error");
  assert.match(retry.error ?? "", /allowance is exhausted \(1\/1\)/);
  assert.equal(store.latestAttemptForNode(submissionId, "inspect-again"), null);
});

for (const replay of [
  { name: "a genuine replayed return", charged: true },
  { name: "a replayed return for another attempt", charged: false },
  { name: "a replayed return after a sequence gap", charged: false },
] as const) {
  test(`Local Inspector return recovery ${replay.charged ? "charges" : "refuses"} ${replay.name}`, { timeout: 30_000 }, async t => {
    const { REPOSITORY_EVIDENCE_CAPABILITY } = await import("../src/shared/repository-access.ts");
    type Event = import("../src/shared/repository-access.ts").PersonaWorkloadEvent;
    let replayed: Event[] = [];
    // A stream-only executor: no sink. Its live stream breaks off after a recorded start, so the
    // return can reach the supervisor only through replay, which carries the case's return.
    const executor: Executor = {
      repositoryEvidenceCapability: REPOSITORY_EVIDENCE_CAPABILITY,
      async *dispatch(request) {
        const event = (type: "accepted" | "repository_verified" | "persona_started" | "persona_returned", sequence: number,
          attemptId = request.attemptId): Event => ({ type, sequence, attemptId, workloadId: request.workloadId,
          eventId: randomUUID(), timestamp: Date.now() });
        replayed = [event("accepted", 1), event("repository_verified", 2), event("persona_started", 3),
          replay.name.includes("another attempt") ? event("persona_returned", 4, randomUUID())
            : replay.name.includes("gap") ? event("persona_returned", 5) : event("persona_returned", 4)];
        yield* replayed.slice(0, 3);
        yield event("persona_returned", 9);
      },
      async reconcile(workloadId, after) {
        return { workloadId, state: "terminal", events: replayed.filter(event => event.sequence > after) };
      },
      async cancel() {},
    };
    const h = await harness(t, `replay-${replay.name.split(" ").slice(-2).join("-")}`, async () => {
      throw new Error("the stream-only executor never launches the fake provider");
    }, { executor });
    h.start();
    await h.blocked();
    const first = h.latest()!;
    const witness = openDb().prepare(`SELECT 1 FROM workflow_repository_events e JOIN workflow_llm_calls l ON l.id = e.workload_id
      WHERE l.node_attempt_id = ? AND e.kind = 'persona_returned'`).get(first.id);
    await h.restart();
    report(`replayed return: ${replay.name}`, { maxRuns: 1, witnessRecorded: Boolean(witness), spentAfterRestart: h.spent(),
      firstError: first.error?.slice(0, 120) });
    assert.match(first.error ?? "", /sequence mismatch/, "the live stream itself was rejected");
    assert.equal(h.latest("inspect-again"), null, "the review never passes");
    assert.equal(Boolean(witness), replay.charged);
    assert.equal(h.spent(), replay.charged ? 1 : 0);
  });
}

for (const sink of [
  { id: "other-attempt", name: "a sink return naming another attempt", charged: false, error: /sequence mismatch/ },
  { id: "conflict", name: "a sink return followed by a conflicting streamed event", charged: true, error: /Conflicting repository event/ },
  { id: "before-start", name: "a sink return before the provider started", charged: false, error: /sequence mismatch/ },
  { id: "after-terminal", name: "a sink return after a terminal failure", charged: false, error: /provider_unavailable/ },
] as const) {
  test(`Local Inspector return sink: ${sink.name}`, { timeout: 30_000 }, async t => {
    const { REPOSITORY_EVIDENCE_CAPABILITY } = await import("../src/shared/repository-access.ts");
    type Event = import("../src/shared/repository-access.ts").PersonaWorkloadEvent;
    // An executor that writes its return, with its event history, through the supervisor's
    // sink, then streams. The sink must apply the stream's own identity and ordering rule.
    const executor: Executor = {
      repositoryEvidenceCapability: REPOSITORY_EVIDENCE_CAPABILITY,
      async *dispatch(request, _signal, sinks) {
        const event = <T extends Event["type"]>(type: T, sequence: number, attemptId = request.attemptId) => ({ type, sequence,
          attemptId, workloadId: request.workloadId, eventId: randomUUID(), timestamp: Date.now() }) as Extract<Event, { type: T }>;
        const history: Event[] = [event("accepted", 1), event("repository_verified", 2)];
        if (sink.id !== "before-start") history.push(event("persona_started", 3));
        if (sink.id === "after-terminal") history.push({ ...event("terminal", 4), capability: REPOSITORY_EVIDENCE_CAPABILITY,
          result: { status: "failed", code: "provider_unavailable" } });
        yield* history;
        try {
          sinks?.returned?.(event("persona_returned", history.length + 1,
            sink.id === "other-attempt" ? randomUUID() : request.attemptId), history);
        } catch {
          // A refused sink write never stops the workload; the stream decides what follows.
        }
        // The conflict case reports a different event at the sink's sequence; the others break
        // the stream off, so only the sink could have charged them.
        if (sink.id === "conflict") yield event("persona_returned", 4);
        else if (sink.id !== "after-terminal") yield event("persona_returned", 9);
      },
      async reconcile(workloadId) { return { workloadId, state: "terminal", events: [] }; },
      async cancel() {},
    };
    const h = await harness(t, `sink-${sink.id}`, async () => {
      throw new Error("the scripted executor never launches the fake provider");
    }, { executor });
    h.start();
    await h.blocked();
    const first = h.latest()!;
    const witnesses = openDb().prepare(`SELECT e.sequence FROM workflow_repository_events e JOIN workflow_llm_calls l ON l.id = e.workload_id
      WHERE l.node_attempt_id = ? AND e.kind = 'persona_returned'`).all(first.id).map(row => Number(row.sequence));
    await h.restart();
    report(`return sink: ${sink.name}`, { maxRuns: 1, witnesses, spentAfterRestart: h.spent(), firstError: first.error?.slice(0, 120) });
    assert.match(first.error ?? "", sink.error);
    assert.equal(h.latest("inspect-again"), null, "the review never passes");
    assert.deepEqual(witnesses, sink.charged ? [4] : [], "only this attempt's own return is ever recorded");
    assert.equal(h.spent(), sink.charged ? 1 : 0);
  });
}

test("Local Inspector still charges a returned review when the return sink throws", { timeout: 30_000 }, async t => {
  // The real executor, a returned malformed verdict, and a sink that fails: the executor must
  // still queue the return, and the supervisor records it from the stream in order.
  const h = await harness(t, "failing-sink", async launch => {
    await audit(launch);
    return { verdict: { findings: "not a list" }, usage };
  }, { failingSink: true });
  h.start();
  await h.blocked();
  const first = h.latest()!;
  const witness = openDb().prepare(`SELECT e.sequence FROM workflow_repository_events e JOIN workflow_llm_calls l ON l.id = e.workload_id
    WHERE l.node_attempt_id = ? AND e.kind = 'persona_returned'`).get(first.id);
  await h.restart();
  const spentAfterRestart = h.spent();
  await h.retry();
  await h.retried();
  report("return sink throws", { maxRuns: 1, providerReturns: h.providerReturns, witnessRecorded: Boolean(witness),
    firstError: first.error?.slice(0, 120), spentAfterRestart, providerCalls: h.providerCalls, retryError: h.latest()?.error?.slice(0, 120) });
  assert.match(first.error ?? "", /invalid_verdict/, "the returned verdict is still rejected");
  assert.equal(h.latest("inspect-again"), null);
  assert.ok(witness, "the queued return reached the stream and was recorded");
  assert.equal(spentAfterRestart, 1);
  assert.equal(h.providerCalls, 1, "no second provider call");
  assert.match(h.latest()?.error ?? "", /allowance is exhausted \(1\/1\)/);
});

test("Local Inspector interrupted before the provider returned is refunded across restart", { timeout: 30_000 }, async t => {
  let started!: () => void;
  const providerStarted = new Promise<void>(resolve => { started = resolve; });
  const h = await harness(t, "interrupted-before-return", async (launch, call) => {
    if (call === 1) {
      started();
      await new Promise<void>(resolve => launch.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("provider stopped before it returned");
    }
    await audit(launch);
    return { verdict: clean, usage };
  });
  h.start();
  await providerStarted;
  await h.restart();
  await h.blocked();
  const spentAfterRestart = h.spent();
  await h.retry();
  await waitFor(() => h.latest("inspect-again")?.state === "error", 10_000);
  report("interrupted before provider return", { maxRuns: 1, spentAfterRestart, providerCalls: h.providerCalls,
    providerReturns: h.providerReturns, spentAfterRetry: h.spent() });
  assert.equal(spentAfterRestart, 0, "an execution that returned nothing is the same execution asked again");
  assert.equal(h.providerCalls, 2);
  assert.match(JSON.stringify(h.latest()?.output), /"status":"passed"/);
  assert.equal(h.spent(), 1);
});

test("Local Inspector holds a concurrent reservation off before and after a returned review is rejected", { timeout: 30_000 }, async t => {
  let returned!: () => void, resume!: () => void;
  const providerRunning = new Promise<void>(resolve => { returned = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  const h = await harness(t, "concurrent", async launch => {
    returned();
    await held;
    await audit(launch);
    return { verdict: { findings: "not a list" }, usage };
  });
  // A second gate on the same Command, in the same submission, asking while the first runs.
  const rival = randomUUID();
  h.store.insertAttempt({ id: rival, submissionId: h.submissionId, nodeId: "inspect-again", attempt: 1,
    state: "running", persona: null, inputFingerprint: "rival", now: Date.now() });
  h.start();
  await providerRunning;
  const during = h.store.reserveCheckRun(h.runId, rival, "inspector", 1, null);
  resume();
  await h.blocked();
  const afterRejection = h.store.reserveCheckRun(h.runId, rival, "inspector", 1, null);
  // An explicit operator reset (a new budget epoch) is the only way to a second execution.
  const afterReset = h.store.reserveCheckRun(h.runId, rival, "inspector", 1, 2);
  report("concurrent reservation", { maxRuns: 1, during, afterRejection, afterReset, spent: h.spent() });
  assert.deepEqual(during, { granted: false, spent: 1 });
  assert.deepEqual(afterRejection, { granted: false, spent: 1 }, "rejecting a returned review does not hand its claim to a rival");
  assert.equal(afterReset.granted, true);
  assert.equal(h.store.releaseCheckRun(rival, "inspector"), true);
});

test("a repeated retry request is idempotent and spends nothing more", { timeout: 30_000 }, async t => {
  const h = await harness(t, "idempotent", async launch => { await audit(launch); return { verdict: { findings: 1 }, usage }; });
  h.start();
  await h.blocked();
  const requestId = randomUUID();
  const first = await h.retry(requestId);
  await h.retried();
  const again = h.store.manualInfrastructureRetry(h.runId, h.submissionId, h.latest()!, requestId, randomUUID(), Date.now());
  report("idempotent retry", { maxRuns: 1, firstIdempotent: first.idempotent, againIdempotent: again.idempotent,
    providerCalls: h.providerCalls, spent: h.spent() });
  assert.equal(first.idempotent, false);
  assert.equal(again.idempotent, true);
  assert.equal(h.providerCalls, 1);
  assert.equal(h.spent(), 1);
});
