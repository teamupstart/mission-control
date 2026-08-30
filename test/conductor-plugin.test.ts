/**
 * What is at stake: this plugin runs inside ai-conductor's process, unsupervised, on a
 * release train nobody here controls. Nothing in Mission Control's suite can start conductor
 * to find out how it behaves, and by the time anybody notices it misbehaving it will have
 * been misbehaving inside somebody's engine for a while.
 *
 * So it is exercised here, against a stub emitter shaped exactly like
 * `ConductorEventEmitter` - which is a small enough contract (`on`, `off`, per-type, no
 * wildcard) to reproduce honestly. What that proves is the half that is ours: the batching,
 * the addressing, and the failure posture. Provider-side tests own whether conductor starts
 * the plugin; this suite owns what the plugin does after that contract is invoked.
 *
 * The claims:
 *
 *  1. It never blocks the bus. Handlers are synchronous and do no I/O.
 *  2. It never throws into the bus, and never complains more than once about anything.
 *  3. It is bounded - a daemon that is not answering costs a fixed amount of memory.
 *  4. It sends the frozen envelope, and nothing else.
 *  5. It refuses to guess which run an event belongs to.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FORWARDED_EVENT_TYPES,
  createMissionControlVisualizer,
  engineerEnvelope,
  resolveRun,
} from "../integrations/ai-conductor/mission-control/index.mjs";

const REPO = "/w/demo";
const WORKTREE = "/w/demo/.worktrees/a-feature";

/**
 * The exhaustive event vocabulary synced into ai-conductor 0.104.0 at `1631544a`.
 *
 * Written out independently of the plugin's allowlist so deleting a subscription cannot
 * make the test agree with the deletion. Conductor's emitter has no wildcard and the union
 * is not published as a runtime value, so this pinned contract is the only local tripwire
 * for a supported kind disappearing from the live delivery path.
 */
const AI_CONDUCTOR_8685E121_EVENT_TYPES = [
  "acceptance_red",
  "attribution_divergence",
  "auto_heal",
  "auto_park",
  "auto_park_contradiction",
  "build_member_evidence_recomputed",
  "build_member_evidence_reused",
  "build_no_progress",
  "build_progress",
  "build_review_base",
  "build_review_cache_hit",
  "build_review_disposition_accepted",
  "build_review_disposition_refused",
  "build_review_disposition_version_invalidated",
  "build_review_mechanical_allowance_exhausted",
  "build_review_outer_verdict",
  "build_review_reduced_coverage_accepted",
  "build_review_repair_context",
  "build_review_rubric_infrastructure_failure",
  "build_review_rubric_prompt",
  "build_review_rubric_result",
  "build_review_rubric_skipped",
  "build_review_rubric_started",
  "build_review_stale_aggregate",
  "build_review_stale_mirage_regrade",
  "build_stall",
  "checkpoint_reached",
  "ci_failed",
  "config_deprecated_key",
  "config_skip",
  "contained_live_checkout_drift",
  "containment_check_unresolved",
  "credentials_park",
  "credentials_park_progress",
  "dashboard_refresh",
  "deprecated_step",
  "engineer_land_reconciled",
  "engineer_land_refused",
  "engineer_routing_selected",
  "engineer_run_cancelled",
  "engineer_run_created",
  "engineer_run_failed",
  "engineer_run_settled",
  "engineer_run_started",
  "engineer_spec_handoff",
  "engineer_step_completed",
  "engineer_step_failed",
  "engineer_step_retried",
  "engineer_step_skipped",
  "engineer_step_started",
  "engineer_worktree_created",
  "feature_complete",
  "feature_usage_total",
  "finish_publication_blocked",
  "finish_publication_disposition",
  "finish_publication_transition",
  "gate_blocked",
  "gate_verdict",
  "group_member_step",
  "halt_cleared",
  "halt_marker_write_failed",
  "halt_record_push_failed",
  "halt_record_write_failed",
  "halt_record_written",
  "kickback",
  "loop_converged",
  "loop_halt",
  "mode_skip",
  "navigation_back",
  "operator_park_boundary",
  "operator_rewind",
  "over_scope_decision",
  "parallel_completed",
  "parallel_failure",
  "parallel_started",
  "pipeline_closeout",
  "plan_growth",
  "protected_artifact_rebaseline",
  "protected_artifact_rebaseline_refused",
  "protected_artifact_reseal",
  "protected_artifact_reseal_refused",
  "provider_attempt",
  "provider_fallback",
  "provider_stream_progress",
  "rate_limit",
  "rebase_changed",
  "rebase_citation_residue",
  "rebase_conflict_halt",
  "rebase_gate_invalidated",
  "rebase_gate_preserved",
  "rebase_gate_reverified",
  "rebase_mergeable_skip",
  "rebase_noop",
  "rebase_resolution_attempt",
  "rebase_resolution_exhausted",
  "rebase_resolution_failed",
  "rebase_resolution_succeeded",
  "recovery_needed",
  "remediation_sealed_artifact_redirect",
  "renderer_error",
  "retry_decision",
  "scratch_cleanup_failed",
  "scratch_cleanup_reclaimed",
  "scratch_cleanup_retained",
  "self_host_containment_verdict",
  "session_policy",
  "session_reset",
  "step_completed",
  "step_failed",
  "step_refused",
  "step_retry",
  "step_started",
  "test_suite_verification",
  "tier_skip",
  "unattributed_dispatch",
  "unattributed_progress",
  "verdict_freshness",
  "when_skip",
  "zero_work_product",
] as const;

