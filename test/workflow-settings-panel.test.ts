/**
 * What is at stake: the one switch in this app that can type into somebody's live agent
 * session used to live in a floating drawer on another page - no rail row, no scope badge,
 * no deep link, and invisible to settings search. Moving it into a category is only worth
 * anything if the controls came WITH it, so this pins that the panel actually draws Live
 * delivery, its allowlist, the retention fields and the health counters, each on the anchor
 * the search index points at.
 *
 * Two further claims are pinned here because a static render cannot reach them and getting
 * either wrong is silent. The pre-poll panel must say the daemon has not answered rather
 * than present "off, no repos" as fact - the Inspector panel's rule, and the same failure:
 * an operator reads a safe posture that may not be in force. And the retention gate has to
 * ask before SHORTENING a limit, because the next sweep acts on it and compaction is not
 * reversible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WorkflowSettingsPanel,
  readRetention,
  retentionShortens,
} from "../src/web/components/WorkflowSettingsPanel.tsx";
import type { WorkflowSettingsState } from "../src/web/useWorkflowSettings.ts";
import { DEFAULT_WORKFLOW_CONFIG, type WorkflowStatus } from "../src/shared/workflow.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

const STATUS: WorkflowStatus = {
  activeRuns: 2,
  queuedPersonaCalls: 1,
  runningPersonaCalls: 0,
  waitingDeliveries: 3,
  uncertainDeliveries: 1,
  inspectorGates: 0,
  lastRecoveryAt: null,
  lastRetentionAt: null,
  lastRetentionError: null,
  retainedRunCount: 42,
  lastRetentionCompacted: 0,
  lastRetentionDeleted: 0,
};

function state(over: Partial<WorkflowSettingsState> = {}): WorkflowSettingsState {
  return {
    config: null,
    status: null,
    update: async () => true,
    error: null,
    ...over,
  };
}

function render(over: Partial<WorkflowSettingsState> = {}): string {
  return renderToStaticMarkup(
    withOverlayHost(createElement(WorkflowSettingsPanel, { state: state(over) })),
  );
}

const ANSWERED = {
  config: { ...DEFAULT_WORKFLOW_CONFIG, repoAllowlist: ["/src/mission-control"] },
  status: STATUS,
};

test("every control the search index points at is on the panel", () => {
  const html = render(ANSWERED);
  for (const anchor of [
    "workflows/live-delivery",
    "workflows/allowlist",
    "workflows/retention",
    "workflows/health",
  ]) {
    assert.ok(html.includes(`data-anchor="${anchor}"`), `panel is missing ${anchor}`);
  }
});

// The anchors have to survive the pre-poll render too: `settings-sidebar-render.test.ts`
// walks a statically rendered page, and a control that only appears once a fetch lands is
// one a deep link from search cannot scroll to on arrival.
test("the anchors are drawn before the daemon has answered", () => {
  const html = render();
  for (const anchor of [
    "workflows/live-delivery",
    "workflows/allowlist",
    "workflows/retention",
    "workflows/health",
  ]) {
    assert.ok(html.includes(`data-anchor="${anchor}"`), `pre-poll panel is missing ${anchor}`);
  }
});

test("the Live delivery switch is a toggle row, off and disabled before the first read", () => {
  const html = render();
  const row = /<label class="alert-row wf-settings-live"[^>]*data-anchor="workflows\/live-delivery"[^>]*>(.*?)<\/label>/s
    .exec(html);
  assert.ok(row, "Live delivery should be an app toggle row, not a bare checkbox");
  assert.match(row[1]!, /type="checkbox"/);
  assert.doesNotMatch(row[1]!, /checked/, "pre-poll must not draw Live as enabled");
  assert.match(row[1]!, /disabled/, "pre-poll must not accept a click it cannot honour");
  assert.match(html, /Enable Live workflow delivery/);
});

test("with no answer from the daemon the panel says so rather than showing defaults as fact", () => {
  const html = render();
  assert.match(html, /wf-settings-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(
    html,
    /No repositories yet - Live delivery has nowhere to send/,
    "an unanswered panel must not assert an empty allowlist",
  );
  assert.match(
    html,
    /Workflow health is unavailable/,
    "an unanswered panel must not draw health counters it does not have",
  );
});

test("an answered panel lists the allowlist and the health counters", () => {
  const html = render(ANSWERED);
  assert.doesNotMatch(html, /wf-settings-unknown/);
  assert.match(html, /<code>\/src\/mission-control<\/code>/);
  assert.match(html, /Remove<\/button>/);
  // The counters come from the status payload, not from a placeholder.
  assert.match(html, /Retained runs<\/dt><dd>42<\/dd>/);
  assert.match(html, /Waiting deliveries<\/dt><dd>3<\/dd>/);
  assert.match(html, /Uncertain deliveries<\/dt><dd>1<\/dd>/);
});

test("an empty allowlist says Live delivery has nowhere to send", () => {
  const html = render({ config: DEFAULT_WORKFLOW_CONFIG, status: STATUS });
  assert.match(html, /No repositories yet - Live delivery has nowhere to send/);
});

// The consent sentence is part of the feature, not decoration: it is what an operator reads
// before allowing a paste into a session they may be watching.
test("Live enabled flies the sentence saying what it does", () => {
  const off = render(ANSWERED);
  assert.doesNotMatch(off, /wf-settings-live-warn/, "an off switch must not fly the warning");
  const on = render({
    config: { ...ANSWERED.config, liveEnabled: true },
    status: STATUS,
  });
  assert.match(on, /wf-settings-live-warn/);
  // The apostrophe arrives HTML-escaped, so the phrase is matched around it.
  assert.match(on, /A repair packet is typed into the agent.{0,8}s own composer/);
});

// The retention boxes are typed text, so the read has to refuse a half-entered number
// rather than PUT a NaN. The ranges restated in the panel are the daemon's own.
test("retention refuses values outside the ranges the daemon enforces", () => {
  const ok = readRetention({
    rawEvidenceDays: "30",
    completedRunDays: "180",
    maxCompletedRuns: "1000",
  });
  assert.deepEqual(ok, {
    ok: true,
    value: { rawEvidenceDays: 30, completedRunDays: 180, maxCompletedRuns: 1_000 },
  });
  for (const bad of [
    { rawEvidenceDays: "0", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "366", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "30", completedRunDays: "29", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "30", completedRunDays: "180", maxCompletedRuns: "99" },
    { rawEvidenceDays: "30.5", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "thirty", completedRunDays: "180", maxCompletedRuns: "1000" },
  ]) {
    const read = readRetention(bad);
    assert.equal(read.ok, false, `${JSON.stringify(bad)} should be refused`);
    // A sentence naming the field and its range, not a bare "invalid".
    if (!read.ok) assert.match(read.error, /between \d+ and [\d,]+/);
  }
});

// Only a SHORTENING needs the confirm: the next sweep can then compact or delete history
// today's limits would have kept, and neither is reversible. Lengthening one, or leaving
// them alone, must save without a dialog - a confirm on every Apply is one nobody reads.
test("only a shortened limit asks first", () => {
  const current = DEFAULT_WORKFLOW_CONFIG.retention;
  assert.equal(retentionShortens(current, current), false);
  assert.equal(
    retentionShortens({ ...current, rawEvidenceDays: current.rawEvidenceDays + 1 }, current),
    false,
  );
  for (const key of ["rawEvidenceDays", "completedRunDays", "maxCompletedRuns"] as const) {
    assert.equal(
      retentionShortens({ ...current, [key]: current[key] - 1 }, current),
      true,
      `a shorter ${key} should ask`,
    );
  }
});

test("a write refused by the daemon is reported, not swallowed", () => {
  const html = render({ ...ANSWERED, error: "Workflow manager unavailable" });
  assert.match(html, /class="settings-error" role="alert">Workflow manager unavailable/);
});
