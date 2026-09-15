import { test } from "node:test";
import assert from "node:assert/strict";
import { settingsGearDot, settingsRailDot } from "../src/web/lib/settings-dots.ts";
import type { SettingsStatus } from "../src/shared/types.ts";
import type {
  TelemetryProfileSummary,
  TelemetrySettingsSummary,
} from "../src/shared/telemetry.ts";

// What is at stake: the rail dots and the topbar gear are the only place a subsystem's live
// posture shows WITHOUT opening its panel, and the gear is meant to inherit the worst of
// them so "something needs you" is visible from the fleet. Two ways that goes quietly wrong:
// a category lighting the wrong tone (amber where it should be red is a merge nobody was
// warned about), and the gear ranking two live facts in the wrong order (a green "live" dot
// hiding a red "a source is failing"). Both are decided here, in one pure place the rail and
// gear share, so this pins the whole matrix rather than trusting each surface to agree.
//
// It also pins the "unknown" contract: a null status is the pre-snapshot state, and it must
// light nothing rather than a false all-clear - the same discipline the panels keep when the
// daemon has not answered yet.

/** A status tuple with every fact off, so a case flips exactly the one it is about. */
function status(over: Partial<SettingsStatus> = {}): SettingsStatus {
  return {
    inspector: { enabled: false, mode: "dry-run" },
    shipping: { autoMerge: false },
    taskSources: { failing: 0 },
    // Present by default so the tests that are about OTHER categories keep seeing the whole
    // rail; the ones about Conductor's conditional row override it.
    pipelines: { present: true, observing: 0 },
    ...over,
  };
}

const OFF = { foremanEnabled: false, trustBlindSpot: false, trustCheckExecution: false };

// ---- rail: which category lights, and in which tone ----

test("the Inspector dot is green only when it is enabled AND live", () => {
  const live = status({ inspector: { enabled: true, mode: "live" } });
  assert.equal(settingsRailDot("inspector", { status: live, ...OFF }), "live");
  // Enabled but only dry-run publishes nothing, so it is not "live".
  assert.equal(
    settingsRailDot("inspector", { status: status({ inspector: { enabled: true, mode: "dry-run" } }), ...OFF }),
    null,
  );
  // Live mode with the feature off publishes nothing either.
  assert.equal(
    settingsRailDot("inspector", { status: status({ inspector: { enabled: false, mode: "live" } }), ...OFF }),
    null,
  );
});

test("the Shipping dot is amber exactly when YOLO is armed", () => {
  assert.equal(settingsRailDot("shipping", { status: status({ shipping: { autoMerge: true } }), ...OFF }), "armed");
  assert.equal(settingsRailDot("shipping", { status: status(), ...OFF }), null);
});

test("the Task sources dot is red exactly when a source is failing", () => {
  assert.equal(settingsRailDot("task-sources", { status: status({ taskSources: { failing: 1 } }), ...OFF }), "failing");
  assert.equal(settingsRailDot("task-sources", { status: status({ taskSources: { failing: 0 } }), ...OFF }), null);
});

/** A telemetry summary with everything off, plus whatever the case under test moves. */
function telemetry(
  profiles: Partial<TelemetryProfileSummary>[] = [],
  over: Partial<TelemetrySettingsSummary> = {},
): TelemetrySettingsSummary {
  return {
    enabled: true,
    configRevision: 1,
    productEnrollment: "unavailable",
    usedBytes: 0,
    maxBytes: 1,
    gaps: 0,
    profiles: profiles.map((p, i) => ({
      profile: (["local", "user", "product"] as const)[i] ?? "local",
      capturing: false,
      exporting: false,
      paused: false,
      pausedReason: null,
      pending: 0,
      pendingBytes: 0,
      oldestPendingAgeMs: null,
      lastAcceptedAt: null,
      failing: false,
      ...p,
    })),
    ...over,
  };
}

test("the Telemetry dot is red when a destination stopped or is not getting through", () => {
  // A daemon-applied pause: nothing else in the app would ever mention this, which is the
  // whole reason the dot exists.
  const stopped = status({ telemetry: telemetry([{ capturing: true }, { pausedReason: "auth" }]) });
  assert.equal(settingsRailDot("telemetry", { status: stopped, ...OFF }), "failing");

  // A failed attempt with work still queued behind it is the same alarm by a different route.
  const behind = status({
    telemetry: telemetry([{}, { exporting: true, failing: true, pending: 3 }]),
  });
  assert.equal(settingsRailDot("telemetry", { status: behind, ...OFF }), "failing");

  // A failure with an EMPTY queue is not: the last attempt lost a race that has since drained,
  // and a permanent red over nothing left to send is a dot nobody would keep trusting.
  const drained = status({
    telemetry: telemetry([{}, { exporting: true, failing: true, pending: 0 }]),
  });
  assert.equal(settingsRailDot("telemetry", { status: drained, ...OFF }), "live");
});

test("the Telemetry dot is green when something is actually being exported", () => {
  const exporting = status({ telemetry: telemetry([{ capturing: true }, { exporting: true }]) });
  assert.equal(settingsRailDot("telemetry", { status: exporting, ...OFF }), "live");
});

