import { after, test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mission-pi-model-catalog-"));
process.env.HARNESS_HOME = join(home, "state");

const {
  PI_MODEL_CATALOG_BOUNDS,
  discoverPiModels,
} = await import("../src/server/harness/pi/model-catalog.ts");
import type {
  PiCatalogChild,
  PiCatalogExit,
  PiModelCatalogDeps,
} from "../src/server/harness/pi/model-catalog.ts";
import type { HarnessModelCatalogProblem } from "../src/shared/protocol.ts";

after(() => rmSync(home, { recursive: true, force: true }));

class FakeChild implements PiCatalogChild {
  readonly writes: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  readonly exit: Promise<PiCatalogExit>;
  inputClosed = false;
  killResult = true;
  exitAfterFailedKill: PiCatalogExit | null = null;
  private finishExit!: (exit: PiCatalogExit) => void;

  constructor(
    stdout: readonly (Uint8Array | string)[] | PassThrough,
    stderr: readonly (Uint8Array | string)[] | PassThrough = [],
    private readonly exitOnInputClose = true,
    private readonly ignoreTerm = false,
    private readonly inputCloseExit: PiCatalogExit = {
      code: 0,
      signal: null,
      error: false,
    },
  ) {
    this.stdout = stdout instanceof PassThrough ? stdout : Readable.from(stdout);
    this.stderr = stderr instanceof PassThrough ? stderr : Readable.from(stderr);
    this.exit = new Promise((resolve) => {
      this.finishExit = resolve;
    });
  }

  send(line: string): void {
    this.writes.push(line);
  }

  endInput(): void {
    this.inputClosed = true;
    if (this.exitOnInputClose) this.finishExit(this.inputCloseExit);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (!this.killResult) {
      if (this.exitAfterFailedKill) this.finishExit(this.exitAfterFailedKill);
      return false;
    }
    if (signal === "SIGKILL" || !this.ignoreTerm) {
      this.finishExit({ code: null, signal, error: false });
      if (this.stdout instanceof PassThrough) this.stdout.destroy();
      if (this.stderr instanceof PassThrough) this.stderr.destroy();
    }
    return true;
  }

  fail(exit: PiCatalogExit): void {
    this.finishExit(exit);
  }
}

function response(models: unknown[], extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    id: "probe-id",
    type: "response",
    command: "get_available_models",
    success: true,
    data: { models },
    ...extra,
  })}\n`;
}

function model(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "openai",
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    api: "responses",
    baseUrl: "https://example.invalid",
    headers: { authorization: "must-not-cross-the-boundary" },
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    maxTokens: 128_000,
    ...over,
  };
}

function depsFor(child: FakeChild): Partial<PiModelCatalogDeps> {
  return {
    requestId: () => "probe-id",
    spawn: (executable, args, options) => {
      assert.equal(executable, "/fake/pi");
      assert.deepEqual(args, [
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-tools",
        "--no-approve",
      ]);
      assert.equal(options.shell, false);
      assert.equal(isAbsolute(options.cwd), true);
      const checkoutRelative = relative(process.cwd(), options.cwd);
      assert.ok(
        checkoutRelative === ".." || checkoutRelative.startsWith(`..${sep}`),
        `catalog cwd must be outside the checkout, got ${options.cwd}`,
      );
      return child;
    },
    bounds: { ...PI_MODEL_CATALOG_BOUNDS, timeoutMs: 40, closeGraceMs: 2 },
  };
}

test("Pi discovery is one prompt-free, no-session RPC command with chunk-safe correlated framing", async () => {
  const line = response([
    model(),
    model({ provider: "anthropic", id: "claude-sonnet-5", name: " Claude   Sonnet 5 ", input: ["text"] }),
  ]);
  const prelude = `${JSON.stringify({ type: "model_changed", model: model() })}\n${JSON.stringify({
    id: "some-other-request",
    type: "response",
    command: "get_available_models",
    success: true,
    data: { models: [] },
  })}\n`;
  const bytes = `${prelude}${line}`;
  const child = new FakeChild([bytes.slice(0, 17), bytes.slice(17, 93), bytes.slice(93)]);

  const result = await discoverPiModels("/fake/pi", depsFor(child));

  assert.deepEqual(result, {
    ok: true,
    choices: [
      {
        id: "openai/gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        hint: null,
        provider: "openai",
        contextWindow: 1_000_000,
        reasoning: true,
        inputModes: ["text", "image"],
      },
      {
        id: "anthropic/claude-sonnet-5",
        label: "Claude Sonnet 5",
        hint: null,
        provider: "anthropic",
        contextWindow: 1_000_000,
        reasoning: true,
        inputModes: ["text"],
      },
    ],
  });
  assert.deepEqual(JSON.parse(child.writes[0]!), {
    id: "probe-id",
    type: "get_available_models",
  });
  assert.equal(child.writes[0]!.endsWith("\n"), true);
  assert.equal(child.writes.length, 1);
  assert.equal(child.inputClosed, true);
  assert.deepEqual(child.signals, []);
  assert.equal("headers" in result.choices[0]!, false);
  assert.equal("cost" in result.choices[0]!, false);
  assert.equal("baseUrl" in result.choices[0]!, false);
});

test("Pi discovery preserves first-seen order, deduplicates full ids, and drops unsafe rows", async () => {
  const child = new FakeChild([
    response([
      model({ provider: "openai", id: "gpt-5.6-sol", name: "First" }),
      model({ provider: "openai", id: "gpt-5.6-sol", name: "Duplicate" }),
      model({ provider: "google", id: "gemini-3", name: "Gemini 3", reasoning: false, input: ["audio", "text"] }),
      model({ provider: "openrouter", id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", input: ["text"] }),
      model({ provider: "../../bad", id: "model", name: "Unsafe provider" }),
      model({ provider: "openai", id: "-rf", name: "Unsafe id" }),
      model({ provider: "openrouter", id: "../../bad", name: "Unsafe nested id" }),
      model({ provider: "x".repeat(65), id: "model", name: "Oversized provider" }),
    ]),
  ]);

  const result = await discoverPiModels("/fake/pi", depsFor(child));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.choices.map((choice) => choice.id), [
    "openai/gpt-5.6-sol",
    "google/gemini-3",
    "openrouter/anthropic/claude-sonnet-5",
  ]);
  assert.deepEqual(result.choices[1]!.inputModes, ["text"]);
});

test("Pi discovery preserves safe identities when optional presentation metadata is unknown", async () => {
  const child = new FakeChild([
    response([
      model({
        id: "future-model",
        name: undefined,
        contextWindow: undefined,
        reasoning: "sometimes",
        input: undefined,
      }),
      model({
        provider: "custom",
        id: "safe-model",
        name: "   ",
      }),
    ]),
  ]);
  const result = await discoverPiModels("/fake/pi", depsFor(child));
  assert.deepEqual(result, {
    ok: true,
    choices: [
      {
        id: "openai/future-model",
        label: "Future Model",
        hint: null,
        provider: "openai",
        contextWindow: null,
        reasoning: null,
        inputModes: [],
      },
      {
        id: "custom/safe-model",
        label: "Safe Model",
        hint: null,
        provider: "custom",
        contextWindow: 1_000_000,
        reasoning: true,
        inputModes: ["text", "image"],
      },
    ],
  });
});

test("Pi discovery normalizes and bounds display labels", async () => {
  const child = new FakeChild([
    response([model({ id: "gpt-5.6-terra", name: `  ${"word ".repeat(80)}  ` })]),
  ]);
  const result = await discoverPiModels("/fake/pi", depsFor(child));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.choices[0]!.label.length, PI_MODEL_CATALOG_BOUNDS.labelChars);
  assert.equal(result.choices[0]!.label.includes("  "), false);
});

test("Pi discovery maps framing, RPC, availability, and process failures to bounded codes", async (t) => {
  const cases: readonly [string, () => FakeChild, HarnessModelCatalogProblem][] = [
    ["malformed JSON", () => new FakeChild(["{not-json}\n"], [], false), "invalid_response"],
    ["wrong correlation", () => new FakeChild([response([], { id: "wrong" })], [], false), "invalid_response"],
    ["wrong command", () => new FakeChild([response([], { command: "get_state" })], [], false), "invalid_response"],
    [
      "unsupported command",
      () => new FakeChild([`${JSON.stringify({ id: "probe-id", type: "response", command: "get_available_models", success: false, error: "Unknown command: get_available_models" })}\n`], [], false),
      "unsupported",
    ],
    [
      "provider or runtime RPC failure",
      () => new FakeChild([`${JSON.stringify({ id: "probe-id", type: "response", command: "get_available_models", success: false, error: "secret provider runtime error" })}\n`], [], false),
      "rpc_failed",
    ],
    ["empty model list", () => new FakeChild([response([])], [], false), "unavailable"],
    ["only invalid models", () => new FakeChild([response([model({ provider: "bad provider" })])], [], false), "unavailable"],
  ];
  for (const [name, makeChild, problem] of cases) {
    await t.test(name, async () => {
      const child = makeChild();
      const result = await discoverPiModels("/fake/pi", depsFor(child));
      assert.deepEqual(result, { ok: false, problem });
      assert.equal(child.inputClosed, true, `${name}: stdin was not closed`);
      assert.deepEqual(child.signals, ["SIGTERM"], `${name}: failure was not terminated`);
    });
  }

  await t.test("spawn failure", async () => {
    const result = await discoverPiModels("/fake/pi", {
      ...depsFor(new FakeChild([])),
      spawn: () => {
        throw new Error("ENOENT / secret wrapper path");
      },
    });
    assert.deepEqual(result, { ok: false, problem: "process_failed" });
  });

  await t.test("actual child spawn error", async () => {
    const result = await discoverPiModels(join(home, "missing-pi-binary"), {
      requestId: () => "probe-id",
      bounds: { ...PI_MODEL_CATALOG_BOUNDS, timeoutMs: 1_000, closeGraceMs: 10 },
    });
    assert.deepEqual(result, { ok: false, problem: "process_failed" });
  });

  await t.test("actual child non-zero close after stdout EOF", async () => {
    const result = await discoverPiModels(process.execPath, {
      requestId: () => "probe-id",
      bounds: { ...PI_MODEL_CATALOG_BOUNDS, timeoutMs: 1_000, closeGraceMs: 10 },
    });
    assert.deepEqual(result, { ok: false, problem: "process_failed" });
  });

  await t.test("non-zero exit", async () => {
    const stdout = new PassThrough();
    const child = new FakeChild(stdout, [], false);
    child.fail({ code: 17, signal: null, error: false });
    const result = await discoverPiModels("/fake/pi", depsFor(child));
    assert.deepEqual(result, { ok: false, problem: "process_failed" });
    assert.equal(child.inputClosed, true);
    assert.deepEqual(child.signals, []);
  });

  await t.test("matching response followed by non-zero exit", async () => {
    const child = new FakeChild(
      [response([model()])],
      [],
      true,
      false,
      { code: 17, signal: null, error: false },
    );
    const result = await discoverPiModels("/fake/pi", depsFor(child));
    assert.deepEqual(result, { ok: false, problem: "process_failed" });
    assert.equal(child.inputClosed, true);
    assert.deepEqual(child.signals, []);
  });

  await t.test("a failed cleanup signal does not mask a later non-zero exit", async () => {
    const child = new FakeChild([response([model()])], [], false);
    child.killResult = false;
    child.exitAfterFailedKill = { code: 17, signal: null, error: false };
    const result = await discoverPiModels("/fake/pi", depsFor(child));
    assert.deepEqual(result, { ok: false, problem: "process_failed" });
    assert.deepEqual(child.signals, ["SIGTERM"]);
  });
});

test("Pi discovery bounds time, stdout, stderr, and model count", async (t) => {
  await t.test("timeout", async () => {
    const child = new FakeChild(new PassThrough(), new PassThrough(), false, true);
    const result = await discoverPiModels("/fake/pi", depsFor(child));
    assert.deepEqual(result, { ok: false, problem: "timeout" });
    assert.equal(child.inputClosed, true);
    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  });

  await t.test("stdout bytes", async () => {
    const child = new FakeChild(["x".repeat(65)], [], false);
    const result = await discoverPiModels("/fake/pi", {
      ...depsFor(child),
      bounds: { ...PI_MODEL_CATALOG_BOUNDS, stdoutBytes: 64, timeoutMs: 40, closeGraceMs: 2 },
    });
    assert.deepEqual(result, { ok: false, problem: "output_limit" });
    assert.equal(child.inputClosed, true);
    assert.deepEqual(child.signals, ["SIGTERM"]);
  });

  await t.test("stderr bytes", async () => {
    const child = new FakeChild(new PassThrough(), ["x".repeat(65)], false);
    const result = await discoverPiModels("/fake/pi", {
      ...depsFor(child),
      bounds: { ...PI_MODEL_CATALOG_BOUNDS, stderrBytes: 64, timeoutMs: 40, closeGraceMs: 2 },
    });
    assert.deepEqual(result, { ok: false, problem: "output_limit" });
    assert.equal(child.inputClosed, true);
    assert.deepEqual(child.signals, ["SIGTERM"]);
  });

  await t.test("rows", async () => {
    const child = new FakeChild([response([model(), model({ id: "other" })])], [], false);
    const result = await discoverPiModels("/fake/pi", {
      ...depsFor(child),
      bounds: { ...PI_MODEL_CATALOG_BOUNDS, rows: 1, timeoutMs: 40, closeGraceMs: 2 },
    });
    assert.deepEqual(result, { ok: false, problem: "output_limit" });
    assert.equal(child.inputClosed, true);
    assert.deepEqual(child.signals, ["SIGTERM"]);
  });
});

test("a child that ignores graceful close is hard-killed after the bounded grace", async () => {
  const child = new FakeChild([response([model()])], [], false, true);
  const result = await discoverPiModels("/fake/pi", depsFor(child));
  assert.equal(result.ok, true);
  assert.equal(child.inputClosed, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("an aborted probe closes input and completes the TERM-to-KILL cleanup ladder", async () => {
  const controller = new AbortController();
  const child = new FakeChild(new PassThrough(), new PassThrough(), false, true);
  const resultPromise = discoverPiModels("/fake/pi", {
    ...depsFor(child),
    signal: controller.signal,
  });
  controller.abort();
  const result = await resultPromise;
  assert.deepEqual(result, { ok: false, problem: "process_failed" });
  assert.equal(child.inputClosed, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});
