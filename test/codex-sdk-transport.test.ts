import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { codexRunner, configureCodexRunnerTransport } from "../src/server/llm/codex.ts";
import { killLiveCodexSdkRuns, runCodexSdkOneShot } from "../src/server/llm/codex-sdk.ts";

/**
 * What is at stake: this transport is a PARSING change, not a fetching one. `@openai/codex-sdk`
 * spawns the same `codex` executable the exec path does - `spawn(this.executablePath, …)` in its
 * own `CodexExec` - so the two differ in how a reply is decoded and in nothing else.
 *
 * That makes one option load-bearing rather than cosmetic. The SDK declares a dependency on
 * `@openai/codex`, so installing it puts a SECOND copy of the CLI in `node_modules`, at a
 * different version from the operator's configured binary. Left to resolve for itself the SDK
 * would run that bundled copy, and the transport toggle would silently change which executable
 * runs - a different version, different flags, different auth. Pinning `codexPathOverride` to
 * the same path the exec transport spawns is what keeps the choice honest, and it is the one
 * thing here that cannot be verified by reading types.
 */

test("the sdk transport drives the operator's configured binary, not the SDK's bundled copy", async () => {
  let sawPath: string | undefined;
  let sawEnv: Record<string, string> | undefined;
  const text = await runCodexSdkOneShot(
    "name this task",
    "/opt/homebrew/bin/codex",
    { model: "gpt-5.6-luna" },
    {
      createClient: ({ codexPathOverride, env }) => {
        sawPath = codexPathOverride;
        sawEnv = env;
        return {
          startThread: () => ({
            run: async () => ({ finalResponse: '{"title":"Fix the parser"}' }),
          }),
        };
      },
    },
  );

  assert.equal(
    sawPath,
    "/opt/homebrew/bin/codex",
    "the SDK must be pinned to the configured codex, or the two transports run different binaries",
  );
  assert.equal(text.text, '{"title":"Fix the parser"}');
  assert.ok(sawEnv?.MISSION_HOME);
  assert.notEqual(sawEnv?.MISSION_HOME, process.env.MISSION_HOME);
  assert.equal(sawEnv?.FLEET_HOME, undefined);
  assert.equal(sawEnv?.HARNESS_HOME, undefined);
  assert.equal(
    existsSync(sawEnv!.MISSION_HOME!),
    false,
    "the one-shot releases its disposable state home after the SDK turn settles",
  );
});

test("an empty final response is an error rather than an empty answer", async () => {
  // A caller that parses this text would otherwise get "" and report a parse miss, which reads
  // as a model that answered badly rather than a transport that returned nothing.
  await assert.rejects(
    () =>
      runCodexSdkOneShot("x", "/bin/codex", {}, {
        createClient: () => ({
          startThread: () => ({ run: async () => ({ finalResponse: "   " }) }),
        }),
      }),
    /no final response/i,
  );
});

test("a synchronous SDK construction failure still releases its disposable state home", async () => {
  let stateHome = "";
  await assert.rejects(
    () =>
      runCodexSdkOneShot("x", "/bin/codex", {}, {
        createClient: ({ env }) => {
          stateHome = env.MISSION_HOME!;
          throw new Error("constructor failed");
        },
      }),
    /constructor failed/,
  );
  assert.equal(existsSync(stateHome), false);
});

test("the sdk transport refuses what it cannot honour rather than dropping it", async () => {
  // Both are silently unsupported on this path. A caller that attached an image and got an
  // answer about nothing could not tell that the image was never sent.
  await assert.rejects(
    () =>
      runCodexSdkOneShot("x", "/bin/codex", {
        images: [{ path: "/tmp/a.png", bytes: 1, sha256: "x" }] as never,
      }),
    /does not support images/i,
  );
  await assert.rejects(
    () => runCodexSdkOneShot("x", "/bin/codex", { grant: { tools: [], cwd: "/" } as never }),
    /does not support tool grants/i,
  );
});

test("the runner routes to the sdk only when the transport says so", async () => {
  let sdkCalls = 0;
  const restore = configureCodexRunnerTransport(() => "sdk", {
    createClient: () => ({
      startThread: () => ({
        run: async () => {
          sdkCalls += 1;
          return { finalResponse: "routed" };
        },
      }),
    }),
  });
  try {
    assert.equal(await codexRunner.run("hello"), "routed");
    assert.equal(sdkCalls, 1, "the sdk branch must be the one that ran");
  } finally {
    restore();
  }

  // And with the shipped default installed, the SDK is never constructed at all - the exec
  // path stays exactly what it was for every operator who does not opt in.
  const restoreExec = configureCodexRunnerTransport(() => "exec", {
    createClient: () => {
      assert.fail("the exec transport must not construct the SDK client");
    },
  });
  restoreExec();
});

/**
 * What is at stake, and this is a bug the first version of this transport actually had: a
 * timeout that rejects the WRAPPER promise and leaves `thread.run` executing does not stop
 * anything. The caller degrades to its deterministic tier and moves on - correct - while a
 * real `codex` process keeps running and keeps spending, and because the background jobs on
 * this runner time out routinely against a slow or logged-out provider, every timeout adds
 * another one. The file even claimed the SDK would tear the child down; nothing was.
 *
 * `TurnOptions.signal` is the SDK's supported cancellation. These pin that it is actually
 * passed, actually fired on timeout, and that the abandoned run cannot take the daemon down
 * as an unhandled rejection.
 */
