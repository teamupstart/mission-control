// The shaping engine: stage order, parallel calls, the gather-to-select hand-off, the summary cut,
// per-call timeouts and the step deadline, partial results, and every outcome. Transports are
// injected stand-ins, so nothing here starts a process or opens a socket.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonicalJson,
  ShaperSchema,
  ShapingConfigSchema,
  SHAPING_SECTION_PREAMBLE,
  utf8Length,
  type Shaper,
  type ShapingConfig,
  type ShapingRequest,
} from "../src/shared/shaping.ts";
import { dryRunShaper, runScope, shapeTask, type ShapeTaskInput } from "../src/server/shaping/engine.ts";
import { SHAPING_TRANSPORT_CALLS, type ShapingTransportCalls, type TransportContext, type TransportReply } from "../src/server/shaping/transports/index.ts";

type Handler = (request: ShapingRequest, shaper: Shaper, ctx: TransportContext) => Promise<TransportReply> | TransportReply;

const input = (repositories = 2, extra: Partial<ShapeTaskInput> = {}): ShapeTaskInput => ({
  task: "Retry failed charges",
  context: {
    taskId: "t_123", title: "Retry failed charges", kind: "ship", harness: "claude", runtime: "sdk",
    afterWork: { workflowId: "wf_1", name: "Review and merge" }, labels: ["payments"], priority: "high",
    repositories: [
      { name: "billing-api", role: "primary", branch: "task/retry", baseSha: "abc123", path: "/work/billing-api" },
      { name: "ledger", role: "additional", branch: "task/retry", baseSha: "def456", path: "/work/ledger" },
    ].slice(0, repositories) as ShapeTaskInput["context"]["repositories"],
  },
  ...extra,
});
const shaper = (id: string, stage: "gather" | "select", extra: Record<string, unknown> = {}) => ShaperSchema.parse({
  id, label: id.toUpperCase(), stage, transport: { type: "command", command: "/usr/bin/true" }, ...extra,
});
const remote = (id: string) => ShaperSchema.parse({
  id, label: id, stage: "select", transport: { type: "http", url: "https://example.test/shape" },
});
function configWith(shapers: Shaper[], patch: Record<string, unknown> = {}): ShapingConfig {
  return ShapingConfigSchema.parse({
    shapers, overrides: Object.fromEntries(shapers.map((entry) => [entry.id, true])), ...patch,
  });
}
/** Every transport answers through `handler`, whatever the shaper's transport id. */
function transports(handler: Handler): ShapingTransportCalls {
  const call = async (request: ShapingRequest, entry: Shaper, ctx: TransportContext) => handler(request, entry, ctx);
  return { command: call, mcp: call, http: call, builtin: call };
}
const data = (value: unknown): TransportReply => ({ kind: "data", data: typeof value === "string" ? value : JSON.stringify(value) });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const run = (config: ShapingConfig, handler: Handler, taskInput = input()) =>
  shapeTask(taskInput, { config, discovered: [], transports: transports(handler), enabled: true });

test("with the flag off nothing is resolved or called", async () => {
  let calls = 0;
  const result = await shapeTask(input(), {
    config: configWith([shaper("g", "gather")]), discovered: [], enabled: false,
    transports: transports(() => { calls++; return data({}); }),
  });
  assert.deepEqual(result, { summary: null, section: "", entries: [] });
  assert.equal(calls, 0);
});

test("with no shaper that applies the run is empty and nothing is called", async () => {
  let calls = 0;
  const off = ShapingConfigSchema.parse({ shapers: [shaper("g", "gather")] });
  assert.deepEqual(await run(off, () => { calls++; return data({}); }), { summary: null, section: "", entries: [] });
  assert.equal(calls, 0);
});