/**
 * A stand-in for `ConductorEventEmitter`.
 *
 * Per-type handler sets and no wildcard, which is the shape that forces the plugin to
 * enumerate what it forwards. `emit` awaits handler results exactly as conductor's does,
 * because that is what makes "handlers must be synchronous" a real constraint rather than a
 * style note - a handler that returned a promise here would show up as a stalled bus.
 */
function stubBus() {
  const handlers = new Map<string, Set<(event: Record<string, unknown>) => unknown>>();
  return {
    on(type: string, handler: (event: Record<string, unknown>) => unknown): void {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    },
    off(type: string, handler: (event: Record<string, unknown>) => unknown): void {
      handlers.get(type)?.delete(handler);
    },
    /** Returns what the handlers returned, so a test can assert none of them was async. */
    emit(event: Record<string, unknown>): unknown[] {
      return [...(handlers.get(String(event.type)) ?? [])].map((handler) => handler(event));
    },
    subscribed(): number {
      return [...handlers.values()].reduce((n, set) => n + set.size, 0);
    },
  };
}

/** A `fetch` that records what it was asked to send. */
function recordingFetch(reply: { ok: boolean; status: number } = { ok: true, status: 200 }) {
  const calls: Array<{ url: string; token: string; lines: Record<string, unknown>[] }> = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string };
    calls.push({
      url: String(url),
      token: request.headers["x-harness-token"] ?? "",
      lines: request.body
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    });
    return { ok: reply.ok, status: reply.status } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("it subscribes to the complete ai-conductor event union pinned at 8685e121", () => {
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({ worktree: WORKTREE, token: "t" });
  plugin.start(bus);
  assert.deepEqual(FORWARDED_EVENT_TYPES, AI_CONDUCTOR_8685E121_EVENT_TYPES);
  assert.equal(bus.subscribed(), FORWARDED_EVENT_TYPES.length);
  // The kinds conductor does NOT persist are the ones only this path can deliver, so their
  // absence from the list would make the plugin pointless for exactly the events it exists
  // for. Named individually rather than counted, so a regenerated list that quietly lost one
  // fails here.
  for (const unpersisted of [
    "build_review_disposition_accepted",
    "build_review_reduced_coverage_accepted",
    "build_review_disposition_refused",
    "gate_verdict",
    "halt_cleared",
    "pipeline_closeout",
  ] as const) {
    assert.ok(FORWARDED_EVENT_TYPES.includes(unpersisted), `${unpersisted} must be forwarded`);
  }
});

