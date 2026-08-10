import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { KeepAwakeStatus } from "../src/shared/types.ts";
import {
  KEEP_AWAKE_COPY,
  KeepAwakeControl,
  KeepAwakePanel,
  keepAwakeTriggerName,
} from "../src/web/components/KeepAwakeControl.tsx";

/**
 * What is at stake: this control's whole contract is truthfulness about a power
 * assertion the operator cannot see. Every state has a REQUIRED visible sentence - the
 * word carries the mode because color alone must not - and the switch has exact moments
 * it must refuse input: while a transition is pending, while the host has no provider,
 * and while the SSE stream is down and any drawn state might be stale. Rendered
 * statically, state by state, because each row of the approved state table is a claim
 * about markup that a browser test would only sample.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

function mkStatus(over: Partial<KeepAwakeStatus> = {}): KeepAwakeStatus {
  return {
    supported: true,
    unavailableReason: null,
    state: "off",
    provider: "caffeinate",
    since: null,
    error: null,
    ...over,
  };
}

function renderTrigger(connected: boolean, status: KeepAwakeStatus | null): string {
  return renderToStaticMarkup(createElement(KeepAwakeControl, { connected, status }));
}

function renderPanel(over: {
  connected?: boolean;
  status?: KeepAwakeStatus | null;
  pending?: boolean;
  writeError?: string | null;
} = {}): string {
  return renderToStaticMarkup(
    createElement(KeepAwakePanel, {
      connected: over.connected ?? true,
      status: over.status === undefined ? mkStatus() : over.status,
      pending: over.pending ?? false,
      writeError: over.writeError ?? null,
      onToggle: () => {},
    }),
  );
}

// ---- the trigger ----

test("off: the segment reads live, is a dialog trigger, and carries a stateful name", () => {
  const html = renderTrigger(true, mkStatus());
  assert.match(html, />live</);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="Keep awake - off"/);
  assert.match(html, /class="pulse-seg pulse-link"/);
});

test("on: the label is `live · awake` - the word carries the mode, not the color", () => {
  const html = renderTrigger(true, mkStatus({ state: "on", since: 1 }));
  assert.match(html, />live · awake</);
  assert.match(html, /is-awake(?!-)/);
  assert.match(html, /aria-label="Keep awake - on"/);
});

test("failed: the label says so in words", () => {
  const html = renderTrigger(true, mkStatus({ state: "error", error: "exited unexpectedly" }));
  assert.match(html, />live · awake failed</);
  assert.match(html, /is-awake-failed/);
  assert.match(html, /aria-label="Keep awake - failed"/);
});

test("starting and stopping render as pending, never as the requested end state", () => {
  for (const state of ["starting", "stopping"] as const) {
    const html = renderTrigger(true, mkStatus({ state }));
    assert.match(html, />live</, `${state} must not claim awake`);
    assert.doesNotMatch(html, />live · awake</);
    assert.match(html, /is-awake-pending/);
    assert.match(html, /aria-label="Keep awake - switching"/);
  }
});

test("disconnected: reconnecting takes precedence over any awake claim", () => {
  // Even against a stale `on` (the reducer nulls the status on drop, but the trigger
  // must not depend on that): a down stream may not draw a live assertion.
  const html = renderTrigger(false, mkStatus({ state: "on", since: 1 }));
  assert.match(html, />reconnecting</);
  assert.doesNotMatch(html, />live · awake</);
  assert.doesNotMatch(html, /is-awake/);
  assert.match(html, /aria-label="Keep awake - Mission Control is reconnecting"/);
});

test("the trigger name covers the unknown and unavailable states too", () => {
  assert.equal(keepAwakeTriggerName(true, null), "Keep awake - state unknown");
  assert.equal(
    keepAwakeTriggerName(true, mkStatus({ supported: false })),
    "Keep awake - unavailable on this system",
  );
});

// ---- the dropdown ----

test("the dropdown always states the guarantee, the non-guarantees, and the lifecycle", () => {
  const html = renderPanel();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="Keep awake"/);
  for (const line of [
    KEEP_AWAKE_COPY.lock, // dim/lock allowed, idle sleep prevented
    KEEP_AWAKE_COPY.lid, // lid close and manual Sleep still work, battery cost
    KEEP_AWAKE_COPY.lifecycle, // on until Mission Control quits or restarts
  ]) {
    assert.ok(html.includes(line), `missing required copy: "${line}"`);
  }
});

test("off: a real switch, enabled, unchecked", () => {
  const html = renderPanel();
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="false"/);
  assert.doesNotMatch(html, /role="switch"[^>]*disabled/);
  assert.match(html, /data-state="off"/);
});

test("on: checked, and the panel says On", () => {
  const html = renderPanel({ status: mkStatus({ state: "on", since: 1 }) });
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /data-state="on"/);
  assert.match(html, />On</);
});

test("pending: the switch is disabled while a transition is in flight", () => {
  for (const status of [mkStatus({ state: "starting" }), mkStatus({ state: "stopping" })]) {
    const html = renderPanel({ status });
    assert.match(html, /role="switch"[^>]*disabled/, `${status.state} must disable the switch`);
  }
  // And while this window's own PUT is still settling, whatever the observed state says.
  assert.match(renderPanel({ pending: true }), /role="switch"[^>]*disabled/);
});

test("unavailable: the switch is disabled and the reason is shown, never an on state", () => {
  const html = renderPanel({
    status: mkStatus({
      supported: false,
      provider: null,
      unavailableReason: "Keep awake is unavailable on this system (linux)",
    }),
  });
  assert.match(html, /role="switch"[^>]*disabled/);
  assert.match(html, /unavailable on this system \(linux\)/);
  assert.match(html, /aria-checked="false"/);
});

test("reconnecting: the switch is disabled and the panel says why", () => {
  const html = renderPanel({ connected: false, status: null });
  assert.match(html, /role="switch"[^>]*disabled/);
  assert.ok(html.includes(KEEP_AWAKE_COPY.reconnecting));
  assert.match(html, /aria-checked="false"/, "a stale on must not survive the drop");
});

test("failed: the bounded error is printed and the switch stays live to retry", () => {
  const html = renderPanel({
    status: mkStatus({ state: "error", error: "the caffeinate process exited unexpectedly" }),
  });
  assert.match(html, /data-state="failed"/);
  assert.match(html, /exited unexpectedly/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /role="switch"[^>]*disabled/);
});

test("a write refusal surfaces inline without claiming a failed OS state", async () => {
  const html = renderPanel({ writeError: "HTTP 502" });
  assert.match(html, /HTTP 502/);
  assert.match(html, /data-state="off"/);
});