test("gather settles before select starts, and selectors receive merged facts and the last summary", async () => {
  const events: string[] = [];
  const seen: ShapingRequest[] = [];
  const config = configWith([shaper("g1", "gather"), shaper("g2", "gather"), shaper("s1", "select")]);
  const result = await run(config, async (request, entry) => {
    events.push(`start ${entry.id} ${request.repo.name}`);
    seen.push(request);
    await sleep(entry.id === "g1" ? 60 : 10);
    events.push(`end ${entry.id} ${request.repo.name}`);
    if (entry.id === "g1") return data({ repo: { facts: { language: "python", framework: ["django"] }, summary: `g1 on ${request.repo.name}` } });
    if (entry.id === "g2") return data({ repo: { facts: { language: "typescript" } } });
    return data({ guidance: [{ id: `s1/${request.repo.name}`, body: `guidance for ${request.repo.name}` }] });
  });
  const lastGatherEnd = Math.max(...events.map((event, at) => (event.startsWith("end g") ? at : -1)));
  const firstSelectStart = events.findIndex((event) => event.startsWith("start s1"));
  assert.ok(firstSelectStart > lastGatherEnd, events.join("\n"));
  const gather = seen.filter((request) => request.stage === "gather");
  assert.ok(gather.every((request) => request.repo.facts === undefined && request.repo.summary === undefined),
    "a gather request carries no facts or summary");
  const select = seen.filter((request) => request.stage === "select");
  assert.deepEqual(select.map((request) => [request.repo.name, request.repo.facts, request.repo.summary]), [
    ["billing-api", { language: "typescript", framework: ["django"] }, "g1 on billing-api"],
    ["ledger", { language: "typescript", framework: ["django"] }, "g1 on ledger"],
  ]);
  assert.equal(seen.length, 6, "one call per shaper per repository");
  assert.equal(result.summary?.state, "ok");
  assert.deepEqual(result.entries.map((entry) => entry.id), ["s1/billing-api", "s1/ledger"]);
});

test("calls in a stage run in parallel", async () => {
  const config = configWith([shaper("a", "select"), shaper("b", "select"), shaper("c", "select")]);
  const started = Date.now();
  const result = await run(config, async () => { await sleep(150); return data({}); });
  assert.ok(Date.now() - started < 400, "six calls of 150 ms did not run one after another");
  assert.deepEqual(result.summary?.shapers.map((entry) => entry.outcome), ["ok", "ok", "ok"]);
});

test("a summary is cut to 4 KiB at a line boundary before a selector sees it", async () => {
  const summary = Array.from({ length: 100 }, (_, i) => `line ${i} `.padEnd(60, "x")).join("\n");
  let received = "";
  await run(configWith([shaper("g", "gather"), shaper("s", "select")]), (request) => {
    if (request.stage === "gather") return data({ repo: { summary } });
    received = request.repo.summary ?? "";
    return data({});
  }, input(1));
  assert.ok(utf8Length(received) <= 4096 && received.length > 3000);
  assert.ok(summary.startsWith(received) && summary[received.length] === "\n", "cut exactly at a line boundary");
});

test("the request carries the complete collected input; local paths only to local shapers", async () => {
  const seen = new Map<string, ShapingRequest>();
  await run(configWith([shaper("local", "select", { version: "v1.4.0" }), remote("remote")], { caller: { user: "declared-user" } }),
    (request, entry) => { seen.set(`${entry.id} ${request.repo.name}`, request); return data({}); });
  const local = seen.get("local billing-api")!;
  assert.deepEqual(local, {
    protocol: 1, stage: "select", task: "Retry failed charges",
    repo: { name: "billing-api", path: "/work/billing-api" },
    version: "v1.4.0",
    context: {
      taskId: "t_123", title: "Retry failed charges", kind: "ship", harness: "claude", runtime: "sdk",
      afterWork: { workflowId: "wf_1", name: "Review and merge" }, labels: ["payments"], priority: "high",
      repositories: [
        { name: "billing-api", role: "primary", branch: "task/retry", baseSha: "abc123", path: "/work/billing-api" },
        { name: "ledger", role: "additional", branch: "task/retry", baseSha: "def456", path: "/work/ledger" },
      ],
      caller: { user: "declared-user", agent: "claude", conversation: "t_123" },
    },
    limits: { maxBytes: 16384, deadlineMs: local.limits.deadlineMs },
  });
  const far = seen.get("remote ledger")!;
  assert.equal(far.repo.path, undefined, "a remote shaper never gets a local path");
  assert.ok(far.context.repositories.every((repo) => repo.path === undefined));
  assert.equal(JSON.stringify(far).includes("/work/"), false);
});