test("Engineer events use additive identity without inventing an implementation run", async () => {
  const event = {
    type: "engineer_run_created",
    schemaVersion: 1,
    engineerRunId: "run-1",
    correlationId: "commission-1",
    attemptKey: "launch-1",
    attempt: 1,
    previousEngineerRunId: null,
    repoRoot: REPO,
    revision: 1,
    ts: "2026-08-28T12:00:00.000Z",
    idea: "Add widgets",
  };
  assert.deepEqual(engineerEnvelope(event), {
    repo: REPO,
    seq: 1,
    event,
    engineerRunId: "run-1",
    correlationId: "commission-1",
    engineerAttempt: 1,
    attemptKey: "launch-1",
  });

  const { calls, fetchImpl } = recordingFetch();
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({ token: "t", fetchImpl });
  plugin.start(bus);
  assert.deepEqual(bus.emit(event), [undefined]);
  await plugin.stop();
  assert.deepEqual(calls[0]?.lines, [engineerEnvelope(event)]);
  assert.equal("slug" in (calls[0]?.lines[0] ?? {}), false);
  assert.equal("worktree" in (calls[0]?.lines[0] ?? {}), false);
});

test("handlers are synchronous, so the engine's bus never waits on this plugin", () => {
  // `ConductorEventEmitter.emit()` awaits whatever a handler returns. A handler that did its
  // own I/O would therefore put this plugin's network latency on the engine's critical path -
  // which is the one failure mode that would make installing it a bad trade.
  const { fetchImpl } = recordingFetch();
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({ worktree: WORKTREE, token: "t", fetchImpl });
  plugin.start(bus);
  const returned = bus.emit({ type: "step_started", step: "build" });
  assert.deepEqual(returned, [undefined], "a handler must return nothing, not a promise");
  assert.equal(plugin.stats().buffered, 1, "and must have buffered rather than sent");
});

test("a batch carries the frozen envelope, and the events in order", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "the-token",
    url: "http://127.0.0.1:7317/",
    fetchImpl,
  });
  plugin.start(bus);
  bus.emit({ type: "step_started", step: "build" });
  bus.emit({ type: "gate_verdict", step: "build", satisfied: false });
  await plugin.stop();

  assert.equal(calls.length, 1, "two events emitted together should cost one request");
  assert.equal(calls[0]?.url, "http://127.0.0.1:7317/ingest/conductor");
  assert.equal(calls[0]?.token, "the-token");
  assert.deepEqual(calls[0]?.lines, [
    {
      repo: REPO,
      worktree: WORKTREE,
      slug: "a-feature",
      seq: 1,
      event: { type: "step_started", step: "build" },
    },
    {
      repo: REPO,
      worktree: WORKTREE,
      slug: "a-feature",
      seq: 2,
      event: { type: "gate_verdict", step: "build", satisfied: false },
    },
  ]);
});

test("stop flushes what is pending, and unsubscribes", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({ worktree: WORKTREE, token: "t", fetchImpl });
  plugin.start(bus);
  bus.emit({ type: "feature_complete" });
  await plugin.stop();
  assert.equal(calls.length, 1, "a run's last events are owed to the ledger");
  assert.equal(plugin.stats().buffered, 0);
  // A visualizer that stayed subscribed after being stopped would keep a finished run's
  // events flowing into a buffer nothing flushes.
  assert.equal(bus.subscribed(), 0);
  bus.emit({ type: "step_started", step: "build" });
  assert.equal(plugin.stats().buffered, 0);
});

test("a daemon that is not there costs one warning and no exception", async () => {
  const warnings: string[] = [];
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  plugin.start(bus);
  for (let i = 0; i < 20; i += 1) bus.emit({ type: "step_started", step: `s${i}` });
  await plugin.stop();

  assert.equal(warnings.length, 1, "a broken transport must not fill conductor's output");
  assert.match(warnings[0] ?? "", /being retried/);
  assert.equal(plugin.stats().warnings, 1);
  // Kept, not discarded. Everything below is about why that distinction is the whole point.
  assert.equal(plugin.stats().buffered, 20);
});

