import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: `runtimes` (pure, browser-readable) and `Harness.sdk` (server-side,
// holds the driver) are ONE FACT written in two files, and the two failures are opposite
// and both silent.
//
// A capability that advertises `"sdk"` with no driver behind it draws a toggle an operator
// can switch on, after which dispatch resolves a runtime nothing can launch. A driver
// shipped without the capability is a feature nobody can reach: no toggle renders, the
// panel says the harness does not offer it, and the adapter is dead code that looks live.
// This is the `GOAL_UNSUPPORTED` treatment - the same reason `harness-transcript.test.ts`
// exists - applied to the runtime axis.

const home = mkdtempSync(join(tmpdir(), "harness-sdk-"));
// Set before importing anything that resolves the state dir: the harness registry reaches
// specs that read config paths.
process.env.HARNESS_HOME = join(home, "state");

const { AGENT_TYPES } = await import("../src/shared/types.ts");
const { HARNESS_CAPABILITIES, capabilitiesFor } = await import(
  "../src/shared/harness-capabilities.ts"
);
const { HARNESSES, sdkFor } = await import("../src/server/harness/index.ts");

after(() => rmSync(home, { recursive: true, force: true }));

test("every harness declares its runtimes, and terminal is always one of them", () => {
  for (const agent of AGENT_TYPES) {
    const runtimes = capabilitiesFor(agent).runtimes;
    assert.ok(runtimes.length > 0, `${agent} declares no runtime at all`);
    // A harness we cannot type at is not a harness - the same reason `ControlSpec` is not
    // nullable. Every shipped agent is reachable in a terminal, whatever else it offers.
    assert.ok(runtimes.includes("terminal"), `${agent} must declare the terminal runtime`);
  }
});

test("declaring the sdk runtime and having a driver are the same fact", () => {
  for (const agent of AGENT_TYPES) {
    assert.equal(
      capabilitiesFor(agent).runtimes.includes("sdk"),
      HARNESSES[agent].sdk !== null,
      `${agent}: runtimes and Harness.sdk disagree about whether a driver exists`,
    );
  }
});

test("sdkFor is the accessor, and reports the same absence the capability does", () => {
  for (const agent of AGENT_TYPES) {
    assert.equal(sdkFor(agent), HARNESSES[agent].sdk);
    // Phase 1 ships the seam and no driver, so this is the state of the world today. When a
    // phase lands one, this assertion is what forces the capability to move with it.
    if (sdkFor(agent) === null) {
      assert.equal(capabilitiesFor(agent).runtimes.includes("sdk"), false);
    }
  }
});

test("an interruptible sdk runtime is the same fact as the driver that performs it", () => {
  // The third one-fact-two-files pair on this axis, and the failure it guards is the one
  // the operator feels: a capability that says a session can be stopped over the Agent SDK
  // while `HARNESSES[a].sdk` is null draws a live control whose route can only ever answer
  // "this session has no live embedded driver". The interrupt IS the driver's own primitive
  // (`SdkSessionHandle.interrupt`), so the declaration cannot outrun it.
  for (const agent of AGENT_TYPES) {
    if (!capabilitiesFor(agent).interrupt?.runtimes.includes("sdk")) continue;
    assert.notEqual(
      HARNESSES[agent].sdk,
      null,
      `${agent}: declares its sdk turn interruptible with no driver to interrupt`,
    );
    assert.ok(
      capabilitiesFor(agent).runtimes.includes("sdk"),
      `${agent}: declares an sdk interrupt on a runtime it does not offer`,
    );
  }
});

test("a harness with no driver is interruptible only in its pane", () => {
  // The complement of the test above, and the pair is what keeps the two mechanisms from
  // being confused for one. A driverless harness has no `query.interrupt()` to reach, so if
  // it declares an interrupt at all the runtime list must be pane-only - an `"sdk"` here
  // would be a capability the fan-out routes to a supervisor that will never have a handle.
  //
  // This is also where `interrupt` left `harness-capabilities.test.ts`'s `BY_FIXTURE` list:
  // pi used to exercise the slot's null for real, and `escape` gave it the one mechanism it
  // can ever have.
  const driverless = AGENT_TYPES.filter((agent) => sdkFor(agent) === null);
  assert.ok(driverless.length > 0, "no harness exercises the driverless path any more");
  for (const agent of driverless) {
    const spec = capabilitiesFor(agent).interrupt;
    if (spec === null) continue; // A harness with no mechanism at all is still legal.
    assert.deepEqual(
      spec.runtimes,
      ["terminal"],
      `${agent}: has no driver, so a pane keystroke is the only interrupt it can offer`,
    );
  }
});

test("the capability record cannot have a hole in it", () => {
  // The `Record<AgentType, ...>` enforcement, proven at runtime as well as at compile time:
  // a new agent id added to AGENT_TYPES and nowhere else fails here even if someone reaches
  // for a cast to get past tsc.
  for (const agent of AGENT_TYPES) {
    assert.ok(HARNESS_CAPABILITIES[agent], `${agent} has no capability entry`);
    assert.ok(Array.isArray(HARNESS_CAPABILITIES[agent].runtimes), `${agent} runtimes missing`);
  }
});
