import { test } from "node:test";
import assert from "node:assert/strict";
import { ForemanClient } from "../src/server/foreman/client.ts";

// The worker's config read is the one daemon response it can't afford to take on trust: it
// decides whether Foreman acts and how. These stub `fetch` to stand in for the daemon, since
// the client's only job here is what it does with the bytes that come back.

/** Run `fn` with the daemon serving `body` (and `ok`) for every fetch, then restore. */
async function withDaemon<T>(body: unknown, fn: () => Promise<T>, ok = true): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  })) as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const client = new ForemanClient();

test("getConfig applies the schema's defaults to a key an older daemon doesn't serve", async () => {
  // The worker is started separately from the daemon (`npm run foreman`), so a new worker
  // against a pre-triage daemon is an ordinary upgrade-window state. Parsing at the edge is
  // what turns that into the documented `shadow` default rather than an absent value that the
  // tier dispatch has to guess about.
  const cfg = await withDaemon(
    { enabled: true, mode: "live", repoAllowlist: ["/repo"], autoApproveAccess: true },
    () => client.getConfig(),
  );
  assert.equal(cfg.triage, "shadow");
  assert.equal(cfg.mode, "live");
  assert.equal(cfg.enabled, true);
});

test("getConfig rejects a triage value outside the enum instead of passing it through", async () => {
  // A value nobody can vouch for must not reach the tier dispatch. Throwing puts this on the
  // same footing as an unreachable daemon, which the worker already logs and retries - so
  // Foreman idles rather than running under a config it can't read.
  await assert.rejects(
    withDaemon({ enabled: true, mode: "live", triage: "sometimes" }, () => client.getConfig()),
  );
});

test("getConfig passes a valid config through unchanged", async () => {
  const cfg = await withDaemon(
    { enabled: true, mode: "live", repoAllowlist: ["/repo"], autoApproveAccess: false, triage: "on" },
    () => client.getConfig(),
  );
  assert.equal(cfg.triage, "on");
  assert.equal(cfg.autoApproveAccess, false);
  assert.deepEqual(cfg.repoAllowlist, ["/repo"]);
});

test("getConfig throws on a non-2xx, like every other read", async () => {
  await assert.rejects(withDaemon({}, () => client.getConfig(), false), /\/api\/foreman\/config -> 500/);
});

// ---- transcript: the other read whose bytes carry a safety property ----

test("transcript coerces an old daemon's string tools back into named calls", async () => {
  // `tools` was `string[]` before it carried inputs, and the worker is started separately from
  // the daemon - so this skew is an ordinary upgrade-window state, not a corrupt response. Left
  // as cast, those strings reach the denylist as `t.input ? … : t.name` with BOTH undefined, so
  // every call flattens to the literal "undefined": the tool names and the commands drop out of
  // the scan while prose still matches, and a `Bash(rm -rf …)` reads as clean. Coercing to
  // `{ name }` restores exactly what that daemon could ever say - the name - and nothing more.
  const w = await withDaemon(
    { messages: [{ id: "m1", role: "assistant", text: "cleaning up", tools: ["Bash", "Read"], ts: 1 }], truncated: false },
    () => client.transcript("s1"),
  );
  assert.deepEqual(w.messages[0]!.tools, [{ name: "Bash" }, { name: "Read" }]);
  assert.equal(w.messages[0]!.text, "cleaning up", "the rest of the turn is untouched");
});

test("transcript passes a current daemon's tool calls through with their inputs", async () => {
  const w = await withDaemon(
    {
      messages: [{ id: "m1", role: "assistant", text: "", tools: [{ name: "Bash", input: '{"command":"rm -rf /tmp/x"}' }], ts: 1 }],
      truncated: true,
      headCount: 0,
    },
    () => client.transcript("s1"),
  );
  assert.deepEqual(w.messages[0]!.tools, [{ name: "Bash", input: '{"command":"rm -rf /tmp/x"}' }]);
  assert.equal(w.truncated, true, "the window's own fields survive the normalization");
  assert.equal(w.headCount, 0);
});

test("transcript drops a tool entry it cannot read rather than carrying a half-formed call", async () => {
  // A nameless entry would scan as "undefined" just as a bare string does; an absent `tools`
  // would throw in `riskContextFrom`. Neither may become the permissive answer.
  const w = await withDaemon(
    {
      messages: [
        { id: "m1", role: "assistant", text: "a", tools: [{ input: '{"command":"ls"}' }, null, 7], ts: 1 },
        { id: "m2", role: "assistant", text: "b", ts: 2 },
      ],
      truncated: false,
    },
    () => client.transcript("s1"),
  );
  assert.deepEqual(w.messages[0]!.tools, []);
  assert.deepEqual(w.messages[1]!.tools, []);
});

test("transcript survives a response carrying no window at all", async () => {
  const w = await withDaemon({ unavailable: true, truncated: false }, () => client.transcript("s1"));
  assert.deepEqual(w.messages, []);
  assert.equal(w.unavailable, true);
});