test("each call's timeout is the smaller of the shaper's and the time left in the step", async () => {
  const budgets: number[] = [];
  const config = configWith([shaper("quick", "select", { timeoutMs: 300 }), shaper("patient", "select", { timeoutMs: 30_000 })],
    { limits: { deadlineMs: 2_000 } });
  await run(config, (_request, _entry, ctx) => { budgets.push(ctx.timeoutMs); assert.ok(ctx.deadline > Date.now()); return data({}); }, input(1));
  assert.equal(budgets[0], 300);
  assert.ok(budgets[1]! <= 2_000 && budgets[1]! > 1_500, String(budgets[1]));
});

test("a slow call is abandoned at its timeout, and the others' entries are kept", async () => {
  const config = configWith([shaper("slow", "select", { timeoutMs: 200 }), shaper("fast", "select")]);
  let aborted = false;
  const started = Date.now();
  const result = await run(config, async (request, entry, ctx) => {
    if (entry.id === "fast") return data({ guidance: [{ id: "kept", body: "kept entry" }] });
    ctx.signal.addEventListener("abort", () => { aborted = true; });
    await sleep(5_000); // ignores its signal on purpose
    return data({});
  }, input(1));
  assert.ok(Date.now() - started < 1_000);
  assert.equal(aborted, true, "the transport is told to stop");
  assert.deepEqual(result.summary?.shapers.map((entry) => [entry.id, entry.outcome]), [["slow", "timed_out"], ["fast", "ok"]]);
  assert.equal(result.summary?.state, "degraded");
  assert.deepEqual(result.entries.map((entry) => entry.id), ["kept"]);
});

test("the step deadline bounds both stages; a selector with no time left is timed_out uncalled", async () => {
  const config = configWith([shaper("g", "gather", { timeoutMs: 30_000 }), shaper("s", "select")], { limits: { deadlineMs: 300 } });
  const called: string[] = [];
  const started = Date.now();
  const result = await run(config, async (_request, entry, ctx) => {
    called.push(entry.id);
    await new Promise((done) => ctx.signal.addEventListener("abort", done, { once: true }));
    return { kind: "timed_out", reason: "stopped" };
  }, input(1));
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(called, ["g"]);
  assert.deepEqual(result.summary?.shapers.map((entry) => [entry.id, entry.outcome]), [["g", "timed_out"], ["s", "timed_out"]]);
  assert.match(result.summary!.shapers[1]!.reason!, /ran out of time/);
});

test("every outcome: ok, degraded, failed, timed_out, invalid and unavailable", async () => {
  const replies: Record<string, Handler> = {
    ok: () => data({ version: "v2", guidance: [{ id: "a", title: "A", body: "alpha" }] }),
    degraded: () => data({ degraded: true, notes: ["The model is unavailable."], guidance: [{ id: "b", body: "fallback" }] }),
    failed: () => ({ kind: "failed", reason: "exit 3" }),
    "error-reply": () => data({ error: { code: "denied", message: "not allowed" } }),
    thrown: () => { throw new Error("transport bug"); },
    "timed-out": () => ({ kind: "timed_out", reason: "Timed out after 5 s." }),
    "not-json": () => ({ kind: "data", data: "<html>" }),
    "bad-shape": () => data({ guidance: [{ id: "x" }] }),
    unavailable: () => ({ kind: "unavailable", reason: "no worktree" }),
  };
  const ids = Object.keys(replies);
  const result = await run(configWith(ids.map((id) => shaper(id, "select"))), (request, entry) => replies[entry.id]!(request, entry, {} as TransportContext), input(1));
  const outcomes = Object.fromEntries(result.summary!.shapers.map((entry) => [entry.id, [entry.outcome, entry.reason]]));
  assert.deepEqual(outcomes, {
    ok: ["ok", null],
    degraded: ["degraded", "The model is unavailable."],
    failed: ["failed", "exit 3"],
    "error-reply": ["failed", "denied: not allowed"],
    thrown: ["failed", "The command transport failed: transport bug"],
    "timed-out": ["timed_out", "Timed out after 5 s."],
    "not-json": ["invalid", "The reply is not JSON."],
    "bad-shape": ["invalid", "The reply does not match the shaping result: guidance.0.body: Invalid input: expected string, received undefined"],
    unavailable: ["unavailable", "no worktree"],
  });
  assert.equal(result.summary!.shapers.find((entry) => entry.id === "ok")!.version, "v2");
  assert.deepEqual(result.entries.map((entry) => entry.id), ["a", "b"], "a degraded shaper still contributes");
  assert.equal(result.summary!.state, "degraded");
});