test("a batch the daemon could not take is retried, not dropped", async () => {
  // The case the file tail cannot rescue. Conductor persists 76 of its 104 event kinds, so
  // for a gate verdict or a halt clear this plugin is the only Mission Control event record
  // that will ever exist - and a daemon restart is an ordinary event, not an exotic one.
  let down = true;
  const delivered: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    if (down) throw new Error("ECONNREFUSED");
    const request = init as { body: string };
    for (const raw of request.body.split("\n").filter((l) => l.trim() !== "")) {
      delivered.push(JSON.parse(raw) as Record<string, unknown>);
    }
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  bus.emit({ type: "gate_verdict", step: "build", verdict: "pass" });
  bus.emit({ type: "loop_halt", reason: "manual" });
  // Long enough for the scheduled flush to fire and fail against the closed daemon. Not
  // `stop()`, which would unsubscribe the bus and end the run this test is still in.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(delivered.length, 0, "nothing reached a daemon that was not there");
  assert.equal(plugin.stats().buffered, 2, "and nothing was thrown away either");

  // The daemon comes back. The events buffered through the outage arrive, in the order the
  // engine emitted them, ahead of the one that arrived after it recovered.
  down = false;
  bus.emit({ type: "halt_cleared" });
  await plugin.stop();
  assert.deepEqual(
    delivered.map((entry) => (entry.event as { type: string }).type),
    ["gate_verdict", "loop_halt", "halt_cleared"],
  );
  assert.equal(plugin.stats().buffered, 0);
});

test("a daemon that comes back inside the shutdown deadline still gets the events", async () => {
  // The shutdown budget is two seconds because a daemon that is restarting comes back inside
  // one. Giving up on the first refusal spent none of it - and this is the path where "the
  // file tail will backfill it" stops being true, because `stop()` returns into a conductor
  // that is exiting and nothing here writes to disk.
  let attempts = 0;
  const delivered: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    attempts += 1;
    // Down for the first two attempts, back for the third - a daemon being restarted, which
    // refuses instantly rather than hanging, so the drain is not waiting on a socket.
    if (attempts <= 2) throw new Error("ECONNREFUSED");
    const request = init as { body: string };
    for (const raw of request.body.split("\n").filter((l) => l.trim() !== "")) {
      delivered.push(JSON.parse(raw) as Record<string, unknown>);
    }
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  bus.emit({ type: "gate_verdict", step: "build", verdict: "pass" });
  await plugin.stop();

  assert.ok(attempts >= 3, `the drain must keep trying inside its deadline, made ${attempts}`);
  assert.equal(delivered.length, 1, "the event reached the daemon that came back");
  assert.equal(plugin.stats().buffered, 0, "and nothing is left to be lost with the process");
});

test("a batch refused as too large is split, not discarded", async () => {
  // 413 says the BATCH is too big, not that the events are unwanted. Discarding it would
  // lose the unpersisted kinds outright, and resending the same bytes would park an
  // undeliverable request at the head of the queue. So the send size halves until it fits,
  // and every event still arrives.
  const delivered: Record<string, unknown>[] = [];
  const sizes: number[] = [];
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    const request = init as { body: string };
    const lines = request.body.split("\n").filter((l) => l.trim() !== "");
    sizes.push(lines.length);
    // A daemon that will not take more than 4 events at a time.
    if (lines.length > 4) return { ok: false, status: 413 } as Response;
    for (const raw of lines) delivered.push(JSON.parse(raw) as Record<string, unknown>);
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  for (let i = 0; i < 16; i += 1) bus.emit({ type: "gate_verdict", step: `s${i}` });
  await plugin.stop();

  assert.equal(plugin.stats().dropped, 0, "nothing was thrown away to make the batch fit");
  assert.equal(delivered.length, 16, "every event arrived");
  assert.deepEqual(
    delivered.map((entry) => (entry.event as { step: string }).step),
    Array.from({ length: 16 }, (_, i) => `s${i}`),
    "and in the order the engine emitted them",
  );
  assert.ok(sizes.some((n) => n > 4), "it really did have to be refused first");
  assert.ok(sizes.length < 20, `converged rather than retried blindly (${sizes.length} attempts)`);
});

