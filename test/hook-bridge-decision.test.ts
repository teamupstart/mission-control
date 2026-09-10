import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: every prompt typed at every terminal, on every agent this bridge serves.
 *
 * `postHookEvent` gained the ability to carry a decision back from the daemon, which is how a
 * prompt typed into a concluded mission's pane is refused before it starts a turn. That is one
 * narrow feature bolted onto the hot path of an agent's whole life, and the safety property is
 * not the feature - it is that EVERY other outcome still means "carry on".
 *
 * A daemon that is down, slow, upgrading, mid-restart, answering 204 as it always did, or
 * returning something that will not parse must never stop a person's prompt. These pin that
 * one-way property: `null` from every path except a deliberate, well-formed answer.
 */

const home = mkdtempSync(join(tmpdir(), "mission-hook-bridge-"));
process.env.MISSION_HOME = home;

const { postHookEvent } = await import("../src/shared/hook-bridge.mjs");

const EVENT = { agent: "claude", event: "UserPromptSubmit", prompt: "hello" };

/** Run one exchange against a stubbed transport, restoring the real one afterwards. */
async function withFetch(
  impl: () => Promise<unknown> | never,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const real = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = impl;
  try {
    return await run();
  } finally {
    (globalThis as { fetch: unknown }).fetch = real;
  }
}

function response(status: number, body: string): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

test("a 204 is carry on, which is what every ordinary event gets", async () => {
  const answer = await withFetch(
    async () => response(204, ""),
    () => postHookEvent(EVENT),
  );
  assert.equal(answer, null);
});

test("a deliberate, well-formed refusal is the one thing that comes back", async () => {
  const answer = await withFetch(
    async () => response(200, JSON.stringify({ decision: "block", reason: "the run was concluded" })),
    () => postHookEvent(EVENT),
  );
  assert.deepEqual(answer, { decision: "block", reason: "the run was concluded" });
});

test("a daemon that is down never stops a prompt", async () => {
  const answer = await withFetch(
    () => { throw new Error("ECONNREFUSED"); },
    () => postHookEvent(EVENT),
  );
  assert.equal(answer, null);
});

test("an error status never stops a prompt", async () => {
  for (const status of [400, 401, 500, 503]) {
    const answer = await withFetch(
      async () => response(status, JSON.stringify({ decision: "block", reason: "no" })),
      () => postHookEvent(EVENT),
    );
    assert.equal(answer, null, `a ${status} must not be read as a decision`);
  }
});

test("a body that will not parse never stops a prompt", async () => {
  for (const body of ["", "not json", "<html>daemon upgrading</html>", "null", '"block"', "[]"]) {
    const answer = await withFetch(
      async () => response(200, body),
      () => postHookEvent(EVENT),
    );
    assert.equal(answer, null, `an unusable body (${JSON.stringify(body)}) must not become a decision`);
  }
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
