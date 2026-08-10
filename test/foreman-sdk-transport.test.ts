import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  ClaudeSdkMessage,
  ClaudeSdkOneShotDeps,
} from "../src/server/harness/claude/sdk-types.ts";

// The process boundary is the feature here. Foreman cannot read the app_config row that
// selects Claude's transport, and importing the daemon's config module would open SQLite as
// a side effect. It learns the daemon's resolved answer over HTTP, then configures the same
// process-local runner seam the daemon uses.

const originalFetch = globalThis.fetch;
let statusBody: unknown;
globalThis.fetch = async () => Response.json(statusBody);

const {
  ForemanClient,
  foremanClaudeTransportFallback,
} = await import("../src/server/foreman/client.ts");
const { installForemanShutdown } = await import("../src/server/foreman/shutdown.ts");
const {
  claudeRunner,
  configureClaudeRunnerTransport,
} = await import("../src/server/llm/claude.ts");

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.MISSION_CLAUDE_TRANSPORT;
});

beforeEach(() => {
  statusBody = { runner: { id: "claude" }, claudeTransport: "print" };
  delete process.env.MISSION_CLAUDE_TRANSPORT;
});

test("Foreman reads the daemon's resolved Claude transport beside its runner", async () => {
  statusBody = { runner: { id: "codex" }, claudeTransport: "sdk" };
  assert.deepEqual(await new ForemanClient().llmSelection(), {
    runner: "codex",
    claudeTransport: "sdk",
  });
});

test("an older daemon degrades through the worker environment and then the SDK default", async () => {
  statusBody = { runner: { id: "claude" } };
  process.env.MISSION_CLAUDE_TRANSPORT = "sdk";
  assert.equal((await new ForemanClient().llmSelection()).claudeTransport, "sdk");
  assert.equal(foremanClaudeTransportFallback(), "sdk");

  process.env.MISSION_CLAUDE_TRANSPORT = "future-wire";
  assert.equal((await new ForemanClient().llmSelection()).claudeTransport, "sdk");
  assert.equal(foremanClaudeTransportFallback(), "sdk");
});

test("the Agent SDK package resolves in a separate tsx-run process", async () => {
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    "const sdk = await import('@anthropic-ai/claude-agent-sdk'); process.stdout.write(typeof sdk.query);",
  ], { cwd: fileURLToPath(new URL("../", import.meta.url)) });
  assert.equal(stdout, "function");
});

const REPO = fileURLToPath(new URL("../", import.meta.url));

function localImport(parent: string, specifier: string): string | null {
  let candidate: string;
  if (specifier.startsWith("@shared/")) {
    candidate = resolve(REPO, "src/shared", specifier.slice("@shared/".length));
  } else if (specifier.startsWith(".")) {
    candidate = resolve(dirname(parent), specifier);
  } else {
    return null;
  }
  for (const path of [candidate, `${candidate}.ts`, `${candidate}.mjs`, `${candidate}/index.ts`]) {
    if (existsSync(path)) return path;
  }
  return null;
}

function localGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    const imports = source.matchAll(
      /(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g,
    );
    for (const match of imports) {
      const child = localImport(path, match[1]!);
      if (child && !seen.has(child)) pending.push(child);
    }
  }
  return seen;
}

test("the Foreman worker's transitive module graph opens no database", () => {
  const worker = resolve(REPO, "src/server/foreman/worker.ts");
  const graph = localGraph(worker);
  for (const forbidden of [
    resolve(REPO, "src/server/db.ts"),
    resolve(REPO, "src/server/llm/config.ts"),
    resolve(REPO, "src/server/spend-ledger.ts"),
  ]) {
    assert.equal(graph.has(forbidden), false, `${forbidden} entered the worker process`);
  }
});

test("the worker's ordinary shutdown aborts an in-flight SDK query", async () => {
  let controller: AbortController | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const deps: ClaudeSdkOneShotDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ options }) => {
      controller = options.abortController;
      markStarted();
      return {
        [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkMessage> {
          return {
            next: () => new Promise<IteratorResult<ClaudeSdkMessage>>(() => {}),
          };
        },
      };
    },
  };
  const restore = configureClaudeRunnerTransport(() => "sdk", deps);
  try {
    const pending = claudeRunner.run("stay in flight", { timeoutMs: 60_000 });
    await started;

    const listeners = new Map<string, () => void>();
    let finishExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      finishExit = resolve;
    });
    installForemanShutdown(
      { releaseLease: async () => {} },
      "worker-under-test",
      () => {},
      {
        on(signal, listener) {
          listeners.set(signal, listener);
        },
        exit(code) {
          finishExit(code);
          return undefined as never;
        },
      },
    );

    listeners.get("SIGTERM")!();
    await assert.rejects(pending, /aborted/);
    assert.equal(controller?.signal.aborted, true);
    assert.equal(await exited, 0);
  } finally {
    restore();
  }
});