test("one event too large for any batch is dropped rather than retried for ever", async () => {
  // The floor of the split: a single event over the daemon's own 4 MB ceiling fits in no
  // batch at all, so retrying it would block every event behind it permanently. This is the
  // only case where an event is genuinely undeliverable, and it is counted.
  const { calls, fetchImpl } = recordingFetch({ ok: false, status: 413 });
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  bus.emit({ type: "step_started", step: "build" });
  await plugin.stop();
  assert.equal(plugin.stats().buffered, 0, "not parked at the head of the queue");
  assert.equal(plugin.stats().dropped, 1, "counted rather than silently gone");
  assert.ok(calls.length <= 2, `bounded attempts, got ${calls.length}`);
});

test("a failed batch survives the buffer filling up behind it", async () => {
  // The eviction that would defeat the whole retry: a POST is open, events keep arriving and
  // fill the buffer to its ceiling, then the request fails. Trimming the oldest - which is
  // what enqueue does, correctly - would discard the batch just put back, so a delivery
  // failure would destroy exactly the events it was carrying.
  // An object holder rather than a bare `let`: TypeScript narrows a variable assigned only
  // inside a callback to `never` at the call site, since it cannot see that the callback ran.
  const gate: { release?: () => void } = {};
  let attempts = 0;
  const seen: string[] = [];
  const fetchImpl = (async (_url: unknown, init: unknown) => {
    attempts += 1;
    const request = init as { body: string };
    const lines = request.body.split("\n").filter((l) => l.trim() !== "");
    if (attempts === 1) {
      // Hold the first request open so the buffer fills behind it, then fail it.
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      throw new Error("ECONNREFUSED");
    }
    for (const raw of lines) {
      seen.push((JSON.parse(raw) as { event: { step: string } }).event.step);
    }
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  // One event, sent on the first flush and held open by the transport above.
  bus.emit({ type: "gate_verdict", step: "held-0" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  // Now bury it: fill the buffer to its ceiling while that request is still open.
  for (let i = 0; i < 5200; i += 1) bus.emit({ type: "step_started", step: `late-${i}` });
  gate.release?.();
  await plugin.stop();

  assert.ok(
    seen.includes("held-0"),
    "the batch that failed was evicted by the events queued behind it",
  );
});

test("shutdown is bounded when the daemon accepts a connection and never answers", async () => {
  // `stop()` is awaited by conductor's shutdown path, so an unbounded await here is this
  // plugin holding the ENGINE open. A hung daemon is the case that produces it: the socket
  // is accepted, so nothing errors and nothing times out on its own.
  let attempts = 0;
  const fetchImpl = ((_url: unknown, init: unknown) => {
    attempts += 1;
    const signal = (init as { signal?: AbortSignal }).signal;
    return new Promise<Response>((_resolve, reject) => {
      // Never answers. Only an abort ends it, which is what the deadline must produce.
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as unknown as typeof fetch;

  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  bus.emit({ type: "gate_verdict", step: "build" });
  await new Promise((resolve) => setTimeout(resolve, 400));

  const started = Date.now();
  await plugin.stop();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `stop() must not wait for ever (waited ${elapsed}ms)`);
  // And the undelivered event is kept rather than sacrificed to meet the deadline: the abort
  // rejects into the same catch a refused connection uses, which requeues.
  assert.equal(plugin.stats().buffered, 1);
  assert.equal(plugin.stats().dropped, 0);

  // Kept, and not retried. This is the plugin's documented loss boundary, asserted here so it
  // stays a boundary a reader can trust rather than a claim in a README: `stop()` returning
  // is the end of delivery, the buffer is memory in a process that is exiting, and nothing
  // here writes it down. Waited past two flush intervals, so a retry that WAS scheduled would
  // have fired.
  const attemptsAtStop = attempts;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(attempts, attemptsAtStop, "stop() returning is the end of delivery");
  assert.equal(plugin.stats().buffered, 1, "the batch is in memory, not on a schedule");
});

test("retrying cannot grow the buffer past its ceiling", async () => {
  // Requeue puts a failed batch BACK, so the ceiling has to be re-applied there too or a
  // daemon that stays down turns a bounded buffer into an unbounded one.
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: () => {},
  });
  plugin.start(bus);
  for (let i = 0; i < 6000; i += 1) bus.emit({ type: "step_started", step: `s${i}` });
  await plugin.stop();
  assert.ok(plugin.stats().buffered <= 5000, `bounded, got ${plugin.stats().buffered}`);
  assert.ok(plugin.stats().dropped >= 1000);
});

test("a refused token says which of the two fixable things is wrong", async () => {
  const warnings: string[] = [];
  const { fetchImpl } = recordingFetch({ ok: false, status: 401 });
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "wrong",
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  plugin.start(bus);
  bus.emit({ type: "step_started", step: "build" });
  await plugin.stop();
  // The only diagnosis an operator gets, from a plugin whose posture is otherwise silence.
  assert.match(warnings[0] ?? "", /MISSION_CONTROL_TOKEN/);
  assert.match(warnings[0] ?? "", /token is readable by the user conductor runs as/);
});

test("a rotated daemon token is picked up by the attempt after the 401", async () => {
  // The token is DISCOVERED from disk, and conductor's process outlives Mission Control's:
  // a daemon coming up on a fresh state directory mints a new secret, and nothing tells this
  // plugin. Holding the first one it ever read would make the retry loop an infinite retry
  // of a request that cannot succeed, and the buffer ceiling would then drop the events -
  // including the kinds conductor never writes to a file, which nothing else records.
  const home = mkdtempSync(join(tmpdir(), "mission-plugin-home-"));
  mkdirSync(join(home, ".mission-control"), { recursive: true });
  writeFileSync(join(home, ".mission-control", "token"), "the-old-secret\n");
  const realHome = process.env.HOME;
  // `os.homedir()` reads HOME on POSIX, which is the only seam the plugin's own discovery
  // offers - and using it means this test drives the real `readToken`, file and all.
  process.env.HOME = home;
  try {
    const sent: string[] = [];
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const token = (init as { headers: Record<string, string> }).headers["x-harness-token"];
      sent.push(token ?? "");
      // The daemon refuses the secret it no longer knows, then accepts the one it minted.
      return token === "the-new-secret"
        ? ({ ok: true, status: 200 } as Response)
        : ({ ok: false, status: 401 } as Response);
    }) as unknown as typeof fetch;

    const bus = stubBus();
    const plugin = createMissionControlVisualizer({ worktree: WORKTREE, fetchImpl, warn: () => {} });
    plugin.start(bus);
    bus.emit({ type: "gate_verdict", step: "build" });

    // Rotated between the first attempt and its retry, which is the sequence an operator
    // restarting the daemon actually produces.
    const until = async (predicate: () => boolean, why: string): Promise<void> => {
      for (let waited = 0; waited < 5000; waited += 25) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail(why);
    };
    await until(() => sent.length >= 1, "the plugin never made a first attempt");
    writeFileSync(join(home, ".mission-control", "token"), "the-new-secret\n");
    await until(() => sent.length >= 2, "the plugin never retried after the 401");

    assert.deepEqual(
      sent.slice(0, 2),
      ["the-old-secret", "the-new-secret"],
      "the retry must read the token again rather than resend the one that was refused",
    );
    await plugin.stop();
    assert.equal(plugin.stats().buffered, 0, "and the events it was holding are delivered");
    assert.equal(plugin.stats().dropped, 0);
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the buffer is bounded, and it drops the oldest", async () => {
  const warnings: string[] = [];
  // A transport that never settles, which is what a hung daemon looks like from here - and
  // is the case where an unbounded buffer would grow for as long as conductor runs.
  const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    worktree: WORKTREE,
    token: "t",
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  plugin.start(bus);
  for (let i = 0; i < 6000; i += 1) bus.emit({ type: "step_started", step: `s${i}` });
  const stats = plugin.stats();
  assert.ok(stats.buffered <= 5000, `buffered ${stats.buffered} events with a 5000 ceiling`);
  assert.ok(stats.dropped > 0, "and it must say that it dropped some");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /is the Mission Control daemon running/);
});

test("it forwards nothing rather than guessing which repository an event belongs to", async () => {
  const warnings: string[] = [];
  const { calls, fetchImpl } = recordingFetch();
  const bus = stubBus();
  // No pin, a working directory that is not inside a worktree, no MISSION_CONTROL_REPO, and
  // an event that names no feature. This is the daemon entrypoint's shape, and the honest
  // answer is silence: Mission Control drops events for repositories nobody consented to, so
  // a guess would produce a plugin that looks installed and delivers nothing.
  const plugin = createMissionControlVisualizer({
    env: {},
    cwd: "/somewhere/else",
    token: "t",
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  plugin.start(bus);
  bus.emit({ type: "step_started", step: "build" });
  await plugin.stop();
  assert.equal(calls.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /could not tell which conductor worktree/);
  // And it says what this actually costs, in both halves. An operator who reads "nothing is
  // lost" stops looking - which is right for the 44 kinds conductor writes down and wrong for
  // the 30 it does not, where this plugin is the only record there would have been.
  assert.match(warnings[0] ?? "", /delayed rather than lost/);
  assert.match(warnings[0] ?? "", /not observed at all/);
});

test("a spent warning budget silences its own kind, and only its own kind", async () => {
  // The failure a single shared counter produces, written down: the FIRST thing that goes
  // wrong spends the plugin's whole voice, and everything after it is silent - including the
  // things an operator has to act on. A misconfigured working directory at startup is the
  // cheapest possible way to hit that, and a refused transport is the news it would eat.
  const warnings: string[] = [];
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const bus = stubBus();
  const plugin = createMissionControlVisualizer({
    env: { MISSION_CONTROL_REPO: REPO },
    cwd: "/elsewhere",
    token: "t",
    fetchImpl,
    warn: (message) => warnings.push(message),
  });
  plugin.start(bus);
  // Two unaddressable events, which is one KIND. Its own budget still holds.
  bus.emit({ type: "step_started", step: "build" });
  bus.emit({ type: "step_started", step: "test" });
  assert.equal(warnings.length, 1, "one line per kind, not one per event");

  // And now an event that resolves, on a plugin whose budget a triviality already spent.
  bus.emit({ type: "step_started", step: "build", slug: "a-feature" });
  await plugin.stop();
  assert.equal(warnings.length, 2, "a different kind of failure is still owed its one line");
  assert.match(warnings[0] ?? "", /could not tell which conductor worktree/);
  assert.match(warnings[1] ?? "", /being retried/);
  // Six kinds, one line each, is the ceiling for the life of the process - so `warnings` is
  // still a bounded total rather than a per-kind map a caller would have to sum itself.
  assert.equal(plugin.stats().warnings, 2);
});

test("identity resolves from the pin, the working directory, then the event", () => {
  const run = { repo: REPO, worktree: WORKTREE, slug: "a-feature" };
  // 1. The pin wins, and is what a per-feature wiring should set.
  assert.deepEqual(
    resolveRun({ MISSION_CONTROL_WORKTREE: WORKTREE }, "/elsewhere", null),
    run,
  );
  // 2. The working directory, at the worktree and anywhere beneath it - conductor's agents
  //    run from subdirectories of the worktree routinely.
  assert.deepEqual(resolveRun({}, WORKTREE, null), run);
  assert.deepEqual(resolveRun({}, `${WORKTREE}/src/deep/inside`, null), run);
  // 3. A named repository plus a slug the event carries. Three spellings, all conductor's.
  assert.deepEqual(
    resolveRun({ MISSION_CONTROL_REPO: REPO }, "/elsewhere", { slug: "a-feature" }),
    run,
  );
  assert.deepEqual(
    resolveRun({ MISSION_CONTROL_REPO: REPO }, "/elsewhere", { featureSlug: "a-feature" }),
    run,
  );
  assert.deepEqual(
    resolveRun({ MISSION_CONTROL_REPO: REPO }, "/elsewhere", { feature: "a-feature" }),
    run,
  );
  // And nothing at all, which must be null rather than a half-built address.
  assert.equal(resolveRun({}, "/elsewhere", { type: "step_started" }), null);
  assert.equal(resolveRun({ MISSION_CONTROL_REPO: REPO }, "/elsewhere", null), null);
  // A directory that merely LOOKS like one - `.worktrees` has to be the parent, not an
  // ancestor, or an unrelated checkout under a worktree would be addressed as one.
  assert.equal(resolveRun({}, "/w/demo/not-worktrees/a-feature", null), null);
});