test("local-only collection lights nothing, because it is a complete state", () => {
  // The dot's job is to say the panel is worth opening. Local-only is not a half-finished
  // setup, and nagging about it would be this surface arguing for its own feature.
  const local = status({ telemetry: telemetry([{ capturing: true }, {}, {}]) });
  assert.equal(settingsRailDot("telemetry", { status: local, ...OFF }), null);
  // Collection off, likewise.
  assert.equal(
    settingsRailDot("telemetry", { status: status({ telemetry: telemetry([], { enabled: false }) }), ...OFF }),
    null,
  );
});

test("a daemon that does not report telemetry lights nothing rather than an all-clear", () => {
  // The optional-field case, which is a rolling update rather than a hypothetical: a dashboard
  // talking to an older daemon knows nothing, and "nothing" is not "fine".
  assert.equal(settingsRailDot("telemetry", { status: status(), ...OFF }), null);
});

test("the Foreman dot rides App-owned state, not the status payload", () => {
  // Knowable even with a null status: Foreman is deliberately absent from the payload.
  assert.equal(settingsRailDot("foreman", { status: null, foremanEnabled: true, trustBlindSpot: false, trustCheckExecution: false }), "foreman");
  assert.equal(settingsRailDot("foreman", { status: null, foremanEnabled: false, trustBlindSpot: false, trustCheckExecution: false }), null);
  // And it does not read any status fact, so a busy status leaves it off when Foreman is off.
  assert.equal(
    settingsRailDot("foreman", { status: status({ taskSources: { failing: 3 } }), foremanEnabled: false, trustBlindSpot: false, trustCheckExecution: false }),
    null,
  );
});

test("the trust dot is amber only when armed AND there is a merge-without-review blind spot", () => {
  const armed = status({ shipping: { autoMerge: true } });
  assert.equal(settingsRailDot("trust", { status: armed, foremanEnabled: false, trustBlindSpot: true, trustCheckExecution: false }), "armed");
  // Armed with no blind spot, or a blind spot with YOLO disarmed, is not a trap.
  assert.equal(settingsRailDot("trust", { status: armed, foremanEnabled: false, trustBlindSpot: false, trustCheckExecution: false }), null);
  assert.equal(settingsRailDot("trust", { status: status(), foremanEnabled: false, trustBlindSpot: true, trustCheckExecution: false }), null);
});

// The trust panel's OTHER amber, summarized. Without this the rail claims less than the
// panel: an operator sitting on any other category gets no signal that a Check node may run
// branch-authored code, which is the heaviest thing any grant in the matrix permits.
test("the trust dot is amber when a workflow check may execute, independent of YOLO", () => {
  assert.equal(
    settingsRailDot("trust", { status: status(), ...OFF, trustCheckExecution: true }),
    "armed",
  );
  // Disarmed checks, or checks armed with no repository granted, is nothing to flag - the
  // caller collapses both to false, and this pins that the dot agrees.
  assert.equal(settingsRailDot("trust", { status: status(), ...OFF }), null);
});

test("armed check execution lights the trust dot even before the status snapshot lands", () => {
  // The fact comes off the Workflow config the page holds, not the SSE tuple, so a daemon
  // that has stopped answering must not silently retire the warning. A dot that went dark
  // here would read as "nothing armed" at exactly the moment nothing can be confirmed.
  assert.equal(
    settingsRailDot("trust", { status: null, ...OFF, trustCheckExecution: true }),
    "armed",
  );
});

test("a category with no rule, and any category before the snapshot, lights nothing", () => {
  // A category the dots say nothing about.
  assert.equal(settingsRailDot("display", { status: status({ shipping: { autoMerge: true } }), ...OFF }), null);
  // Null status is "unknown": the SSE-fed dots stay dark rather than claiming an all-clear.
  for (const id of ["inspector", "shipping", "task-sources", "trust"] as const) {
    assert.equal(settingsRailDot(id, { status: null, ...OFF }), null, `${id} should be dark on unknown status`);
  }
});

// ---- gear: the worst-of, ranked red > amber > green > none ----

test("the gear inherits the single worst status, ranked failing > armed > live", () => {
  // All three lit at once: red wins.
  const allLit = status({
    inspector: { enabled: true, mode: "live" },
    shipping: { autoMerge: true },
    taskSources: { failing: 1 },
  });
  assert.equal(settingsGearDot(allLit), "failing");
  // Armed over live when nothing is failing.
  assert.equal(
    settingsGearDot(status({ inspector: { enabled: true, mode: "live" }, shipping: { autoMerge: true } })),
    "armed",
  );
  // Live alone when nothing worse is present.
  assert.equal(settingsGearDot(status({ inspector: { enabled: true, mode: "live" } })), "live");
  // Nothing lit is no dot, not a green all-clear.
  assert.equal(settingsGearDot(status()), null);
});

test("the gear ranks only status facts - Foreman's purple never reaches it", () => {
  // There is no Foreman input to `settingsGearDot` at all: it is a rail affordance, not an
  // alarm. A tuple with nothing armed yields no gear dot however Foreman is set elsewhere.
  assert.equal(settingsGearDot(status()), null);
});

test("an unknown status renders no gear dot", () => {
  assert.equal(settingsGearDot(null), null);
});