test("the placeholder transports answer unavailable, naming the transport", async () => {
  const mcp = ShaperSchema.parse({ id: "mcp", label: "MCP", stage: "select", transport: { type: "mcp", tool: "get_guidance", server: { type: "http", url: "https://x.test/mcp" } } });
  const http = remote("http");
  const builtin = ShaperSchema.parse({ id: "files", label: "Files", stage: "gather", transport: { type: "builtin", builtin: "repository-files" } });
  const result = await shapeTask(input(1), { config: configWith([builtin, mcp, http]), discovered: [], enabled: true, transports: SHAPING_TRANSPORT_CALLS });
  assert.deepEqual(result.summary!.shapers.map((entry) => [entry.id, entry.outcome, entry.reason]), [
    ["files", "unavailable", "The built-in transport is not available in this build yet."],
    ["mcp", "unavailable", "The MCP transport is not available in this build yet."],
    ["http", "unavailable", "The HTTP transport is not available in this build yet."],
  ]);
});

test("entries are de-duplicated, budgeted and composed into one section", async () => {
  const long = Array.from({ length: 400 }, (_, i) => `rule ${i}`.padEnd(99, ".")).join("\n");
  const config = configWith([shaper("a", "select"), shaper("b", "select", { maxBytes: 2048 })], { limits: { totalBytes: 20_000 } });
  const result = await run(config, (request, entry) => data({ guidance: entry.id === "a"
    ? [{ id: "same", title: "Same", body: "shared body" }, { id: `own/${request.repo.name}`, body: long }]
    : [{ id: "dup", body: "shared body" }, { id: "b-own", body: "b body" }] }));
  assert.deepEqual(result.entries.map((entry) => [entry.shaperId, entry.id, entry.repo]), [
    ["a", "same", "billing-api"], ["a", "own/billing-api", "billing-api"], ["b", "b-own", "billing-api"],
  ], "same id from one shaper once, an identical body from two shapers once, and the second repo's long entry did not fit a's share");
  assert.equal(result.entries[1]!.truncated, true);
  assert.ok(result.section.startsWith(SHAPING_SECTION_PREAMBLE));
  assert.match(result.section, /### A: Same \(billing-api\)\nshared body/);
  assert.ok(utf8Length(result.section) <= 20_000);
  assert.equal(result.summary!.bytes, utf8Length(result.section));
  assert.equal(result.summary!.truncated, true);
  assert.equal(result.summary!.state, "ok", "truncation is not degradation");
});

test("a reply that says it was truncated marks its shaper truncated, though no entry says so", async () => {
  const result = await run(configWith([shaper("cut", "select"), shaper("whole", "select")]), (_request, entry) => data(entry.id === "cut"
    ? { truncated: true, guidance: [{ id: "partial", body: "the first part" }] }
    : { truncated: false, guidance: [{ id: "full", body: "everything" }] }), input(1));
  assert.deepEqual(result.summary!.shapers.map((entry) => [entry.id, entry.outcome, entry.truncated]), [["cut", "ok", true], ["whole", "ok", false]]);
  assert.equal(result.summary!.truncated, true, "the run says its context is incomplete");
  assert.equal(result.summary!.state, "ok", "truncation is still not degradation");
  // A shaper that says it was cut, and returned nothing at all, still says so.
  const empty = await run(configWith([shaper("cut", "select")]), () => data({ truncated: true }), input(1));
  assert.equal(empty.summary!.truncated, true);
});

test("the summary records origin and the SHA-256 of the canonical definition", async () => {
  const entry = shaper("g", "gather");
  const result = await run(configWith([entry]), () => data({}), input(1));
  const stored = configWith([entry]).shapers[0]!;
  const reordered = Object.fromEntries(Object.entries(stored).reverse());
  assert.equal(canonicalJson(reordered), canonicalJson(stored));
  assert.equal(result.summary!.shapers[0]!.origin, "registered");
  assert.equal(result.summary!.shapers[0]!.sha256, createHash("sha256").update(canonicalJson(stored)).digest("hex"));
});

test("a reply that arrives after its call's timeout contributes nothing, though step time is left", async () => {
  // Ordering, not wall-clock bounds: a stalled runner can deliver both timers late, but the
  // 100 ms abort is still due before the 125 ms reply.
  const events: string[] = [];
  const result = await run(configWith([shaper("late", "select", { timeoutMs: 100 })], { limits: { deadlineMs: 5_000 } }), async (_r, _e, ctx) => {
    ctx.signal.addEventListener("abort", () => { events.push("aborted"); }, { once: true });
    await sleep(125);
    events.push("replied");
    return data({ guidance: [{ id: "late", body: "should not be injected" }] });
  }, input(1));
  assert.deepEqual([result.summary!.shapers[0]!.outcome, result.summary!.shapers[0]!.reason], ["timed_out", "Timed out after 0.1 s."]);
  assert.deepEqual(result.entries, [], "no guidance from a late reply");
  assert.equal(result.section, "");
  await sleep(50);
  assert.deepEqual(events.slice(0, 2), ["aborted", "replied"], "the call's signal is aborted at its own deadline, before the late reply");
});

test("every empty run is a fresh value, so a caller cannot change the next one", async () => {
  const first = await shapeTask(input(1), { config: configWith([]), discovered: [], enabled: false });
  first.entries.push({ shaperId: "x", label: "X", stage: "select", repo: "r", id: "leaked", title: null, path: null, body: "leaked", truncated: false, omittedBytes: 0 });
  const second = await shapeTask(input(1), { config: configWith([]), discovered: [], enabled: false });
  assert.deepEqual(second, { summary: null, section: "", entries: [] });
  assert.notEqual(second.entries, first.entries);
});

test("a failure reported after the call's deadline is a timeout; the transport's own timeout reason is kept", async () => {
  const config = configWith([shaper("late-failure", "select", { timeoutMs: 100 }), shaper("late-timeout", "select", { timeoutMs: 100 })],
    { limits: { deadlineMs: 5_000 } });
  const result = await run(config, async (_r, entry) => {
    // A busy event loop modelled directly: the reply settles inside the grace, after the deadline.
    await sleep(125);
    return entry.id === "late-failure"
      ? { kind: "failed", reason: "exit 1" }
      : { kind: "timed_out", reason: "The guidance service did not answer in time." };
  }, input(1));
  assert.deepEqual(result.summary!.shapers.map((entry) => [entry.id, entry.outcome, entry.reason]), [
    ["late-failure", "timed_out", "Timed out after 0.1 s."],
    ["late-timeout", "timed_out", "The guidance service did not answer in time."],
  ]);
});

test("a validation diagnostic is redacted whole before it is cut, so no fragment of a value survives", async () => {
  const secret = "SECRET-VALUE-0123456789-abcdef";
  // The diagnostic's path carries this shaper-chosen key, and the value sits across the
  // 500-character cut: 56 characters of prefix, then 430 of key, then the secret.
  const key = `${"k".repeat(430)}${secret}`;
  const result = await run(configWith([shaper("leaky", "select")]), () => ({
    kind: "data", data: JSON.stringify({ repo: { facts: { [key]: "v" } } }),
    redact: (text: string) => text.split(secret).join("[redacted]"),
  }), input(1));
  const reason = result.summary!.shapers[0]!.reason!;
  assert.equal(result.summary!.shapers[0]!.outcome, "invalid");
  assert.ok(reason.length <= 500);
  for (let size = 6; size <= secret.length; size++) {
    assert.equal(reason.includes(secret.slice(0, size)), false, `no ${size}-character prefix of the value`);
  }
});

test("an entry reported truncated still marks its shaper truncated when de-duplication drops it", async () => {
  const result = await run(configWith([shaper("dup", "select")]), (request) => data({
    guidance: [{ id: "shared", body: `body for ${request.repo.name}`, truncated: request.repo.name === "ledger" }],
  }));
  assert.deepEqual(result.entries.map((entry) => [entry.repo, entry.truncated]), [["billing-api", false]],
    "the later repository's copy is the one de-duplicated");
  assert.equal(result.summary!.shapers[0]!.truncated, true, "its reported truncation still reaches the summary");
  assert.equal(result.summary!.truncated, true);
});

test("cleanup a transport registers after its call was abandoned still runs", async () => {
  let released = 0;
  let registered = false;
  const result = await run(configWith([shaper("late", "select", { timeoutMs: 100 })], { limits: { deadlineMs: 2_000 } }), async (_r, _e, ctx) => {
    // Ignores its signal and finishes acquiring its resource only after the engine gave up.
    await sleep(400);
    ctx.scope.defer(() => { released++; });
    registered = true;
    return data({});
  }, input(1));
  assert.equal(result.summary!.shapers[0]!.outcome, "timed_out", "the run did not wait for it");
  for (let waited = 0; (!registered || released === 0) && waited < 3_000; waited += 25) await sleep(25);
  assert.equal(registered, true);
  assert.equal(released, 1, "a cleanup registered after the scope closed runs at once, exactly once");
});

test("runScope runs pending cleanups on close and later ones immediately, and logs failures", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const scope = runScope();
  const order: string[] = [];
  scope.defer(() => { order.push("before"); });
  scope.defer(() => { throw new Error("boom"); });
  assert.deepEqual([...order], [], "nothing runs while the run is live");
  scope.close();
  scope.close();
  await sleep(10);
  assert.deepEqual([...order], ["before"]);
  assert.equal(scope.closed, true);
  scope.defer(() => { order.push("after"); });
  await sleep(10);
  assert.deepEqual(order, ["before", "after"]);
  assert.equal(warnings.length, 1, "a failing cleanup is logged, not thrown");
});