test("a timed-out run is aborted, not merely abandoned", async () => {
  let signal: AbortSignal | undefined;
  let abortedDuringRun = false;

  await assert.rejects(
    () =>
      runCodexSdkOneShot("x", "/bin/codex", { timeoutMs: 30 }, {
        createClient: () => ({
          startThread: () => ({
            id: "th_1",
            run: (_prompt, turnOptions) => {
              signal = turnOptions?.signal;
              // A turn that never settles on its own, which is exactly the hang this guards.
              return new Promise((_resolve, reject) => {
                turnOptions?.signal?.addEventListener("abort", () => {
                  abortedDuringRun = true;
                  reject(new Error("aborted"));
                });
              });
            },
          }),
        }),
      }),
    /timed out/i,
  );

  assert.ok(signal, "the SDK must be given an AbortSignal, or a hung turn cannot be cancelled");
  assert.equal(signal?.aborted, true, "the timeout must fire the abort");
  assert.equal(abortedDuringRun, true, "the run itself must observe the cancellation");

  // The abandoned run rejects after the caller has gone. If that rejection were unobserved it
  // would be an unhandled rejection, which is fatal on this daemon - so give it a turn to land.
  await new Promise((r) => setTimeout(r, 20));
});

test("shutdown aborts every in-flight sdk run", async () => {
  // The runner promises `killLiveRuns` takes every live child with it. SDK turns are held by
  // abort handle rather than by pid, so a shutdown that swept only the spawned set would miss
  // them entirely and leave provider work running past the daemon.
  let aborted = false;
  const pending = runCodexSdkOneShot("x", "/bin/codex", {}, {
    createClient: () => ({
      startThread: () => ({
        id: "th_2",
        run: (_prompt, turnOptions) =>
          new Promise((_resolve, reject) => {
            turnOptions?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      }),
    }),
  });

  const settled = assert.rejects(() => pending, /aborted/);
  // Let the run register itself before sweeping.
  await new Promise((r) => setTimeout(r, 10));
  killLiveCodexSdkRuns();
  await settled;
  assert.equal(aborted, true, "killLiveRuns must reach the SDK transport");
});

test("usage rides back so an sdk run reaches the spend ledger like an exec one", async () => {
  // Reported rather than dropped: the SDK's `Turn.usage` carries the same field names the exec
  // transport reads off `turn.completed`, so both transports reach one ledger through one
  // reporter. An earlier version discarded this and logged a warning instead, which understated
  // real spend for anyone who switched.
  const result = await runCodexSdkOneShot("x", "/bin/codex", {}, {
    createClient: () => ({
      startThread: () => ({
        id: "th_3",
        run: async () => ({
          finalResponse: "ok",
          usage: { input_tokens: 12414, cached_input_tokens: 0, output_tokens: 9 },
        }),
      }),
    }),
  });

  assert.equal(result.threadId, "th_3");
  assert.deepEqual(result.usage, {
    input_tokens: 12414,
    cached_input_tokens: 0,
    output_tokens: 9,
  });
});

/**
 * What is at stake, and this one is only visible from outside the file: the SDK defaults a
 * thread's working directory to the CURRENT PROCESS's. Both processes that run this - the
 * daemon and the Foreman worker - are started inside a real checkout, so leaving it unset
 * scopes a tool-less run to whatever repository happens to be open, while `codex exec` has
 * always spawned in `tmpdir()`.
 *
 * These calls are not repository-scoped by design. `LlmRunOptions` carries no `cwd` at all;
 * the only `cwd` in the model belongs to `LlmToolGrant`, and this runner declares
 * `sandbox: null` and refuses every grant outright (asserted above). A run that may not be
 * GRANTED a directory must not INHERIT one, which is exactly what an unset default does.
 */
test("an sdk run is pinned to the exec transport's posture, not the process's", async () => {
  let sawThread: Record<string, unknown> | undefined;
  let sawConfig: unknown;
  await runCodexSdkOneShot("x", "/bin/codex", {}, {
    createClient: ({ config }) => {
      sawConfig = config;
      return {
        startThread: (options) => {
          sawThread = options as Record<string, unknown>;
          return { id: "th_5", run: async () => ({ finalResponse: "ok" }) };
        },
      };
    },
  });

  assert.equal(
    sawThread?.workingDirectory,
    tmpdir(),
    "an unset working directory silently scopes the run to the daemon's own checkout",
  );
  assert.equal(sawThread?.sandboxMode, "read-only");
  assert.equal(sawThread?.approvalPolicy, "never");
  assert.equal(sawThread?.skipGitRepoCheck, true);
  // The exec transport spells these as `-c features.shell_tool=false`. Same posture, and
  // the SDK's spelling for them is a client-level config override rather than a thread one.
  assert.deepEqual(sawConfig, { features: { shell_tool: false, unified_exec: false } });
});

test("a schema run sends the shape, so both transports answer alike", async () => {
  // The SDK's spelling of the exec transport's `--output-schema`. Omitting it made a structured
  // job behave differently depending on which transport happened to be configured.
  let sawSchema: unknown;
  const schema = { type: "object", properties: { title: { type: "string" } } };
  await runCodexSdkOneShot("x", "/bin/codex", { schema }, {
    createClient: () => ({
      startThread: () => ({
        id: "th_4",
        run: async (_prompt, turnOptions) => {
          sawSchema = turnOptions?.outputSchema;
          return { finalResponse: "{}" };
        },
      }),
    }),
  });
  assert.deepEqual(sawSchema, schema, "a schema run must carry its shape to the provider");
});
