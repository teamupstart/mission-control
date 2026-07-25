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

test("the capability record cannot have a hole in it", () => {
  // The `Record<AgentType, ...>` enforcement, proven at runtime as well as at compile time:
  // a new agent id added to AGENT_TYPES and nowhere else fails here even if someone reaches
  // for a cast to get past tsc.
  for (const agent of AGENT_TYPES) {
    assert.ok(HARNESS_CAPABILITIES[agent], `${agent} has no capability entry`);
    assert.ok(Array.isArray(HARNESS_CAPABILITIES[agent].runtimes), `${agent} runtimes missing`);
  }
});
