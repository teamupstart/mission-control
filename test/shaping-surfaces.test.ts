import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeatureFlagsConfig } from "../src/shared/feature-flags.ts";
import { currentShaping, shapingView, taskShapingRead, withCurrentShaping, type TaskShaping } from "../src/shared/shaping.ts";
import type { Session, TaskSummary } from "../src/shared/types.ts";
import { FeatureFlagsContext } from "../src/web/useFeatureFlag.ts";
import { ShapingChip, ShapingRailMark, ShapingTileFlag } from "../src/web/components/ShapingChip.tsx";
import { mkSession } from "./helpers/session-fixture.ts";

// The reader rule and the session surfaces that apply it: the chip's two states, the board and
// rail markers, and nothing at all for a record that names another session or with the flag off.

const on: FeatureFlagsConfig = { enableAll: false, overrides: { "task-shaping": true } };
const off: FeatureFlagsConfig = { enableAll: false, overrides: {} };

function record(sessionId: string, state: TaskShaping["state"], entries = 2): TaskShaping {
  return {
    state, at: 1, sessionId, durationMs: 40, entries, bytes: 120, truncated: false,
    shapers: [{
      id: "acme", label: "Acme guidance", stage: "select", origin: "registered", sha256: null,
      outcome: state === "ok" ? "ok" : "timed_out", reason: state === "ok" ? null : "Timed out after 5 s.",
      durationMs: 40, entries, bytes: 120, truncated: false, redacted: false, version: "v1.4.0",
    }],
  };
}

function session(shaping: TaskShaping | undefined, id = "s1"): Session {
  return mkSession({ id, task: { id: "t1", title: "Task", ...(shaping ? { shaping } : {}) } as unknown as TaskSummary });
}

function render(flags: FeatureFlagsConfig, element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(FeatureFlagsContext.Provider, { value: flags }, element));
}

test("currentShaping shows a record only while it names the task's current session", () => {
  assert.deepEqual(currentShaping({ shaping: record("s1", "ok"), sessionId: "s1" }), record("s1", "ok"));
  assert.equal(currentShaping({ shaping: record("s0", "degraded"), sessionId: "s1" }), null, "an earlier launch's record");
  assert.equal(currentShaping({ shaping: record("s1", "ok"), sessionId: null }), null, "no current session");
  assert.equal(currentShaping({ shaping: { ...record("s1", "ok"), sessionId: undefined }, sessionId: "s1" }), null, "an unstamped record");
  assert.equal(currentShaping({ shaping: null, sessionId: "s1" }), null);
});

test("shapingView reports shaping while the mark is set, and the current record otherwise", () => {
  assert.deepEqual(shapingView({ sessionId: null, shapingContext: { startedAt: 7 } }), { state: "shaping", startedAt: 7 });
  // The wait wins over an earlier launch's record, which is what the launch in progress replaces.
  assert.equal(shapingView({ sessionId: "s1", shaping: record("s1", "ok"), shapingContext: { startedAt: 7 } })?.state, "shaping");
  assert.deepEqual(shapingView({ sessionId: "s1", shaping: record("s1", "degraded") }), record("s1", "degraded"));
  assert.equal(shapingView({ sessionId: "s1", shaping: record("s0", "degraded") }), null, "never another session's record");
  assert.equal(shapingView({ sessionId: "s1", shapingContext: null }), null);
  for (const view of [shapingView({ sessionId: null, shapingContext: { startedAt: 1 } }), record("s1", "ok"), record("s1", "degraded")]) {
    assert.ok(["shaping", "ok", "degraded"].includes(view!.state));
  }
});

test("task reads drop a record that names another session and keep the current one", () => {
  const stale = withCurrentShaping({ id: "t", sessionId: "s1", shaping: record("s0", "degraded") });
  assert.equal("shaping" in stale, false);
  const kept = withCurrentShaping({ id: "t", sessionId: "s1", shaping: record("s1", "ok") });
  assert.deepEqual(kept.shaping, record("s1", "ok"));
  const plain = { id: "t", sessionId: "s1" };
  assert.equal(withCurrentShaping(plain), plain, "an unshaped task is returned untouched");
  assert.deepEqual(taskShapingRead({ sessionId: "s1", shaping: record("s1", "degraded") }), {
    state: "degraded", sessionId: "s1", summary: "degraded: acme timed out; 2 entries",
  });
  assert.equal(taskShapingRead({ sessionId: "s1", shaping: record("s0", "degraded") }), null);
});

test("the chip reads Context: N entries, or an amber Context degraded", () => {
  const ok = render(on, createElement(ShapingChip, { session: session(record("s1", "ok")) }));
  assert.match(ok, />Context: 2 entries</);
  assert.doesNotMatch(ok, /is-degraded/);
  const one = render(on, createElement(ShapingChip, { session: session(record("s1", "ok", 1)) }));
  assert.match(one, />Context: 1 entry</);
  const degraded = render(on, createElement(ShapingChip, { session: session(record("s1", "degraded")) }));
  assert.match(degraded, />Context degraded</);
  assert.match(degraded, /task-context-chip is-degraded/);
  assert.match(degraded, /Timed out after 5 s\./, "the reason is in its tooltip");
});

test("a record that names another session renders no chip, no tile marker and no rail marker", () => {
  const other = session(record("s0", "degraded"), "s1");
  assert.equal(render(on, createElement(ShapingChip, { session: other })), "");
  assert.equal(render(on, createElement(ShapingTileFlag, { session: other })), "");
  assert.equal(render(on, createElement(ShapingRailMark, { session: other })), "");
});

test("the board and rail markers appear only for this session's degraded launch", () => {
  const degraded = session(record("s1", "degraded"));
  assert.match(render(on, createElement(ShapingTileFlag, { session: degraded })), /tile-flag tf-shaping[^>]*>context degraded</);
  assert.match(render(on, createElement(ShapingRailMark, { session: degraded })), /aria-label="Context degraded"/);
  const ok = session(record("s1", "ok"));
  assert.equal(render(on, createElement(ShapingTileFlag, { session: ok })), "");
  assert.equal(render(on, createElement(ShapingRailMark, { session: ok })), "");
  assert.equal(render(on, createElement(ShapingTileFlag, { session: session(undefined) })), "");
});

test("with the flag off nothing renders, whatever the record says", () => {
  const degraded = session(record("s1", "degraded"));
  for (const component of [ShapingChip, ShapingTileFlag, ShapingRailMark]) {
    assert.equal(render(off, createElement(component, { session: degraded })), "");
  }
});
