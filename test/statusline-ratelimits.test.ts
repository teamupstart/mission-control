import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toBody } from "../hooks/statusline-body.mjs";
import { StatusLineIngestSchema } from "../src/shared/protocol.ts";

// What is at stake: the rate-limit meters are the only local view of a real subscription's
// limits - OpenTelemetry has no quota metric - and they are also the easiest thing here to
// render as a confident lie.
//
// `rate_limits` is absent for an API-key user and absent for a Pro/Max session until its
// first API response, so "we were not told" is the ORDINARY state, not an edge. If that
// arrives as a zeroed window the topbar shows two bars sitting at 0% and a person reads
// them as headroom they may not have. The two windows also arrive independently, so one
// present without the other must not blank the one we know.

const home = mkdtempSync(join(tmpdir(), "mission-statusline-rl-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const FIVE_HOUR = { used_percentage: 42.5, resets_at: 1_784_500_000 };
const SEVEN_DAY = { used_percentage: 83, resets_at: 1_785_000_000 };

/** `toBody`'s output as the daemon would actually receive it - through the real schema. */
function ingest(payload: Record<string, unknown>) {
  return StatusLineIngestSchema.parse(JSON.parse(JSON.stringify(toBody(payload, 1_000))));
}

test("toBody lifts both rate-limit windows", () => {
  const body = ingest({ session_id: "s", rate_limits: { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY } });
  assert.deepEqual(body.rateLimits, {
    fiveHour: { usedPercentage: 42.5, resetsAt: 1_784_500_000 },
    sevenDay: { usedPercentage: 83, resetsAt: 1_785_000_000 },
  });
});

test("an absent rate_limits drops out of the payload entirely", () => {
  // `undefined`, not a zeroed pair: this is every API-key user, on every render.
  assert.equal(toBody({ session_id: "s" }).rateLimits, undefined);
  assert.equal(ingest({ session_id: "s" }).rateLimits, undefined);
});

test("one window present without the other is tolerated", () => {
  const body = ingest({ session_id: "s", rate_limits: { five_hour: FIVE_HOUR } });
  assert.deepEqual(body.rateLimits?.fiveHour, { usedPercentage: 42.5, resetsAt: 1_784_500_000 });
  assert.equal(body.rateLimits?.sevenDay, null, "the window we were not told about is null");
});

test("cost is deliberately NOT taken from the statusLine payload", () => {
  // Claude's payload carries a cost block. OTel owns the dollars; taking them from here as
  // well is how two numbers end up on screen disagreeing about the same session.
  const body = toBody({ session_id: "s", cost: { total_cost_usd: 4.2, total_duration_ms: 900 } });
  assert.equal(JSON.stringify(body).includes("4.2"), false);
  assert.equal("cost" in body, false);
});

test("the registry holds the last reading, and a payload without windows never clears it", () => {
  const registry = new Registry();
  const env = { tmuxPane: "%1", weztermPane: undefined, termProgram: "WezTerm" };
  registry.applyStatusLine({
    ...ingest({ session_id: "sess-rl", rate_limits: { five_hour: FIVE_HOUR, seven_day: SEVEN_DAY } }),
    env,
  });
  const first = registry.snapshot().fleetCost;
  assert.equal(first?.rateLimits?.fiveHour?.usedPercentage, 42.5);

  // A second session on the same machine with no rate limits yet (its first render, before
  // any API response). Every other render would otherwise wipe a perfectly good reading and
  // the meters would strobe.
  registry.applyStatusLine({ ...ingest({ session_id: "sess-apikey" }), env });
  assert.equal(registry.snapshot().fleetCost?.rateLimits?.fiveHour?.usedPercentage, 42.5);

  // A payload carrying only the seven-day window keeps the five-hour one we already know.
  registry.applyStatusLine({
    ...ingest({ session_id: "sess-rl", rate_limits: { seven_day: { used_percentage: 91, resets_at: 9 } } }),
    env,
  });
  const rl = registry.snapshot().fleetCost?.rateLimits;
  assert.equal(rl?.fiveHour?.usedPercentage, 42.5, "held from the earlier reading");
  assert.equal(rl?.sevenDay?.usedPercentage, 91, "refreshed by this one");
});

test("rate limits are recorded even when no session can be bound", () => {
  // Account-global fact: a reading from a session we have not discovered is still the truth
  // about the subscription, so gating it on the pane bind would blank the meters for
  // exactly the sessions the binder is worst at.
  const registry = new Registry();
  assert.equal(registry.snapshot().fleetCost?.rateLimits, null);
  registry.applyStatusLine(
    ingest({ session_id: "nobody-here", rate_limits: { five_hour: FIVE_HOUR } }),
  );
  assert.equal(registry.snapshot().fleetCost?.rateLimits?.fiveHour?.usedPercentage, 42.5);
});