test("a transport can keep one value for the run, and its cleanup runs after the run", async () => {
  let opened = 0;
  let closed = 0;
  await run(configWith([shaper("s", "select")]), (_request, _entry, ctx) => {
    if (!ctx.scope.shared.has("connection")) {
      opened++;
      ctx.scope.shared.set("connection", {});
      ctx.scope.defer(() => { closed++; });
    }
    return data({});
  });
  await sleep(10);
  assert.deepEqual([opened, closed], [1, 1], "two repositories, one connection, closed once");
});

test("a task cancelled during shaping stops there", async () => {
  const controller = new AbortController();
  const pending = run(configWith([shaper("s", "select", { timeoutMs: 30_000 })], { limits: { deadlineMs: 60_000 } }), async (_r, _e, ctx) => {
    await new Promise((done) => ctx.signal.addEventListener("abort", done, { once: true }));
    return { kind: "timed_out", reason: "stopped" };
  }, input(1, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const result = await pending;
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(result.summary!.shapers.map((entry) => entry.outcome), ["failed"]);
  assert.match(result.summary!.shapers[0]!.reason!, /cancelled/);
});

test("a dry run calls exactly one shaper, switched off or not", async () => {
  const config = ShapingConfigSchema.parse({ shapers: [shaper("off", "select"), shaper("other", "select")] });
  const called: string[] = [];
  const result = await dryRunShaper("off", input(1), { config, discovered: [], transports: transports((_r, entry) => {
    called.push(entry.id);
    return data({ guidance: [{ id: "x", body: "would be injected" }] });
  }) });
  assert.equal(result.ok, true);
  assert.deepEqual(called, ["off"]);
  assert.deepEqual(result.ok && result.run.entries.map((entry) => entry.body), ["would be injected"]);
  assert.deepEqual(await dryRunShaper("ghost", input(1), { config, discovered: [] }), {
    ok: false, error: "unknown_shaper", reason: 'No shaper has the id "ghost".',
  });
});
