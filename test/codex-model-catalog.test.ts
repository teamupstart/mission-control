import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-codex-model-catalog-"));
process.env.HARNESS_HOME = join(home, "state");

const { CODEX_MODEL_CATALOG_BOUNDS, discoverCodexModels } = await import(
  "../src/server/harness/codex/model-catalog.ts"
);
import type { AppServerTransport } from "../src/server/harness/codex/app-server/client.ts";
import type { CodexModelCatalogBounds } from "../src/server/harness/codex/model-catalog.ts";
import type { HarnessModelCatalogProblem } from "../src/shared/protocol.ts";

after(() => rmSync(home, { recursive: true, force: true }));

/** A JSON-RPC error the fake returns instead of a result. */
type Fault = { error: { code: number; message: string } };
/** A method the fake accepts and never answers, so only the probe's timeout ends it. */
const SILENT = Symbol("silent");

type Reply = unknown | Fault | typeof SILENT | ((params: unknown) => unknown | Fault);

function isFault(value: unknown): value is Fault {
  return typeof value === "object" && value !== null && "error" in value;
}

/**
 * A hand-driven `codex app-server`, keyed by method.
 *
 * Modelled on the `FakeServer` in `codex-sdk-adapter.test.ts` for the same reason: the
 * real `AppServerClient` and the real adapter run against scripted frames, so id
 * correlation stays under test rather than being echoed back from the test's own source.
 */
class FakeServer implements AppServerTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  pid = 909;
  closed = false;
  private queued: unknown[] = [];
  private waiting: ((m: IteratorResult<unknown>) => void) | null = null;
  private ended = false;

  constructor(private readonly replies: Record<string, Reply>) {}

  send(frame: unknown): void {
    const msg = frame as Record<string, unknown>;
    this.sent.push(msg);
    const method = typeof msg.method === "string" ? msg.method : null;
    if (!method || msg.id === undefined) return;
    const reply = this.replies[method];
    if (reply === SILENT) return;
    if (reply === undefined) {
      this.push({ id: msg.id, error: { code: -32601, message: `method not found: ${method}` } });
      return;
    }
    const produced = typeof reply === "function" ? (reply as (p: unknown) => unknown)(msg.params) : reply;
    if (isFault(produced)) this.push({ id: msg.id, error: produced.error });
    else this.push({ id: msg.id, result: produced });
  }

  push(frame: unknown): void {
    if (this.ended) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: frame, done: false });
      return;
    }
    this.queued.push(frame);
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined, done: true });
    }
  }

  get frames(): AsyncIterable<unknown> {
    // Arrow functions rather than a generator method so `this` is captured lexically.
    const pull = async (): Promise<IteratorResult<unknown>> => {
      const queued = this.queued.shift();
      if (queued !== undefined) return { value: queued, done: false };
      if (this.ended) return { value: undefined, done: true };
      const frame = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.waiting = resolve;
      });
      return frame.done ? { value: undefined, done: true } : { value: frame.value, done: false };
    };
    return { [Symbol.asyncIterator]: () => ({ next: pull }) };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.end();
  }

  /** Which methods the probe called, in order. */
  get methods(): string[] {
    return this.sent.map((m) => m.method).filter((m): m is string => typeof m === "string");
  }
}

