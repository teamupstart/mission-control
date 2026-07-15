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
