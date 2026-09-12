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
const { HARNESSES, sdkFor, foremanAutomationAuthorized } = await import(
  "../src/server/harness/index.ts"
);
type AgentType = import("../src/shared/types.ts").AgentType;
type Session = import("../src/shared/types.ts").Session;

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
    // Every shipped harness has a driver today, so this arm has nothing left to catch here
    // - and it stays, because it is the assertion that forces the capability to move with
    // the driver the day one is REMOVED as well as the day one lands.
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
  // being confused for one. A driverless harness has no driver primitive to reach, so if it
  // declares an interrupt at all the runtime list must be pane-only - an `"sdk"` here would
  // be a capability the fan-out routes to a supervisor that will never have a handle.
  //
  // NO shipped harness is driverless any more: pi was the last one, and its managed driver
  // gave it the second mechanism this rule used to forbid it. The rule is therefore stated
  // as an INVARIANT over the record rather than over a fixture that no longer exists - the
  // next harness to land driverless is caught by it on the day it lands, which is the only
  // day it matters.
  for (const agent of AGENT_TYPES) {
    if (sdkFor(agent) !== null) continue;
    const spec = capabilitiesFor(agent).interrupt;
    if (spec === null) continue; // A harness with no mechanism at all is still legal.
    assert.deepEqual(
      spec.runtimes,
      ["terminal"],
      `${agent}: has no driver, so a pane keystroke is the only interrupt it can offer`,
    );
  }
});

test("a driver and the sdk interrupt that reaches it land together", () => {
  // The other direction of the pair above, and the one with a fixture: every harness that
  // declares an sdk interrupt must have a handle whose `interrupt` is a real method. This is
  // what caught pi's declaration when it was written before the adapter existed.
  for (const agent of AGENT_TYPES) {
    const spec = capabilitiesFor(agent).interrupt;
    if (!spec?.runtimes.includes("sdk")) continue;
    assert.notEqual(sdkFor(agent), null, `${agent}: declares an sdk interrupt with no driver`);
    assert.equal(
      typeof sdkFor(agent)!.launch,
      "function",
      `${agent}: its driver must be able to produce the handle that performs the interrupt`,
    );
  }
});

test("Foreman may only automate an embedded session its driver can unblock", () => {
  // An embedded session is instrumented by construction, which is why this arm exists - but
  // being able to SEE a session is not the same as being able to answer it. A driver with no
  // way to surface its harness's questions hands Foreman a session that can stop somewhere
  // nobody can reach, and the queue then waits for ever with nobody told.
  //
  // Pi is the live fixture: its extension-UI bridge is Phase 2, so its driver declares
  // `answersRequests: false` and its managed sessions stay out of the queue even though its
  // harness now carries a `workQueue` spec.
  const sdkSession = (agent: AgentType) =>
    ({ agent, runtime: "sdk", hooksSeen: false }) as unknown as Session;

  for (const agent of AGENT_TYPES) {
    const driver = sdkFor(agent);
    if (!driver) continue;
    assert.equal(
      foremanAutomationAuthorized(sdkSession(agent)),
      driver.answersRequests && capabilitiesFor(agent).workQueue !== null,
      `${agent}: automation must follow the driver's own answer, not the runtime alone`,
    );
  }

  assert.equal(sdkFor("pi")!.answersRequests, true, "pi surfaces structured extension questions");
  assert.equal(foremanAutomationAuthorized(sdkSession("pi")), true);
  assert.equal(foremanAutomationAuthorized(sdkSession("claude")), true);
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
