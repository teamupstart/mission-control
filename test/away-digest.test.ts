import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "../src/server/away/digest.ts";
import { closeBuffer, emptyBuffer, foldAlerts, mergeBuffers } from "../src/shared/away-buffer.ts";
import type { Alert } from "../src/shared/alerts.ts";

// The digest's two tiers. Only the deterministic one is exercised here
// (`narrative: false`): the model tier spawns a real `claude -p`, which a unit test
// must never do. What matters at this level is that the cheap tier is always
// complete on its own, because it is what the model tier falls back to.

function mkAlert(over: Partial<Alert> = {}): Alert {
  return {
    id: "idle:a",
    kind: "idle",
    title: "auth went idle",
    body: "idle",
    sessionId: "a",
    severity: "info",
    ...over,
  };
}

const NO_MODEL = { narrative: false as const };

test("a quiet away window produces an EMPTY digest - returning to '0 finished' says nothing", async () => {
  const d = await buildDigest(emptyBuffer(0), 1000, NO_MODEL);
  assert.equal(d.empty, true);
  assert.equal(d.rollup, "");
  assert.deepEqual(d.lines, []);
});

test("the deterministic tier is complete on its own", async () => {
  const buf = foldAlerts(
    emptyBuffer(0),
    [
      mkAlert({ id: "idle:a", title: "auth went idle" }),
      mkAlert({ id: "idle:b", title: "docs went idle" }),
      mkAlert({ id: "stuck:c:silent-working", kind: "stuck", title: "api looks stuck", body: "silent for 12m" }),
    ],
    500,
  );
  const d = await buildDigest(buf, 1000, NO_MODEL);
  assert.equal(d.empty, false);
  assert.equal(d.rollup, "1 stuck · 2 finished");
  assert.equal(d.lines.length, 3);
  // Stuck leads, so the digest can't bury the thing that needs you.
  assert.match(d.lines[0]!, /api looks stuck/);
  assert.equal(d.narrative, null);
});

test("the digest carries the window it covers", async () => {
  const buf = foldAlerts(emptyBuffer(42), [mkAlert()], 100);
  const d = await buildDigest(buf, 9000, NO_MODEL);
  assert.equal(d.since, 42);
  assert.equal(d.until, 9000);
});

test("a merged digest reports the time you were AWAY, not the span it covers", async () => {
  // Away 10:00-10:10, back at the desk for the next fifty minutes, away again
  // 11:00-11:10. The card must say 20 minutes, not 70.
  const MIN = 60_000;
  const first = closeBuffer(foldAlerts(emptyBuffer(0), [mkAlert({ id: "idle:a" })], MIN), 10 * MIN);
  const second = closeBuffer(
    foldAlerts(emptyBuffer(60 * MIN), [mkAlert({ id: "idle:b" })], 61 * MIN),
    70 * MIN,
  );
  const d = await buildDigest(mergeBuffers(first, second), 70 * MIN, NO_MODEL);
  assert.equal(d.awayMs, 20 * MIN);
  assert.equal(d.since, 0); // the events still date from the first window
});

test("a single window's away time is what it covered, not how late the digest was read", async () => {
  // The digest is read after you are back - sometimes much later, if no dashboard was
  // open to claim it - and the walk back to your chair is not time you were away.
  const buf = closeBuffer(foldAlerts(emptyBuffer(0), [mkAlert()], 100), 600_000);
  const d = await buildDigest(buf, 3_600_000, NO_MODEL);
  assert.equal(d.awayMs, 600_000);
});

test("an open window is still measured to now, so it has an honest span before closing", async () => {
  const buf = foldAlerts(emptyBuffer(0), [mkAlert()], 100);
  const d = await buildDigest(buf, 300_000, NO_MODEL);
  assert.equal(d.awayMs, 300_000);
});

test("an empty buffer never reaches the model at all", async () => {
  // buildDigest returns before narrate() when there is nothing to summarise, so a
  // quiet away window costs zero tokens. Asserted by leaving the model ENABLED and
  // requiring the call to return promptly with narrative null.
  const started = Date.now();
  const d = await buildDigest(emptyBuffer(0), 1000);
  assert.equal(d.empty, true);
  assert.equal(d.narrative, null);
  assert.ok(Date.now() - started < 2000, "should not have spawned a model call");
});