/** One live row, as `model/list` actually returned it against codex-cli 0.146.0. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "GPT-5.6-Sol",
    description: "Reliable agentic workhorse for everyday tasks.",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
      { reasoningEffort: "medium", description: "Balances speed and reasoning depth" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    additionalSpeedTiers: ["fast"],
    serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed" }],
    defaultServiceTier: "priority",
    isDefault: true,
    ...over,
  };
}

function probe(
  replies: Record<string, Reply>,
  extra: { bounds?: Partial<CodexModelCatalogBounds>; signal?: AbortSignal } = {},
): { server: FakeServer; result: Promise<Awaited<ReturnType<typeof discoverCodexModels>>> } {
  const server = new FakeServer({ initialize: {}, ...replies });
  const result = discoverCodexModels("codex", {
    connect: async () => server,
    ...extra,
  });
  return { server, result };
}

async function problemOf(
  replies: Record<string, Reply>,
  extra: Parameters<typeof probe>[1] = {},
): Promise<HarnessModelCatalogProblem | "ok"> {
  const { result } = probe(replies, extra);
  const settled = await result;
  return settled.ok ? "ok" : settled.problem;
}

test("one handshake and one model/list produce mapped choices, and no thread or turn", async () => {
  const { server, result } = probe({
    "model/list": { data: [row(), row({ id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" })], nextCursor: null },
  });
  const settled = await result;

  assert.equal(settled.ok, true);
  assert.deepEqual(settled.ok ? settled.choices : null, [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      hint: "Reliable agentic workhorse for everyday tasks.",
      provider: null,
      contextWindow: null,
      reasoning: true,
      inputModes: ["text", "image"],
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4-Mini",
      hint: "Reliable agentic workhorse for everyday tasks.",
      provider: null,
      contextWindow: null,
      reasoning: true,
      inputModes: ["text", "image"],
    },
  ]);

  // The safety claim, asserted rather than assumed: a catalog probe starts no thread and
  // no turn, so it cannot spend a token however the server behaves.
  assert.deepEqual(server.methods, ["initialize", "model/list"]);
  const handshake = server.sent[0]?.params as { capabilities?: Record<string, unknown> };
  assert.equal(handshake.capabilities?.experimentalApi, true);
  assert.equal(server.closed, true);
});

test("hidden rows are excluded and server order is preserved", async () => {
  const { result } = probe({
    "model/list": {
      data: [
        row({ id: "gpt-5.6-sol" }),
        row({ id: "gpt-5.6-internal", hidden: true }),
        row({ id: "gpt-5.4" }),
      ],
      nextCursor: null,
    },
  });
  const settled = await result;
  assert.deepEqual(settled.ok ? settled.choices.map((c) => c.id) : null, ["gpt-5.6-sol", "gpt-5.4"]);
});

test("a row that claims no efforts reports no reasoning claim rather than false", async () => {
  const { result } = probe({
    "model/list": {
      data: [
        row({ id: "a", supportedReasoningEfforts: [] }),
        row({ id: "b", supportedReasoningEfforts: "nonsense" }),
      ],
      nextCursor: null,
    },
  });
  const settled = await result;
  assert.deepEqual(
    settled.ok ? settled.choices.map((c) => c.reasoning) : null,
    [false, null],
  );
});

test("input modalities are filtered to what the contract knows and deduplicated", async () => {
  const { result } = probe({
    "model/list": {
      data: [row({ inputModalities: ["text", "audio", "text", "image", "video"] })],
      nextCursor: null,
    },
  });
  const settled = await result;
  assert.deepEqual(settled.ok ? settled.choices[0]?.inputModes : null, ["text", "image"]);
});

test("a missing display name falls back to a derived label rather than dropping the row", async () => {
  const { result } = probe({
    "model/list": { data: [row({ id: "gpt-5.4", displayName: "   " })], nextCursor: null },
  });
  const settled = await result;
  assert.equal(settled.ok ? settled.choices[0]?.label : null, "GPT-5.4");
});

test("an absent description becomes a null hint rather than an empty one", async () => {
  const { result } = probe({
    "model/list": { data: [row({ description: undefined })], nextCursor: null },
  });
  const settled = await result;
  assert.equal(settled.ok ? settled.choices[0]?.hint : "unset", null);
});

test("labels and hints are clamped to the carried limits", async () => {
  const { result } = probe({
    "model/list": {
      data: [row({ displayName: "L".repeat(400), description: "H".repeat(400) })],
      nextCursor: null,
    },
  });
  const settled = await result;
  const choice = settled.ok ? settled.choices[0] : null;
  assert.equal(choice?.label.length, CODEX_MODEL_CATALOG_BOUNDS.labelChars);
  assert.equal(choice?.hint?.length, CODEX_MODEL_CATALOG_BOUNDS.hintChars);
});

test("duplicate and unusable ids are dropped without failing the whole probe", async () => {
  const { result } = probe({
    "model/list": {
      data: [
        row({ id: "gpt-5.6-sol" }),
        row({ id: "gpt-5.6-sol" }),
        row({ id: "../../etc/passwd" }),
        row({ id: "-rf" }),
        row({ id: "" }),
        row({ id: 7 }),
        "not an object",
        null,
        row({ id: "gpt-5.4" }),
      ],
      nextCursor: null,
    },
  });
  const settled = await result;
  assert.deepEqual(settled.ok ? settled.choices.map((c) => c.id) : null, ["gpt-5.6-sol", "gpt-5.4"]);
});

test("a cursor is followed and its pages accumulate in order", async () => {
  const { server, result } = probe({
    "model/list": (params: unknown) => {
      const cursor = (params as { cursor?: string } | null)?.cursor ?? null;
      if (cursor === null) return { data: [row({ id: "gpt-5.6-sol" })], nextCursor: "page-2" };
      if (cursor === "page-2") return { data: [row({ id: "gpt-5.4" })], nextCursor: "" };
      return { data: [], nextCursor: null };
    },
  });
  const settled = await result;
  assert.deepEqual(settled.ok ? settled.choices.map((c) => c.id) : null, ["gpt-5.6-sol", "gpt-5.4"]);
  // An empty-string cursor is "no more pages", not a third request.
  assert.equal(server.methods.filter((m) => m === "model/list").length, 2);
});

test("a cursor that never terminates is cut off at the page bound", async () => {
  let served = 0;
  const { server, result } = probe(
    {
      "model/list": () => {
        served += 1;
        return { data: [row({ id: `gpt-page-${served}` })], nextCursor: "always-more" };
      },
    },
    { bounds: { pages: 3 } },
  );
  const settled = await result;
  assert.equal(settled.ok ? settled.choices.length : null, 3);
  assert.equal(server.methods.filter((m) => m === "model/list").length, 3);
});

test("more rows than the bound allows is an output limit, not a truncated catalog", async () => {
  assert.equal(
    await problemOf(
      {
        "model/list": {
          data: Array.from({ length: 6 }, (_, i) => row({ id: `gpt-${i}` })),
          nextCursor: null,
        },
      },
      { bounds: { rows: 4 } },
    ),
    "output_limit",
  );
});

test("an implausibly large page is refused before it is mapped or cached", async () => {
  assert.equal(
    await problemOf(
      {
        "model/list": { data: [row({ description: "x".repeat(4096) })], nextCursor: null },
      },
      { bounds: { responseBytes: 512 } },
    ),
    "output_limit",
  );
});

test("a response that is not a model list is invalid rather than empty", async () => {
  assert.equal(await problemOf({ "model/list": { data: "nope", nextCursor: null } }), "invalid_response");
  assert.equal(await problemOf({ "model/list": "nope" }), "invalid_response");
  assert.equal(await problemOf({ "model/list": null }), "invalid_response");
});

test("an empty list and an all-unusable list both report unavailable", async () => {
  assert.equal(await problemOf({ "model/list": { data: [], nextCursor: null } }), "unavailable");
  assert.equal(
    await problemOf({ "model/list": { data: [row({ id: "not a model id" })], nextCursor: null } }),
    "unavailable",
  );
});

test("a Codex that has never heard of model/list is unsupported, not broken", async () => {
  // The fake answers an unmapped method exactly as the server does: JSON-RPC -32601.
  assert.equal(await problemOf({}), "unsupported");
  assert.equal(
    await problemOf({ "model/list": { error: { code: -32000, message: "unknown method model/list" } } }),
    "unsupported",
  );
});

test("any other JSON-RPC error is an rpc failure", async () => {
  assert.equal(
    await problemOf({ "model/list": { error: { code: -32000, message: "not logged in" } } }),
    "rpc_failed",
  );
});

test("a refused handshake fails without reaching model/list", async () => {
  const { server, result } = probe({ initialize: { error: { code: -32000, message: "no" } } });
  const settled = await result;
  assert.equal(settled.ok, false);
  assert.equal(server.methods.includes("model/list"), false);
  assert.equal(server.closed, true);
});

test("a connection that ends mid-probe fails the probe rather than hanging", async () => {
  const server = new FakeServer({ initialize: {}, "model/list": SILENT });
  const result = discoverCodexModels("codex", { connect: async () => server });
  // The server dies with the request outstanding, which is what a crashed app-server is.
  setTimeout(() => server.end(), 10);
  const settled = await result;
  assert.equal(settled.ok, false);
  assert.equal(settled.ok ? null : settled.problem, "process_failed");
});

test("a server that never answers is bounded by the probe's own timeout", async () => {
  assert.equal(
    await problemOf({ "model/list": SILENT }, { bounds: { timeoutMs: 40 } }),
    "timeout",
  );
});

test("a spawn that throws is a process failure and never a thrown probe", async () => {
  const settled = await discoverCodexModels("codex", {
    connect: async () => {
      throw new Error("no codex on this machine");
    },
  });
  assert.equal(settled.ok, false);
  assert.equal(settled.ok ? null : settled.problem, "process_failed");
});

test("an already-aborted probe never spawns anything", async () => {
  let connected = false;
  const settled = await discoverCodexModels("codex", {
    signal: AbortSignal.abort(),
    connect: async () => {
      connected = true;
      return new FakeServer({});
    },
  });
  assert.equal(settled.ok, false);
  assert.equal(connected, false);
});

test("aborting a probe in flight ends it without waiting for the server", async () => {
  const controller = new AbortController();
  const server = new FakeServer({ initialize: {}, "model/list": SILENT });
  const result = discoverCodexModels("codex", {
    connect: async () => server,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  const settled = await result;
  assert.equal(settled.ok, false);
  assert.equal(server.closed, true);
});

test("notifications and server requests arriving first are ignored, not mistaken for the reply", async () => {
  const server = new FakeServer({
    initialize: {},
    "model/list": { data: [row()], nextCursor: null },
  });
  server.push({ method: "thread/status", params: { status: "idle" } });
  server.push({ method: "command/approval", id: 0, params: {} });
  server.push({ id: 4242, result: { data: [] } });
  const settled = await discoverCodexModels("codex", { connect: async () => server });
  assert.deepEqual(settled.ok ? settled.choices.map((c) => c.id) : null, ["gpt-5.6-sol"]);
});

test("the transport is closed on every outcome", async () => {
  for (const replies of [
    { "model/list": { data: [row()], nextCursor: null } },
    { "model/list": { data: [], nextCursor: null } },
    { "model/list": { error: { code: -32601, message: "nope" } } },
    { initialize: { error: { code: -1, message: "nope" } } },
  ] as Record<string, Reply>[]) {
    const { server, result } = probe(replies);
    await result;
    assert.equal(server.closed, true, `not closed for ${JSON.stringify(replies)}`);
  }
});

test("the shipped bounds carry the measured headroom the probe was sized against", () => {
  // Measured against codex-cli 0.146.0: handshake 593ms cold, `model/list` 2ms, a
  // 6035-byte payload, 6 visible rows and no cursor. End to end, four runs took 974ms,
  // 1936ms, 2714ms and 4079ms - spawn time is what varies. The timeout has to clear that
  // slowest run with room, or an ordinary probe starts failing for no reason.
  assert.ok(CODEX_MODEL_CATALOG_BOUNDS.timeoutMs >= 12_000);
  assert.ok(CODEX_MODEL_CATALOG_BOUNDS.responseBytes >= 64_000);
  assert.ok(CODEX_MODEL_CATALOG_BOUNDS.rows >= 32);
  assert.ok(CODEX_MODEL_CATALOG_BOUNDS.pages >= 2);
});
